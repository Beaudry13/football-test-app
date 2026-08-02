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
from app.models import Answer, AttemptStatus, PlayerAttempt, Quiz
from app.schemas.grading import GradeAnswerSchema
from app.services.export import build_results_csv, build_results_pdf, export_filename_slug
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
        PlayerAttempt.query.filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .options(selectinload(PlayerAttempt.answers))
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )
    return jsonify([r.to_dict(include_answers=True) for r in responses])


@grading_bp.get("/quizzes/<int:quiz_id>/responses/<int:response_id>")
@jwt_required()
def get_response(quiz_id: int, response_id: int):
    quiz = get_visible_quiz(quiz_id)
    response = (
        PlayerAttempt.query.filter_by(
            id=response_id, quiz_id=quiz.id, status=AttemptStatus.SUBMITTED
        )
        .options(selectinload(PlayerAttempt.answers))
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

    answer.is_correct = data["is_correct"]
    if data["coach_feedback"] is not None:
        answer.coach_feedback = data["coach_feedback"]
    answer.graded_at = datetime.now(timezone.utc)

    db.session.commit()
    return jsonify(answer.to_dict())


def _build_dashboard_data(quiz: Quiz, responses: list[PlayerAttempt]) -> dict:
    roster_names = [p.player_name for p in quiz.roster.players] if quiz.roster else []
    roster_size = len(roster_names)
    response_count = len(responses)
    response_rate = (response_count / roster_size) if roster_size else 0.0

    # Same roster this function already uses for roster_size/response_rate -
    # if the quiz's most recent activation was restricted to a specific
    # group rather than the full roster, a name here may not actually have
    # been eligible to submit. Good enough for "who should I follow up
    # with" without tracking which activation was in effect when.
    responded_names = {r.player_name for r in responses}
    missing_players = [name for name in roster_names if name not in responded_names]

    question_breakdown = []
    for question in sorted(quiz.questions, key=lambda q: q.position):
        answers = [a for r in responses for a in r.answers if a.question_id == question.id]
        correct = sum(1 for a in answers if a.is_correct is True)
        incorrect = sum(1 for a in answers if a.is_correct is False)
        ungraded = sum(1 for a in answers if a.is_correct is None)

        question_breakdown.append(
            {
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "answered_count": len(answers),
                "correct_count": correct,
                "incorrect_count": incorrect,
                "ungraded_count": ungraded,
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
        PlayerAttempt.query.filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .options(selectinload(PlayerAttempt.answers).selectinload(Answer.selected_option))
        .all()
    )


@grading_bp.get("/quizzes/<int:quiz_id>/dashboard")
@jwt_required()
def quiz_dashboard(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    responses = (
        PlayerAttempt.query.filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
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


@grading_bp.get("/players/history")
@jwt_required()
def player_history():
    coach = current_coach()
    player_name = request.args.get("name", "").strip()
    if not player_name:
        raise ApiError("Query parameter 'name' is required", status_code=400)

    responses = (
        PlayerAttempt.query.join(Quiz)
        # Org-wide, not per-coach: a player's development across the whole
        # program is the point, and quizzes from different coaches on the
        # same staff are all part of that picture.
        .filter(
            Quiz.organization_id == coach.organization_id,
            PlayerAttempt.player_name == player_name,
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
        )
        # contains_eager reuses the join above for response.quiz.title instead of
        # a separate lazy-load per response; selectinload batches .answers in one query.
        .options(contains_eager(PlayerAttempt.quiz), selectinload(PlayerAttempt.answers))
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )

    history = []
    for response in responses:
        auto_graded = [a for a in response.answers if a.is_correct is not None]
        correct = sum(1 for a in auto_graded if a.is_correct)

        history.append(
            {
                "quiz_id": response.quiz_id,
                "quiz_title": response.quiz.title,
                "response_id": response.id,
                "submitted_at": response.submitted_at.isoformat(),
                "graded_answer_count": len(auto_graded),
                "correct_answer_count": correct,
            }
        )

    return jsonify({"player_name": player_name, "history": history})
