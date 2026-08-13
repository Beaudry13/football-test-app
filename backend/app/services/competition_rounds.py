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
from app.models import CompetitionSession, Question
from app.models.competition import (
    COMPLETE,
    LEADERBOARD,
    LIVE_LIFETIME,
    LOBBY,
    PODIUM,
    PODIUM_LAST_STEP,
    QUESTION_OPEN,
    QUESTION_REVEAL,
)
from app.services.competition import COMPETITION_QUESTION_TYPES, CompetitionError
from app.services import competition_scoring as scoring
from app.services.competition_answers import score_round

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


def playable_round_from(session: CompetitionSession, start_index: int) -> int | None:
    """The first round at or after `start_index` whose question still exists.

    A coach can delete a question from the quiz while the competition is
    running. The frozen order is deliberately NOT rewritten - it is the
    historical record of what this competition was built to play - so instead
    the hole is stepped over when advancing.

    That keeps two things true at once: `current_round` is only ever set to a
    round that can actually be opened, so it can never point into a gap; and
    rounds never shift, so a later round still plays the question it always
    would have. What is lost is only the deleted round itself.
    """
    order = session.question_order or []
    for index in range(max(0, start_index), len(order)):
        if db.session.get(Question, order[index]) is not None:
            return index
    return None


def _retire_leaderboard(session: CompetitionSession) -> None:
    """Record the board the room has just FINISHED looking at.

    WHY THIS IS NOT DONE AT SHOW_LEADERBOARD
    -----------------------------------------
    It was, and it was wrong. Setting the baseline as the board went up meant
    the standings rendered for that board were compared against themselves:
    the first leaderboard showed every row as "unchanged" instead of NEW, and
    every later one showed zero movement for everybody.

    A unit test missed it because it read the table while still in
    QUESTION_REVEAL, never actually showing the second board. An eight-player
    walkthrough found it immediately - the arrows were all dashes.

    So the baseline advances when the room LEAVES the leaderboard. While a
    board is on screen, `last_leaderboard_round` still points at the previous
    one, which is exactly the comparison the arrows are meant to describe.
    Skipping a leaderboard never passes through here, so a board nobody saw
    still never becomes a baseline.
    """
    if session.status == LEADERBOARD:
        session.last_leaderboard_round = session.current_round


def _open_question(session: CompetitionSession, round_index: int) -> None:
    """Point the session at a round and start its clock.

    The clock is SERVER TIME and both ends are stored: clients render the
    lead-in and the countdown from these two timestamps plus `server_now`, so
    a refresh mid-question cannot restart anything and a reconnecting player
    cannot gain a second.
    """
    # Step over any question deleted since the order was frozen.
    target = playable_round_from(session, round_index)
    if target is None:
        raise CompetitionError(
            "There is no question for that round.", status_code=409, reason="no_such_round"
        )
    opens_at = _now() + LEAD_IN
    session.current_round = target
    session.question_opened_at = opens_at
    session.question_closes_at = opens_at + timedelta(seconds=session.question_time_seconds)


def _apply(session: CompetitionSession, action: str) -> None:
    """The side effects of a transition, beyond the status change itself."""
    if action == START_QUESTION:
        _freeze_question_order(session)
        session.started_at = _now()
        # The lobby deadline stops applying the moment the room is real. See
        # LIVE_LIFETIME: leaving it in place let a competition that started
        # late in a long-open lobby vanish from the coach's recovery banner
        # mid-question.
        session.expires_at = session.started_at + LIVE_LIFETIME
        _open_question(session, 0)

    elif action == NEXT_QUESTION:
        # BEFORE the round advances, and only when leaving a board that was
        # actually on screen.
        _retire_leaderboard(session)
        _open_question(session, session.current_round + 1)

    elif action == SHOW_ANSWER:
        # Closing the window is implicit: `answering_open` is False in any
        # status other than QUESTION_OPEN, so revealing early - because
        # everyone was already in - shuts answering without a second rule.
        #
        # THE ROUND IS SCORED HERE, once. Reaching this line at all already
        # required the version guard to pass, so a double-clicked reveal is
        # refused before it arrives; score_round is idempotent as well, so
        # neither a replay nor a retry can double-award.
        session.scoring_version = scoring.SCORING_VERSION
        score_round(session)

    elif action == FINISH:
        _retire_leaderboard(session)
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
        if playable_round_from(session, session.current_round + 1) is None:
            actions = [a for a in actions if a != NEXT_QUESTION]
    return sorted(actions)


def leaderboard_hint(session: CompetitionSession) -> str | None:
    """A SUGGESTION for the coach, never a rule.

    THE EXACT RULES, in order - the first that matches wins:

      1. `first_standings`          - after round 0, and more rounds remain.
                                      Establishes the stakes once.
      2. `keep_the_finish_a_surprise` - 1 or 2 playable rounds left. Showing
                                      standings here makes the podium a
                                      foregone conclusion.
      3. `midpoint_standings`       - competitions of 8+ rounds, every 4th
                                      round, while more than 2 remain.
      4. otherwise None.

    Deliberately silent most of the time: a hint on every screen is one a
    coach learns to ignore, and this needs to still mean something on the
    round where it says "keep the ending a surprise".

    A hint NEVER transitions, never hides a control and never delays anything.
    Both SHOW_LEADERBOARD and NEXT_QUESTION remain in available_actions
    regardless of what this returns. Wording is sport-neutral - Competition
    should read the same in a classroom as in a film room.
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
