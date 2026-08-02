"""Public, unauthenticated endpoints players use to take a quiz.

No player accounts exist: identity is (access code + a name chosen from
the coach-uploaded roster), which is exactly what every route here checks.

Attempt lifecycle: /start creates or resumes a PlayerAttempt the moment a
player picks their name; /answers autosaves one answer at a time against
it; /submit locks it. Every mutating route re-derives the attempt from
(access_code_id, player_name) rather than trusting a client-supplied
attempt id - the id is a guessable sequential PK, and the composite key is
exactly the same proof-of-eligibility a player already demonstrated by
holding a valid code and picking a roster-matched name.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import AccessCode, Answer, AttemptStatus, PlayerAttempt, Question
from app.schemas.play import (
    PlayerResultsSchema,
    SaveAnswerSchema,
    StartAttemptSchema,
    SubmitQuizSchema,
    ValidateCodeSchema,
)
from app.services.access_codes import (
    effective_roster_names,
    find_access_code_by_code,
    reason_for_invalid,
)
from app.services.attempts import find_attempt, upsert_answer
from app.utils.validation import load_json_body

play_bp = Blueprint("play", __name__)

NO_RESULTS_FOUND = "No results found for that code and name"
ALREADY_SUBMITTED = "This player has already submitted this quiz"


def _invalid_code_error(reason: str) -> ApiError:
    # not_found and deactivated share one message deliberately - telling a
    # caller which of the two applies would let them enumerate which codes
    # are real. expired gets its own calmer, specific message since knowing
    # a code *used to* work leaks nothing new (the player just had it).
    message = "This access code has expired" if reason == "expired" else "Invalid access code"
    return ApiError(message, status_code=404, reason=reason)


def _resolve_answer_text(question: Question, answer: Answer | None) -> str | None:
    if answer is None:
        return None
    if question.question_type.value == "written":
        return answer.answer_text
    option = next((o for o in question.options if o.id == answer.selected_option_id), None)
    return option.option_text if option else None


def _attempt_state(attempt: PlayerAttempt) -> dict:
    """Player-safe attempt payload for /start and /answers.

    Unlike PlayerAttempt.to_dict() (coach-facing, used by the grading
    routes), this never includes is_correct/coach_feedback/graded_at -
    matching validate-code's existing include_correct_answers=False rule,
    a player must not be able to learn which of their answers are correct
    before they submit, even though is_correct is now computed at autosave
    time rather than deferred to submit.
    """
    return {
        "attempt_id": attempt.id,
        "status": attempt.status.value,
        "answers": [
            {
                "question_id": a.question_id,
                "selected_option_id": a.selected_option_id,
                "answer_text": a.answer_text,
            }
            for a in attempt.answers
        ],
    }


@play_bp.post("/validate-code")
# Codes are 6 characters from a 31-character alphabet (~887M combinations).
# Without a limit here, that space is guessable by brute force; at 20/minute
# per IP it would take on the order of decades, while still leaving room for
# a player who mistypes a code a few times in a row.
@limiter.limit("20 per minute")
def validate_code():
    data = load_json_body(ValidateCodeSchema())

    normalized_code = data["code"].strip().upper()
    access_code = AccessCode.query.filter_by(code=normalized_code).first()
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    quiz = access_code.quiz

    return jsonify(
        {
            "access_code_id": access_code.id,
            "expires_at": access_code.expires_at.isoformat(),
            "quiz": quiz.to_dict(include_questions=True, include_correct_answers=False),
            "roster_players": effective_roster_names(access_code),
        }
    )


@play_bp.post("/start")
# Once per name-selection (not per answer), so the same rate as
# validate-code/submit is the right ballpark.
@limiter.limit("20 per minute")
def start_attempt():
    data = load_json_body(StartAttemptSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    roster_names = set(effective_roster_names(access_code))
    if data["player_name"] not in roster_names:
        raise ApiError("Player name is not on this quiz's roster", status_code=422)

    existing = find_attempt(access_code.id, data["player_name"])
    if existing is not None:
        if existing.status == AttemptStatus.SUBMITTED:
            raise ApiError(ALREADY_SUBMITTED, status_code=409)
        return jsonify(_attempt_state(existing))

    attempt = PlayerAttempt(
        quiz_id=access_code.quiz_id, access_code_id=access_code.id, player_name=data["player_name"]
    )
    db.session.add(attempt)
    try:
        db.session.commit()
    except IntegrityError:
        # Two concurrent "start" calls for the same name is a benign race
        # (e.g. a fast double-tap), not a genuine conflict - converge to
        # whichever one won instead of erroring.
        db.session.rollback()
        existing = find_attempt(access_code.id, data["player_name"])
        if existing is None:
            raise
        if existing.status == AttemptStatus.SUBMITTED:
            raise ApiError(ALREADY_SUBMITTED, status_code=409) from None
        return jsonify(_attempt_state(existing))

    return jsonify(_attempt_state(attempt)), 201


@play_bp.post("/answers")
# Fires once per answer change (debounced/blur-triggered client-side, plus
# an immediate save on every option pick), not once per session like
# /start or /submit - a normal quiz's answer count stays well under this
# even accounting for retries.
@limiter.limit("60 per minute")
def save_answer():
    data = load_json_body(SaveAnswerSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        # Same check /submit already makes - without it a player could
        # autosave indefinitely past expiry, only discovering the code
        # expired at final submit instead of the moment it actually does.
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"])
    if attempt is None:
        raise ApiError("Start the quiz before saving an answer", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        # The hard lock: once submitted, no further edits.
        raise ApiError("This attempt has already been submitted", status_code=409)

    upsert_answer(attempt, data["question_id"], data["selected_option_id"], data["answer_text"])
    db.session.commit()

    return "", 204


@play_bp.post("/submit")
@limiter.limit("20 per minute")
def submit_quiz():
    data = load_json_body(SubmitQuizSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"])
    if attempt is None:
        raise ApiError("Start the quiz before submitting", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        raise ApiError(ALREADY_SUBMITTED, status_code=409)

    submitted_question_ids = [a["question_id"] for a in data["answers"]]
    if len(submitted_question_ids) != len(set(submitted_question_ids)):
        raise ApiError("Each question can only be answered once per submission", status_code=422)

    # Everything from here writes. If anything raises partway through - an
    # invalid question/option in a *later* answer after an *earlier* one in
    # this same payload already upserted cleanly, or the IntegrityError
    # below - the session must not be left holding an uncommitted write:
    # that leaves the connection "idle in transaction", holding a lock that
    # blocks later work on the same rows (this attempt's own teardown
    # included) until something eventually tears it down. The original
    # single-insert version of this route avoided the problem by
    # validating every answer *before* writing any of them; looping over
    # the shared validate-and-upsert helper reintroduces the same failure
    # mode, so every exit past this point goes through one rollback.
    try:
        # Final sync: upsert whatever the client currently has, so submit
        # is robust even if an individual autosave call failed transiently
        # along the way - not solely reliant on every autosave succeeding.
        for submitted_answer in data["answers"]:
            upsert_answer(
                attempt,
                submitted_answer["question_id"],
                submitted_answer["selected_option_id"],
                submitted_answer["answer_text"],
            )

        # A conditional UPDATE, not a plain read-then-write: a debounced
        # autosave and this submit can race within the same network
        # window. Checking rowcount makes the two requests serialize
        # correctly regardless of commit order, instead of risking a
        # lost-update where an autosave silently attaches an answer after
        # the attempt is already shown elsewhere as locked.
        result = db.session.execute(
            sa_update(PlayerAttempt)
            .where(PlayerAttempt.id == attempt.id, PlayerAttempt.status == AttemptStatus.IN_PROGRESS)
            .values(status=AttemptStatus.SUBMITTED, submitted_at=datetime.now(timezone.utc))
        )
        if result.rowcount == 0:
            # Lost the race to a concurrent submit between the status
            # check above and this update.
            raise ApiError(ALREADY_SUBMITTED, status_code=409)

        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ApiError(ALREADY_SUBMITTED, status_code=409) from exc
    except Exception:
        db.session.rollback()
        raise

    db.session.refresh(attempt)
    return jsonify(attempt.to_dict(include_answers=True)), 201


@play_bp.post("/results")
@limiter.limit("20 per minute")
def player_results():
    """A player's own graded results - revisitable after the code expires,
    since grading (especially of written answers) can happen well after."""
    data = load_json_body(PlayerResultsSchema())

    access_code = find_access_code_by_code(data["code"])
    if access_code is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    attempt = (
        PlayerAttempt.query.filter(
            PlayerAttempt.access_code_id == access_code.id,
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
            db.func.lower(PlayerAttempt.player_name) == data["player_name"].strip().lower(),
        )
        .options(selectinload(PlayerAttempt.answers))
        .first()
    )
    if attempt is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    quiz = access_code.quiz
    answers_by_question = {a.question_id: a for a in attempt.answers}

    answer_details = []
    for question in sorted(quiz.questions, key=lambda q: q.position):
        answer = answers_by_question.get(question.id)
        correct_option = next((o for o in question.options if o.is_correct_answer), None)

        answer_details.append(
            {
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "your_answer": _resolve_answer_text(question, answer),
                "correct_answer": correct_option.option_text if correct_option else None,
                "is_correct": answer.is_correct if answer else None,
                "coach_feedback": answer.coach_feedback if answer else None,
                "graded_at": answer.graded_at.isoformat() if answer and answer.graded_at else None,
            }
        )

    return jsonify(
        {
            "quiz_title": quiz.title,
            "player_name": attempt.player_name,
            "submitted_at": attempt.submitted_at.isoformat(),
            "answers": answer_details,
        }
    )
