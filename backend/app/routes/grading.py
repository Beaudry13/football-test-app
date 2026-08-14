"""Manual grading, coach feedback, and results dashboards.

Registered under /api directly (not /api/quizzes) because it also exposes
cross-quiz endpoints like per-player history.

Every read here that lists/counts "responses" filters to
PlayerAttempt.status == SUBMITTED - an in-progress attempt is not a
response yet, and showing one here (with no answers, or answers a player
is still actively changing) would corrupt the dashboard stats, the
missing-players list, exports, and player history. `grade_answer` is the
one deliberate exception: grading an in-progress attempt's answer is
inert (it's not visible anywhere until the attempt is actually submitted),
so it isn't gated - a documented choice, not an oversight.
"""

from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import contains_eager, selectinload

from app.errors import ApiError
from app.extensions import db
from app.services.attempt_scope import official_filter, official_only
from app.services.scoring import count_answers, pending_grading_count
from app.models import AccessCode, Answer, AttemptStatus, GradeAuditLog, Group, PlayerAttempt, Question, Quiz
from app.schemas.grading import GradeAnswerSchema
from app.services.access_codes import effective_roster_names_for_quiz
from app.services.export import (
    build_detailed_results_pdf,
    build_results_csv,
    build_results_pdf,
    export_filename_slug,
)
from app.services.file_storage import get_file_storage
from app.utils.auth import current_coach, get_editable_quiz, get_visible_quiz
from app.utils.validation import load_json_body

grading_bp = Blueprint("grading", __name__)


def _get_gradable_answer(answer_id: int) -> Answer:
    """An answer the caller may grade.

    Scoped to the organization first (a 404 for anyone outside it), then
    delegated to `get_editable_quiz`: viewing a teammate's results is fine,
    but recording a grade against their quiz is an edit.
    """
    coach = current_coach()
    answer = (
        Answer.query.join(PlayerAttempt)
        .filter(official_filter())
        .join(Quiz)
        .filter(Answer.id == answer_id, Quiz.organization_id == coach.organization_id)
        .first()
    )
    if answer is None:
        raise ApiError("Answer not found", status_code=404)
    get_editable_quiz(answer.attempt.quiz_id)
    return answer


