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
    effective_roster_players,
    find_access_code_by_code,
    reason_for_invalid,
)
from app.services.attempts import find_attempt, upsert_answer
from app.utils.validation import load_json_body

play_bp = Blueprint("play", __name__)

NO_RESULTS_FOUND = "No results found for that code and name"
ALREADY_SUBMITTED = "This player has already submitted this Peira"


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
# Without a limit here, that space is guessable by brute force. Every limit
# in this file is keyed per-IP (see app/extensions.py's Limiter key_func) -
# a real team joining together from one shared field/gym/school WiFi
# network shares one public IP, so this has to comfortably cover an entire
# roster (sized for up to 100 players, matching backend/loadtest's largest
# stage) joining within the same short window, not just one player. At
# 200/minute per IP, brute-forcing the code space would still take roughly
# 8 years - the anti-brute-force purpose is unaffected by this headroom.
@limiter.limit("200 per minute")
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
            # Additive, not a replacement for roster_players above (kept
            # unchanged for backward compatibility) - carries player_id
            # alongside each name so the frontend can distinguish two
            # canonical Players who share a display name, and submit the
            # right one back on /start. See effective_roster_players.
            "roster_players_v2": effective_roster_players(access_code),
        }
    )


@play_bp.post("/start")
# Once per name-selection (not per answer), so the same rate as
# validate-code/submit is the right ballpark - see validate-code's comment
# for why this needs to cover a whole team on one shared IP, not one player.
@limiter.limit("200 per minute")
def start_attempt():
    data = load_json_body(StartAttemptSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    player_id = data.get("player_id")
    if player_id is not None:
        # Never trust a client-supplied player_id as proof of eligibility on
        # its own - it must actually be one of this activation's effective
        # roster entries (same check `effective_roster_names` + membership
        # already enforces for a legacy name). Rejects both a genuinely
        # unrelated player_id and one belonging to another organization.
        canonical_ids = {p["player_id"] for p in effective_roster_players(access_code) if p["player_id"]}
        if player_id not in canonical_ids:
            raise ApiError("Player is not on this quiz's roster", status_code=422)
    else:
        roster_names = set(effective_roster_names(access_code))
        if data["player_name"] not in roster_names:
            raise ApiError("Player name is not on this quiz's roster", status_code=422)

    existing = find_attempt(access_code.id, data["player_name"], player_id)
    if existing is not None:
        if existing.status == AttemptStatus.SUBMITTED:
            raise ApiError(ALREADY_SUBMITTED, status_code=409)
        return jsonify(_attempt_state(existing))

    attempt = PlayerAttempt(
        quiz_id=access_code.quiz_id,
        access_code_id=access_code.id,
        player_name=data["player_name"],
        player_id=player_id,
    )
    db.session.add(attempt)
    try:
        db.session.commit()
    except IntegrityError:
        # Two concurrent "start" calls for the same name is a benign race
        # (e.g. a fast double-tap), not a genuine conflict - converge to
        # whichever one won instead of erroring.
        db.session.rollback()
        existing = find_attempt(access_code.id, data["player_name"], player_id)
        if existing is None:
            raise
        if existing.status == AttemptStatus.SUBMITTED:
            raise ApiError(ALREADY_SUBMITTED, status_code=409) from None
        return jsonify(_attempt_state(existing))

    return jsonify(_attempt_state(attempt)), 201


@play_bp.post("/answers")
# Fires once per answer change (debounced/blur-triggered client-side, plus
# an immediate save on every option pick), not once per session like
# /start or /submit, so this needs a higher ceiling than those even before
# accounting for shared-IP headroom (see validate-code's comment) - up to
# ~100 players each autosaving several answers within the same short
# window, all from one IP, easily exceeds a single-player-sized budget.
@limiter.limit("1000 per minute")
def save_answer():
    data = load_json_body(SaveAnswerSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        # Same check /submit already makes - without it a player could
        # autosave indefinitely past expiry, only discovering the code
        # expired at final submit instead of the moment it actually does.
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before saving an answer", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        # The hard lock: once submitted, no further edits.
        raise ApiError("This attempt has already been submitted", status_code=409)

    upsert_answer(attempt, data["question_id"], data["selected_option_id"], data["answer_text"])
    db.session.commit()

    return "", 204


@play_bp.post("/submit")
# See validate-code's comment - keyed per-IP, needs to cover a whole team
# submitting within the same short window, not one player.
@limiter.limit("200 per minute")
def submit_quiz():
    data = load_json_body(SubmitQuizSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before submitting", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        raise ApiError(ALREADY_SUBMITTED, status_code=409)

    submitted_question_ids = [a["question_id"] for a in data["answers"]]
    if len(submitted_question_ids) != len(set(submitted_question_ids)):
        raise ApiError("Each question can only be answered once per submission", status_code=422)

    if access_code.quiz.require_all_answers:
        # A question counts as answered only if the submission actually
        # carries content for it - an autosaved-then-cleared text box or a
        # deselected option must still block submission, not just "some
        # Answer row exists in the database for this question" (which
        # upsert_answer creates even for a blank autosave).
        answered_question_ids = {
            a["question_id"]
            for a in data["answers"]
            if a["selected_option_id"] is not None or (a["answer_text"] or "").strip()
        }
        all_question_ids = {q.id for q in access_code.quiz.questions}
        if not all_question_ids <= answered_question_ids:
            raise ApiError("Please answer all questions before submitting.", status_code=422)

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


@play_bp.get("/quiz-by-code/<code>")
# A lightweight, read-only lookup (title only) fired automatically on page
# load to set the browser tab title - fires for every player the instant
# they open the link, before they've done anything else, so this needs the
# same whole-team-on-one-IP headroom as validate-code's comment describes.
@limiter.limit("200 per minute")
def quiz_by_code(code: str):
    """Quiz title for a code, for tab-title purposes only - deliberately not
    the full validate-code payload (no questions/roster), and deliberately
    never errors on an invalid/expired/deactivated code: callers fall back
    to generic branding on a null title rather than surfacing a lookup
    failure before the player has done anything."""
    access_code = AccessCode.query.filter_by(code=code.strip().upper()).first()
    reason = reason_for_invalid(access_code)
    if reason is not None:
        return jsonify({"quiz_title": None})

    return jsonify({"quiz_title": access_code.quiz.title})


@play_bp.post("/results")
# See validate-code's comment - a whole team may check results within the
# same short window right after everyone submits.
@limiter.limit("200 per minute")
def player_results():
    """A player's own graded results - revisitable after the code expires,
    since grading (especially of written answers) can happen well after."""
    data = load_json_body(PlayerResultsSchema())

    access_code = find_access_code_by_code(data["code"])
    if access_code is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    query = PlayerAttempt.query.filter(
        PlayerAttempt.access_code_id == access_code.id,
        PlayerAttempt.status == AttemptStatus.SUBMITTED,
    )
    player_id = data.get("player_id")
    if player_id is not None:
        # Disambiguates two same-name canonical Players - a name-only match
        # below can't tell them apart and would silently return whichever
        # row the query happens to find first. See PlayerResultsSchema.
        query = query.filter(PlayerAttempt.player_id == player_id)
    else:
        query = query.filter(
            db.func.lower(PlayerAttempt.player_name) == data["player_name"].strip().lower()
        )
    attempt = query.options(selectinload(PlayerAttempt.answers)).first()
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
