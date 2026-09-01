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
from app.services.delivered_questions import delivered_questions, to_payload
from app.services.question_exclusions import (
    active_exclusions_for_quiz,
    load_for_attempts,
    load_for_quizzes,
)
from app.services.concept_results import concept_breakdown
from app.services.retest_verification import verification_for
from app.services.scoring import count_answers, pending_grading_count
from app.models import AccessCode, Answer, AttemptStatus, GradeAuditLog, Group, PlayerAttempt, Question, Quiz
from app.schemas.grading import GradeAnswerSchema
from app.services.access_codes import (
    effective_roster_people_for_quiz,
    identity_key,
)
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


def _with_delivered(attempt: PlayerAttempt, quiz: Quiz) -> dict:
    """An attempt, plus WHAT IT WAS DELIVERED.

    The coach's expanded per-player view used to resolve every answer against
    the LIVE question in the browser, which meant a corrected question retitled
    and renumbered results a player received weeks earlier. Sending the
    delivered content alongside the answers is what lets that view agree with
    the player's own results page, the CSV and the PDF.

    Additive: `to_dict` is unchanged, so every existing consumer of this
    payload keeps working.
    """
    payload = attempt.to_dict(include_answers=True)
    payload["delivered_questions"] = [
        to_payload(delivered) for delivered in delivered_questions(attempt, quiz)
    ]
    return payload


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
        .options(
            selectinload(PlayerAttempt.answers),
            # Every answer's SELECTION SET, which Answer.to_dict now emits.
            # Without it that serialiser lazy-loads once per answer, turning the
            # Results tab of a 20-question quiz with 25 players into 500 queries.
            selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options),
            # PRE-EXISTING N+1, found by M4's scale-invariance guard rather than
            # introduced by it: `Answer.to_dict` reports whether a drawing
            # exists, and walked `answer.drawing` once per answer. Measured at
            # 120 queries for 120 answers; 6 afterwards. One line here rather
            # than a note in a backlog, because the guard M4 was asked for
            # covers this route and would otherwise have to be written blind to
            # a real N+1 sitting inside it.
            selectinload(PlayerAttempt.answers).selectinload(Answer.drawing),
            selectinload(PlayerAttempt.player),
            # Loaded up front for _with_delivered below - without it, resolving
            # what each attempt received would be one query per response.
            selectinload(PlayerAttempt.question_snapshots),
        )
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )
    return jsonify([_with_delivered(r, quiz) for r in responses])


