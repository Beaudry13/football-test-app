"""Competition M2.2: taking an answer, and scoring a round.

IDENTITY COMES FROM THE TOKEN AND NOTHING ELSE
-----------------------------------------------
There is no participant id and no player id in the request. Not "they are
ignored" - they are absent from the schema, so there is no field to tamper
with. The seat is resolved by `participant_by_token`, scoped to the session,
exactly as M1 established.

THE SERVER DECIDES EVERYTHING THAT MATTERS
-------------------------------------------
Correctness, timing and points are all computed here. The request carries a
round and an option; it cannot carry a score, a verdict, or an elapsed time,
because none of those are read from it.

POINTS ARE AWARDED AT THE REVEAL, NOT AT SUBMISSION
----------------------------------------------------
`submit_answer` stores what happened. `score_round` turns a round into points,
once, when the coach reveals. Scoring per submission would race the leaderboard
against stragglers and make a double-clicked reveal double-award; doing it once
in one transaction cannot.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models import (
    CompetitionAnswer,
    CompetitionParticipant,
    CompetitionSession,
    Question,
    QuestionOption,
)
from app.models.competition import QUESTION_OPEN
from app.services.competition import COMPETITION_QUESTION_TYPES, CompetitionError
from app.services import competition_scoring as scoring

#: Slack allowed on top of the deadline, for the network rather than the player.
#:
#: A tap at 19.9s on a slow connection arrives after the deadline through no
#: fault of the person who made it, and refusing it in front of a room is the
#: kind of unfairness people remember. 750ms is enough for ordinary mobile
#: latency and far too short to be worth gaming.
#:
#: IT IS NEVER DISCLOSED AND NEVER SCORES. It is absent from every payload, the
#: visible countdown ends at the real deadline, and `clamp_response_ms` pins a
#: grace-window answer to the full question duration - so it buys inclusion,
#: never points.
NETWORK_GRACE = timedelta(milliseconds=750)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def submit_answer(
    session: CompetitionSession, participant: CompetitionParticipant, *,
    round_index: int, option_id: int,
) -> CompetitionAnswer:
    """Record one player's answer to the current round.

    Every refusal carries a stable `reason` so the client branches on a code
    rather than on English - the contract M1 established.
    """
    if session.is_terminal:
        raise CompetitionError("This competition has ended.", status_code=409,
                               reason="session_ended")

    if session.status != QUESTION_OPEN:
        # Before the first question, or already revealed. Distinguished from
        # `answering_closed` because the client shows different screens.
        raise CompetitionError(
            "There is no question open right now.", status_code=409, reason="not_started"
        )

    if round_index != session.current_round:
        # A stale phone answering the previous question, or a crafted request.
        # Either way the answer belongs to a round that is no longer running.
        raise CompetitionError(
            "That question has already finished.", status_code=409, reason="wrong_round"
        )

    opened_at = session.question_opened_at
    closes_at = session.question_closes_at
    if opened_at is None or closes_at is None:
        raise CompetitionError("There is no question open right now.", status_code=409,
                               reason="not_started")

    received = _now()
    opened_at = _aware(opened_at)
    closes_at = _aware(closes_at)

    if received < opened_at:
        # The 3-2-1 lead-in. The question is not on anyone's screen yet, so an
        # answer now could not have been a response to reading it.
        raise CompetitionError(
            "The question has not started yet.", status_code=409, reason="not_started"
        )

    if received > closes_at + NETWORK_GRACE:
        raise CompetitionError(
            "Time is up for that question.", status_code=409, reason="answering_closed"
        )

    question_id = session.question_id_for_round(round_index)
    question = db.session.get(Question, question_id) if question_id else None
    if question is None:
        raise CompetitionError("That question is no longer available.", status_code=409,
                               reason="no_such_round")
    if question.question_type not in COMPETITION_QUESTION_TYPES:
        # Belt and braces: the frozen order is filtered at START_QUESTION, so
        # this should be unreachable - but a type Competition cannot grade must
        # never be gradeable by accident.
        raise CompetitionError(
            "That question cannot be answered in a competition.", status_code=422,
            reason="unsupported_question",
        )

    option = db.session.get(QuestionOption, option_id)
    if option is None or option.question_id != question.id:
        # An option id from a DIFFERENT question - the obvious way to try to
        # smuggle in a known-correct answer. Checked against the frozen round's
        # question, not against whatever the client claims to be answering.
        raise CompetitionError(
            "That answer does not belong to this question.", status_code=422,
            reason="option_mismatch",
        )

    existing = CompetitionAnswer.query.filter_by(
        session_id=session.id, participant_id=participant.id, round_index=round_index
    ).first()
    if existing is not None:
        raise CompetitionError(
            "Your answer is already locked in.", status_code=409, reason="answer_locked"
        )

    window_ms = int(session.question_time_seconds * 1000)
    elapsed_ms = int((received - opened_at).total_seconds() * 1000)

    answer = CompetitionAnswer(
        session_id=session.id,
        participant_id=participant.id,
        question_id=question.id,
        round_index=round_index,
        selected_option_id=option.id,
        # Decided HERE, from the database's own record of which option is
        # correct. Nothing in the request influences it.
        is_correct=bool(option.is_correct_answer),
        responded_at=received,
        response_ms=scoring.clamp_response_ms(elapsed_ms, window_ms),
        # Awarded at the reveal. Zero here is not a score, it is "not yet".
        points_awarded=0,
    )
    db.session.add(answer)
    # NOT bumped: a submission is a counter moving, not a structural change.
    # Bumping would make every phone in the room refetch heavy state on every
    # tap - the stampede the M1 load harness caught.
    try:
        db.session.commit()
    except Exception:
        # Lost a genuine double-tap race. The unique constraint is the real
        # guarantee; this turns it into the same answer the loser would have
        # got had they arrived a moment later.
        db.session.rollback()
        raise CompetitionError(
            "Your answer is already locked in.", status_code=409, reason="answer_locked"
        ) from None
    return answer


def answer_state(session: CompetitionSession, participant: CompetitionParticipant) -> dict:
    """What this player may know about their own answer right now.

    Deliberately withholds `is_correct`, the correct option, the explanation
    and the points until the coach reveals. A phone that knew it was right
    before the room did would leak the answer to anyone glancing at it.
    """
    answer = CompetitionAnswer.query.filter_by(
        session_id=session.id,
        participant_id=participant.id,
        round_index=session.current_round,
    ).first()
    if answer is None:
        return {"answered": False, "selected_option_id": None, "round_index": session.current_round}
    return {
        "answered": True,
        "selected_option_id": answer.selected_option_id,
        "round_index": answer.round_index,
    }


def score_round(session: CompetitionSession) -> int:
    """Turn one round's stored answers into points. Called at SHOW_ANSWER.

    IDEMPOTENT. Re-running it - a double-clicked reveal, a retried request,
    a replayed transition - must not award a single extra point. The guard is
    the answer rows themselves: an answer already carrying points has been
    scored, so it is skipped. Nothing depends on remembering whether this ran.

    Streaks are updated here too, and are worth nothing; see
    competition_scoring.next_streak.
    """
    total_rounds = session.total_rounds
    window_ms = int(session.question_time_seconds * 1000)

    answers = CompetitionAnswer.query.filter_by(
        session_id=session.id, round_index=session.current_round
    ).all()

    scored = 0
    answered_participants = set()
    for answer in answers:
        answered_participants.add(answer.participant_id)
        if answer.points_awarded:
            # Already scored. Skipping is what makes a replay harmless.
            continue
        points = scoring.score_answer(
            is_correct=answer.is_correct,
            response_ms=answer.response_ms,
            window_ms=window_ms,
            round_index=answer.round_index,
            total_rounds=total_rounds,
        )
        answer.points_awarded = points
        participant = db.session.get(CompetitionParticipant, answer.participant_id)
        if participant is not None:
            participant.total_points = (participant.total_points or 0) + points
            participant.current_streak = scoring.next_streak(
                participant.current_streak or 0, answer.is_correct
            )
            participant.best_streak = max(
                participant.best_streak or 0, participant.current_streak
            )
        scored += 1

    # A player who did not answer breaks their streak, exactly as a wrong
    # answer does. Guarded by `scored` so a replay cannot reset a streak twice
    # - on the second call every answer is already scored and nothing runs.
    if scored:
        for participant in session.participants:
            if participant.id not in answered_participants:
                participant.current_streak = 0

    db.session.commit()
    return scored