@grading_bp.get("/quizzes/<int:quiz_id>/responses")
@jwt_required()
def list_responses(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    responses = (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        # player eager-loaded alongside answers - display_name resolves it
        # for every row below, and this is the one place that would
        # otherwise turn into an N+1 (one lazy load per canonical attempt).
        .options(selectinload(PlayerAttempt.answers), selectinload(PlayerAttempt.player))
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )
    return jsonify([r.to_dict(include_answers=True) for r in responses])


@grading_bp.get("/quizzes/<int:quiz_id>/responses/<int:response_id>")
@jwt_required()
def get_response(quiz_id: int, response_id: int):
    quiz = get_visible_quiz(quiz_id)
    response = (
        official_only(PlayerAttempt.query)
        .filter_by(
            id=response_id, quiz_id=quiz.id, status=AttemptStatus.SUBMITTED
        )
        .options(selectinload(PlayerAttempt.answers), selectinload(PlayerAttempt.player))
        .first()
    )
    if response is None:
        raise ApiError("Response not found", status_code=404)
    return jsonify(response.to_dict(include_answers=True))


@grading_bp.delete("/quizzes/<int:quiz_id>/attempts/<int:attempt_id>")
@jwt_required()
def reset_attempt(quiz_id: int, attempt_id: int):
    """Coach-triggered manual reset: deletes the attempt outright (cascades
    to its answers) so the player can start fresh next time they enter
    their name. Full delete, not a soft/archived reset - there's no
    requirement to preserve a discarded attempt's record, and this is
    framed as fixing an accidental early submit, not an audit feature.
    Any prior grading/feedback on it is gone, not archived.
    """
    quiz = get_editable_quiz(quiz_id)
    # Scoped by both ids, not just attempt_id - get_editable_quiz only
    # proves the coach controls this quiz, not that the attempt belongs to
    # it. Matches how get_response already scopes its lookup.
    attempt = PlayerAttempt.query.filter_by(id=attempt_id, quiz_id=quiz.id).first()
    if attempt is None:
        raise ApiError("Attempt not found", status_code=404)

    db.session.delete(attempt)
    db.session.commit()
    return "", 204


@grading_bp.patch("/answers/<int:answer_id>/grade")
@jwt_required()
def grade_answer(answer_id: int):
    answer = _get_gradable_answer(answer_id)
    data = load_json_body(GradeAnswerSchema())
    coach = current_coach()

    previous_is_correct = answer.is_correct
    previous_coach_feedback = answer.coach_feedback

    answer.is_correct = data["is_correct"]
    if data["coach_feedback"] is not None:
        answer.coach_feedback = data["coach_feedback"]
    answer.graded_at = datetime.now(timezone.utc)
    answer.graded_by_coach_id = coach.id

    # Unconditional, even when nothing actually changed - a coach
    # re-confirming an existing grade is still a meaningful "who touched
    # this last" event, and skipping no-ops would mean the audit trail
    # can't answer "did anyone look at this again after the first grade."
    db.session.add(
        GradeAuditLog(
            answer_id=answer.id,
            coach_id=coach.id,
            previous_is_correct=previous_is_correct,
            previous_coach_feedback=previous_coach_feedback,
            new_is_correct=answer.is_correct,
            new_coach_feedback=answer.coach_feedback,
        )
    )

    db.session.commit()
    return jsonify(answer.to_dict())


def _build_dashboard_data(quiz: Quiz, responses: list[PlayerAttempt]) -> dict:
    # Group-aware, same as the quiz-card analytics in list_quizzes: if the
    # quiz's currently active code is restricted to group(s), that's who's
    # actually eligible to submit, not the quiz's own Roster - see
    # effective_roster_names_for_quiz.
    active_code = (
        AccessCode.query.filter(
            AccessCode.quiz_id == quiz.id,
            AccessCode.is_active.is_(True),
            AccessCode.expires_at > datetime.now(timezone.utc),
        )
        .options(selectinload(AccessCode.groups).selectinload(Group.players))
        .first()
    )
    roster_names = effective_roster_names_for_quiz(quiz, active_code)
    roster_size = len(roster_names)
    response_count = len(responses)
    response_rate = (response_count / roster_size) if roster_size else 0.0

    # Same effective roster this function already uses for
    # roster_size/response_rate above - reflects whichever code is
    # currently active, group-restricted or not. Still staleness-tolerant
    # in the sense that a coach editing group membership after players have
    # already started won't retroactively change who's "missing" for
    # attempts already in progress - just like before groups existed.
    responded_names = {r.player_name for r in responses}
    missing_players = [name for name in roster_names if name not in responded_names]

    question_breakdown = []
    for question in sorted(quiz.questions, key=lambda q: q.position):
        answers = [a for r in responses for a in r.answers if a.question_id == question.id]
        # Grouped by QUESTION rather than by attempt, but the same three
        # counts and the same rule - so it comes from the same counter. A
        # question nobody answered has no rows and every count is zero;
        # `answered_count` is how this surface expresses that, not an
        # unanswered figure (which counting answer rows cannot produce).
        counts = count_answers(answers)

        question_breakdown.append(
            {
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "answered_count": len(answers),
                "correct_count": counts.correct,
                "incorrect_count": counts.incorrect,
                "ungraded_count": counts.not_graded,
            }
        )

    return {
        "quiz_id": quiz.id,
        "roster_size": roster_size,
        "response_count": response_count,
        "response_rate": round(response_rate, 4),
        "missing_players": missing_players,
        "question_breakdown": question_breakdown,
    }


def _load_responses_for_export(quiz: Quiz) -> list[PlayerAttempt]:
    # Filtered here (not just trusted to callers) since export.py's CSV/PDF
    # builders call .submitted_at.isoformat() unconditionally - submitted_at
    # is nullable now, so an in-progress attempt reaching either builder
    # would crash rather than just look wrong.
    return (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .options(
            selectinload(PlayerAttempt.answers).selectinload(Answer.selected_option),
            selectinload(PlayerAttempt.player),
        )
        .all()
    )


@grading_bp.get("/quizzes/<int:quiz_id>/dashboard")
@jwt_required()
def quiz_dashboard(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    responses = (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .options(selectinload(PlayerAttempt.answers))
        .all()
    )
    return jsonify(_build_dashboard_data(quiz, responses))


@grading_bp.get("/quizzes/<int:quiz_id>/export.csv")
@jwt_required()
def export_results_csv(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    responses = _load_responses_for_export(quiz)
    csv_text = build_results_csv(quiz, responses)
    slug = export_filename_slug(quiz.title)
    return Response(
        csv_text,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{slug}-results.csv"'},
    )


@grading_bp.get("/quizzes/<int:quiz_id>/export.pdf")
@jwt_required()
def export_results_pdf(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    responses = _load_responses_for_export(quiz)
    dashboard_data = _build_dashboard_data(quiz, responses)
    pdf_bytes = build_results_pdf(quiz, dashboard_data, responses)
    slug = export_filename_slug(quiz.title)
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-results.pdf"'},
    )


@grading_bp.get("/quizzes/<int:quiz_id>/export-detailed.pdf")
@jwt_required()
def export_results_detailed_pdf(quiz_id: int):
    """Full per-Player, per-question results PDF - read-only, same
    authorization/data-loading as export.pdf/export.csv above (see
    services/export.py's module docstring for the grading-result
    definitions this shares with every other analytics surface).

    Re-fetches the quiz with questions/options/image eager-loaded:
    get_visible_quiz's plain db.session.get leaves those lazy, and this
    route (unlike list_quizzes or the lighter summary export) walks every
    question's options and image for every Player, which turned an N+1
    over questions into ~50 queries even at just 20 questions/quiz in
    performance testing - eager-loading here (not in the shared
    get_visible_quiz helper, which many lighter routes also use) keeps
    that fix scoped to where it's actually needed.
    """
    quiz = get_visible_quiz(quiz_id)
    quiz = (
        Quiz.query.filter_by(id=quiz.id)
        .options(
            selectinload(Quiz.questions).selectinload(Question.options),
            selectinload(Quiz.questions).selectinload(Question.image),
        )
        .first()
    )
    responses = _load_responses_for_export(quiz)
    dashboard_data = _build_dashboard_data(quiz, responses)
    storage = get_file_storage()
    pdf_bytes = build_detailed_results_pdf(
        quiz,
        dashboard_data,
        responses,
        organization_name=quiz.organization.name,
        load_image_bytes=storage.load_image_bytes,
    )
    slug = export_filename_slug(quiz.title)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{slug}-detailed-results-{date_str}.pdf"'
        },
    )


@grading_bp.get("/players/history")
@jwt_required()
def player_history():
    """Coach View: this player's history across THIS COACH'S quizzes only.

    This reverses an earlier deliberate choice - the org-wide version's
    comment argued that a player's development across the whole program is
    the point, and that argument is still correct. It has not been deleted,
    it has MOVED: the whole-program view now lives at
    /api/organizations/players/history, behind admin. A coach who cannot open
    a quiz must not be able to read its title and scores from here, which is
    exactly what an org-wide list would leak.
    """
    coach = current_coach()
    player_name = request.args.get("name", "").strip()
    if not player_name:
        raise ApiError("Query parameter 'name' is required", status_code=400)

    return jsonify(_player_history_payload(coach, player_name, organization_wide=False))


def _player_history_payload(coach, player_name: str, organization_wide: bool):
    """Shared by the coach and admin routes so the two scopes cannot drift
    into computing different numbers for the same player."""
    scope = [
        Quiz.organization_id == coach.organization_id,
        PlayerAttempt.player_name == player_name,
        PlayerAttempt.status == AttemptStatus.SUBMITTED,
    ]
    if not organization_wide:
        # Coach View. Whole-program history is the admin route's job.
        scope.append(Quiz.coach_id == coach.id)

    responses = (
        official_only(PlayerAttempt.query)
        .join(Quiz)
        .filter(*scope)
        # contains_eager reuses the join above for response.quiz.title instead of
        # a separate lazy-load per response; selectinload batches .answers (and each
        # answer's .question, needed below for pending_grading_count) in one query each.
        .options(
            contains_eager(PlayerAttempt.quiz),
            selectinload(PlayerAttempt.answers).selectinload(Answer.question),
        )
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )

    history = []
    for response in responses:
        counts = count_answers(response.answers)
        # Same rule ResponseRow.tsx's "N to grade" badge uses - only manually
        # graded questions are ever waiting on a coach (a multiple-choice
        # answer's is_correct is computed immediately at answer time), so this
        # and that badge always agree on the same response.
        history.append(
            {
                "quiz_id": response.quiz_id,
                "quiz_title": response.quiz.title,
                "response_id": response.id,
                "submitted_at": response.submitted_at.isoformat(),
                # COUNTS ONLY, no percentage - deliberately unchanged. The
                # percentage a coach sees on this page is computed in the
                # browser at a different precision to the profile page's; see
                # Finding A in the Phase 2 report. Moving it server-side would
                # change a displayed number, which this refactor must not do.
                "graded_answer_count": counts.scored_total,
                "correct_answer_count": counts.correct,
                "pending_grading_count": pending_grading_count(response.answers),
            }
        )

    return {"player_name": player_name, "history": history}