@grading_bp.get("/quizzes/<int:quiz_id>/responses/<int:response_id>")
@jwt_required()
def get_response(quiz_id: int, response_id: int):
    quiz = get_visible_quiz(quiz_id)
    response = (
        official_only(PlayerAttempt.query)
        .filter_by(
            id=response_id, quiz_id=quiz.id, status=AttemptStatus.SUBMITTED
        )
        .options(
            selectinload(PlayerAttempt.answers),
            selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options),
            # Same pre-existing per-answer drawing load as list_responses above.
            selectinload(PlayerAttempt.answers).selectinload(Answer.drawing),
            selectinload(PlayerAttempt.player),
            selectinload(PlayerAttempt.question_snapshots),
        )
        .first()
    )
    if response is None:
        raise ApiError("Response not found", status_code=404)
    return jsonify(_with_delivered(response, quiz))


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
    # PEOPLE, NOT NAMES. This counted a list of display names, which cannot
    # hold two players called the same thing - so a group with two "Chris
    # Williams" reported one fewer player than it has, and every rate divided
    # by that short denominator came out too high.
    roster_people = effective_roster_people_for_quiz(quiz, active_code)
    roster_size = len(roster_people)
    response_count = len(responses)
    # None, NOT 0.0, when there is no denominator - the same rule scoring
    # already follows (`score_percent` returns None rather than inventing 0%
    # when nothing is gradeable).
    #
    # THE BUG THIS FIXES: roster_size is who is eligible under the CURRENTLY
    # ACTIVE code, and `effective_roster_names_for_quiz` is handed None once
    # that code expires - at which point it falls back to the quiz's own
    # Roster, which is legitimately EMPTY for a coach who activates against a
    # Group (groups are linked to the access code, not the quiz). `responses`
    # meanwhile is every submitted attempt the quiz ever received. So a quiz
    # seventeen players completed reported a 0% response rate, on the Results
    # tab and in the exported PDF, a week after its code lapsed.
    #
    # 0-of-2 is still a true 0.0 and still reported as one. Only "we have no
    # denominator" becomes None.
    response_rate = (response_count / roster_size) if roster_size else None

    # Same effective roster this function already uses for
    # roster_size/response_rate above - reflects whichever code is
    # currently active, group-restricted or not. Still staleness-tolerant
    # in the sense that a coach editing group membership after players have
    # already started won't retroactively change who's "missing" for
    # attempts already in progress - just like before groups existed.
    #
    # Matched on identity too: comparing names hid BOTH same-named players the
    # moment either one submitted. The attempts here are already loaded, so
    # this reads their player_id rather than issuing a query.
    responded = {identity_key(r.player_id, r.player_name) for r in responses}
    missing_players = [
        person["name"]
        for person in roster_people
        if identity_key(person["player_id"], person["name"]) not in responded
    ]

    # Every ACTIVE exclusion on this quiz, as rows rather than a boolean: a
    # question can be covered by BOTH a quiz-wide and an assignment exclusion,
    # and the coach has to see both or Restore will look broken.
    exclusion_rows = active_exclusions_for_quiz(quiz.id)
    exclusions_by_question: dict[int, list] = {}
    for row in exclusion_rows:
        exclusions_by_question.setdefault(row.question_id, []).append(row)

    question_breakdown = []
    # NUMBERED HERE, not in the browser. `enumerate` over the position-sorted
    # list is the same rule the CSV's "Question #" column and the detailed
    # PDF's "QUESTION n" heading already use, so the screen cannot disagree
    # with the exports a coach downloads from the same page.
    #
    # Deliberately NOT `position + 1`: deleting a question leaves gaps in
    # `questions.position` (creation appends len(questions), deletion never
    # renumbers), so that would skip a number. And deliberately not computed
    # from the row index client-side, where a later sort or filter could
    # silently renumber the quiz.
    for number, question in enumerate(sorted(quiz.questions, key=lambda q: q.position), start=1):
        answers = [a for r in responses for a in r.answers if a.question_id == question.id]
        # Grouped by QUESTION rather than by attempt, but the same three
        # counts and the same rule - so it comes from the same counter. A
        # question nobody answered has no rows and every count is zero;
        # `answered_count` is how this surface expresses that, not an
        # unanswered figure (which counting answer rows cannot produce).
        #
        # DELIBERATELY NOT FILTERED BY EXCLUSION. These counts are the
        # EVIDENCE - usually the very thing that made the coach exclude the
        # question - so they stay exactly as recorded and the row is MARKED
        # instead. Zeroing them would hide why the question was a problem.
        counts = count_answers(answers)
        rows = exclusions_by_question.get(question.id, [])

        question_breakdown.append(
            {
                "question_id": question.id,
                # The quiz's own numbering. An excluded question KEEPS its
                # number - it is still the twelfth question of the quiz, it
                # just no longer counts - so nothing here is renumbered.
                "question_number": number,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                #: The question's CURRENT tag. Null reads as Untagged, which is
                #: an ordinary state - see services/concept_results for why
                #: this is the live tag rather than the delivered snapshot.
                "concept": (
                    {"id": question.concept.id, "name": question.concept.name}
                    if question.concept
                    else None
                ),
                "answered_count": len(answers),
                "correct_count": counts.correct,
                "incorrect_count": counts.incorrect,
                "ungraded_count": counts.not_graded,
                "is_excluded": bool(rows),
                # Coach-facing surface, so the reason IS included here - it is
                # the coach's own note. It is never included in any /play
                # payload.
                "exclusions": [row.to_dict(include_reason=True) for row in rows],
            }
        )

    return {
        "quiz_id": quiz.id,
        "roster_size": roster_size,
        "response_count": response_count,
        "response_rate": round(response_rate, 4) if response_rate is not None else None,
        "missing_players": missing_players,
        "question_breakdown": question_breakdown,
        #: WEAKEST CONCEPT FIRST. Empty when nothing in this quiz is tagged,
        #: which is the client's signal to render the ordinary Results view
        #: rather than an empty weakness panel. Untagged questions are absent
        #: from this list by design and remain fully visible in the
        #: per-question breakdown above.
        "concept_breakdown": concept_breakdown(quiz, responses),
        #: DID THE RESULT IMPROVE? Present only on a quiz that was built as a
        #: retest; None everywhere else, which is the client's signal to render
        #: nothing rather than an empty verification card.
        "verification": verification_for(quiz),
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
            # The SET a "Select all that apply" answer stores, which both the
            # CSV and the detailed PDF now print. Lazy-loading it would be one
            # query per answer across the whole roster - the exact N+1 the
            # export's query budget exists to catch.
            #
            # JOINED, NOT SELECTIN, AND THAT IS THE POINT. `selectinload`
            # chunks parent keys 500 at a time, so it cost FOUR queries at 100
            # players x 20 questions and would cost more as a program grows -
            # measured, and it broke this export's scale-invariance guard.
            # Joining it onto the answers query instead costs ZERO extra
            # queries at any size. Safe here because a selection row is two
            # integers: multiplying answer rows by a handful of them is cheap,
            # which is NOT true of the drawing blob below.
            selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options),
            selectinload(PlayerAttempt.player),
            # Phase 4a: every builder now resolves what each attempt was
            # DELIVERED. Without this the lazy load fires once per attempt and
            # the export goes straight back to the N+1 that
            # test_export_detailed_performance's query budget exists to catch -
            # it caught exactly this.
            selectinload(PlayerAttempt.question_snapshots),
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
    csv_text = build_results_csv(quiz, responses, load_for_quizzes([quiz.id]))
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
    pdf_bytes = build_results_pdf(
        quiz, dashboard_data, responses, exclusions=load_for_quizzes([quiz.id])
    )
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
            # The clip too, for the same reason and found the same way: the
            # PDF reads `question.clip` to fall back to its poster frame, and
            # without this that is one lazy load per question. The query-budget
            # test caught it at 36 queries against a ceiling of 20 - which is
            # the third time that test has paid for itself.
            selectinload(Quiz.questions).selectinload(Question.clip),
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
        exclusions=load_for_quizzes([quiz.id]),
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

    exclusions = load_for_attempts(responses)
    history = []
    for response in responses:
        counts = count_answers(exclusions.active_answers(response))
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
