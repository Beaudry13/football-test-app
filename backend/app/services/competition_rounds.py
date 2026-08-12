"""Competition M2: the round state machine.

WHY THIS IS A TABLE AND NOT A PILE OF ifs
------------------------------------------
A live competition has one coach clicking buttons in front of a room, possibly
from two tabs, on a flaky connection, while thirty phones poll. The set of
legal moves has to be something you can READ, not something you reconstruct by
tracing conditionals. So every transition is one row in TRANSITIONS below, and
anything absent from that table is impossible by construction rather than by a
check somebody remembered to write.

THREE RULES HOLD FOR EVERY TRANSITION
--------------------------------------
1. THE COACH MOVES THE ROOM. Nothing here fires on a timer. The only
   time-driven behaviour in Competition is `answering_open` flipping to False
   when the clock runs out, and that changes no state and bumps no version.
2. EVERY TRANSITION IS GUARDED BY THE VERSION THE CALLER SAW. Two host tabs,
   or one double-clicked button, cannot both apply - the second gets 409.
   Version is used rather than status because two clicks of NEXT QUESTION
   arrive in the same status and must still not both take effect.
3. EVERY APPLIED TRANSITION BUMPS THE VERSION, so every client refetches.

WHAT THIS MODULE DOES NOT DO
-----------------------------
It does not score, and it does not read or write answers. M2.1 is the skeleton
the game hangs on; scoring arrives in M2.2 at the SHOW_ANSWER transition,
which is the one place it belongs (once per round, in one transaction, rather
than racing per submission).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.errors import ApiError
from app.extensions import db
from app.models import CompetitionSession
from app.models.competition import (
    COMPLETE,
    LEADERBOARD,
    LOBBY,
    PODIUM,
    PODIUM_LAST_STEP,
    QUESTION_OPEN,
    QUESTION_REVEAL,
)
from app.services.competition import COMPETITION_QUESTION_TYPES, CompetitionError

#: How long the room gets to breathe between the coach pressing the button and
#: the answering window opening. Rendered as a 3-2-1 by every client from
#: `question_opened_at` being in the FUTURE - which is why this needs no state
#: of its own, and why a reconnect during the lead-in is automatically correct.
LEAD_IN = timedelta(seconds=3)

# --- the actions a coach can take -----------------------------------------

START_QUESTION = "START_QUESTION"
SHOW_ANSWER = "SHOW_ANSWER"
SHOW_LEADERBOARD = "SHOW_LEADERBOARD"
NEXT_QUESTION = "NEXT_QUESTION"
FINISH = "FINISH"
ADVANCE_PODIUM = "ADVANCE_PODIUM"
COMPLETE_COMPETITION = "COMPLETE"

#: (current status, action) -> next status. THE WHOLE LEGAL SURFACE.
#:
#: Read down the left column to see what a coach can do from where they are.
#: Note what is absent: there is no way back into QUESTION_OPEN from PODIUM,
#: no way to reveal before starting, and no way to reach COMPLETE without
#: passing through the podium. Those are not checks - there is simply no row.
TRANSITIONS: dict[tuple[str, str], str] = {
    (LOBBY, START_QUESTION): QUESTION_OPEN,
    (QUESTION_OPEN, SHOW_ANSWER): QUESTION_REVEAL,
    (QUESTION_REVEAL, SHOW_LEADERBOARD): LEADERBOARD,
    (QUESTION_REVEAL, NEXT_QUESTION): QUESTION_OPEN,
    (QUESTION_REVEAL, FINISH): PODIUM,
    (LEADERBOARD, NEXT_QUESTION): QUESTION_OPEN,
    (LEADERBOARD, FINISH): PODIUM,
    (PODIUM, ADVANCE_PODIUM): PODIUM,
    (PODIUM, COMPLETE_COMPETITION): COMPLETE,
}

ACTIONS = frozenset(action for _, action in TRANSITIONS)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------


def _freeze_question_order(session: CompetitionSession) -> None:
    """Snapshot which questions this competition plays, once.

    Taken at the FIRST question rather than at session creation because a
    coach may legitimately fix a typo between opening the lobby and starting -
    but never again after that, because from here on a round number has to
    keep meaning the same question.

    Unsupported types are filtered rather than assumed absent: M1 refuses to
    create a session for a quiz containing one, but the quiz can be edited in
    the window between creating the lobby and starting.
    """
    quiz = session.quiz
    order = [
        question.id
        for question in quiz.questions
        if question.question_type in COMPETITION_QUESTION_TYPES
    ]
    if not order:
        raise CompetitionError(
            "This quiz no longer has any questions Competition Mode can score.",
            status_code=422,
            reason="no_playable_questions",
        )
    session.question_order = order


def _open_question(session: CompetitionSession, round_index: int) -> None:
    """Point the session at a round and start its clock.

    The clock is SERVER TIME and both ends are stored: clients render the
    lead-in and the countdown from these two timestamps plus `server_now`, so
    a refresh mid-question cannot restart anything and a reconnecting player
    cannot gain a second.
    """
    if session.question_id_for_round(round_index) is None:
        raise CompetitionError(
            "There is no question for that round.", status_code=409, reason="no_such_round"
        )
    opens_at = _now() + LEAD_IN
    session.current_round = round_index
    session.question_opened_at = opens_at
    session.question_closes_at = opens_at + timedelta(seconds=session.question_time_seconds)


def _apply(session: CompetitionSession, action: str) -> None:
    """The side effects of a transition, beyond the status change itself."""
    if action == START_QUESTION:
        _freeze_question_order(session)
        session.started_at = _now()
        _open_question(session, 0)

    elif action == NEXT_QUESTION:
        _open_question(session, session.current_round + 1)

    elif action == SHOW_ANSWER:
        # Closing the window is implicit: `answering_open` is False in any
        # status other than QUESTION_OPEN, so revealing early - because
        # everyone was already in - shuts answering without a second rule.
        #
        # M2.2 scores the round HERE, once, in this transaction.
        pass

    elif action == FINISH:
        session.podium_step = 0

    elif action == ADVANCE_PODIUM:
        if session.podium_step >= PODIUM_LAST_STEP:
            raise CompetitionError(
                "The podium has already been fully revealed.",
                status_code=409,
                reason="podium_finished",
            )
        session.podium_step += 1

    elif action == COMPLETE_COMPETITION:
        session.ended_at = _now()


# ---------------------------------------------------------------------------
# The one entry point
# ---------------------------------------------------------------------------


def transition(session: CompetitionSession, action: str, expected_version: int) -> CompetitionSession:
    """Move the room forward. The ONLY way a session's status changes in M2.

    `expected_version` is the version the coach's screen was showing when they
    clicked. If the session has moved since - a second host tab, a double
    click, a retried request after a slow response - this refuses rather than
    applying a transition the coach did not actually intend from the state
    they were looking at.
    """
    if action not in ACTIONS:
        raise CompetitionError(f"Unknown action {action!r}.", status_code=422,
                               reason="unknown_action")

    if session.is_terminal:
        raise CompetitionError(
            "This competition has ended.", status_code=409, reason="session_ended"
        )

    if expected_version != session.version:
        # The screen the coach clicked from is stale. The client refetches and
        # shows them what is actually on the projector before trying again.
        raise ApiError(
            "The competition has already moved on.",
            status_code=409,
            reason="stale_transition",
            details={"current_version": session.version, "status": session.status},
        )

    next_status = TRANSITIONS.get((session.status, action))
    if next_status is None:
        raise ApiError(
            f"Cannot {action.replace('_', ' ').lower()} from {session.status}.",
            status_code=409,
            reason="illegal_transition",
            details={"status": session.status, "action": action},
        )

    _apply(session, action)
    session.status = next_status
    session.bump()
    db.session.commit()
    return session


def available_actions(session: CompetitionSession) -> list[str]:
    """What the host screen may offer right now.

    Derived from the same table the transitions are checked against, so a
    button can never appear for a move the server would refuse - the two
    cannot drift because there is only one source.
    """
    if session.is_terminal:
        return []
    actions = [
        action for (status, action), _ in TRANSITIONS.items() if status == session.status
    ]
    if session.status == PODIUM and session.podium_step >= PODIUM_LAST_STEP:
        actions = [a for a in actions if a != ADVANCE_PODIUM]
    if session.status in (QUESTION_REVEAL, LEADERBOARD):
        # NEXT_QUESTION is only real if there is another question.
        if session.question_id_for_round(session.current_round + 1) is None:
            actions = [a for a in actions if a != NEXT_QUESTION]
    return sorted(actions)


def leaderboard_hint(session: CompetitionSession) -> str | None:
    """A SUGGESTION for the coach, never a rule.

    The coach can always show standings or move on; this only offers a nudge
    at the two moments where the room's experience measurably differs:
    establishing stakes after the first question, and protecting the ending.
    Returns None when there is nothing worth saying, because a hint on every
    screen is noise the coach learns to ignore.
    """
    if session.status not in (QUESTION_REVEAL, LEADERBOARD):
        return None
    remaining = session.total_rounds - (session.current_round + 1)
    if session.current_round == 0 and remaining > 0:
        return "first_standings"
    if 0 < remaining <= 2:
        return "keep_the_finish_a_surprise"
    if session.total_rounds >= 8 and remaining > 2 and (session.current_round + 1) % 4 == 0:
        return "midpoint_standings"
    return None
