"""Competition Mode: session creation, eligibility, joining, lifecycle.

WHAT LIVES HERE AND WHY
------------------------
Every rule that decides who may play, what may be played, and when the
session may change state. The routes are thin on purpose: a live event has
several entry points (coach, player, poll) and a rule enforced in one route
but not another is a rule that does not exist.

THE POLL IS THE HOT PATH
-------------------------
`poll_state` is called roughly once per second by every phone in the room.
It reads ONE row by an indexed join code and returns a handful of scalars.
Nothing here counts participants, builds a leaderboard, or loads a question.
Clients refetch the heavy payload only when `version` changes - that is the
whole reason the column exists.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from app.errors import ApiError
from app.extensions import db
from app.models import (
    CompetitionParticipant,
    CompetitionSession,
    Group,
    GroupPlayer,
    Player,
    Quiz,
)
from app.models.competition import (
    ABANDONED,
    COMPLETE,
    DEFAULT_QUESTION_TIME,
    LOBBY,
    QUESTION_TIME_CHOICES,
    TERMINAL_STATUSES,
)
from app.models.question import AUTO_GRADABLE_TYPES, QuestionType

#: The ONE authoritative rule for what Competition can run.
#:
#: V1 is Multiple Choice and True/False. Fill in the Blank is auto-gradable
#: but exists only as a masked region on a playbook page, which does not fit a
#: twenty-second round; Written and Draw Response need a human to grade them
#: and so cannot produce an instant leaderboard honestly.
#:
#: Declared once and consumed everywhere - a type check scattered through the
#: routes is how "supported" quietly comes to mean two different things.
COMPETITION_QUESTION_TYPES = frozenset({QuestionType.MULTIPLE_CHOICE, QuestionType.TRUE_FALSE})

# Sanity: nothing here may be a type the rest of Peira cannot auto-grade.
assert COMPETITION_QUESTION_TYPES <= AUTO_GRADABLE_TYPES

#: Unambiguous on a phone screen at the back of a meeting room: no O/0, no
#: I/1. Same alphabet reasoning as the player access code.
JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
JOIN_CODE_LENGTH = 6


class CompetitionError(ApiError):
    """A refusal a coach or player should read. Carries a reason so the client
    can distinguish "wrong code" from "already started"."""


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Launch eligibility
# ---------------------------------------------------------------------------


def unsupported_questions(quiz: Quiz) -> list[dict]:
    """Questions that stop this quiz being played as a competition.

    Returned as a LIST OF QUESTIONS, not a count and not a boolean, because
    the coach has to be told exactly which ones and why. Silently excluding
    them would change what they think they are running; silently skipping
    them at play time would be worse.
    """
    blocking = []
    for index, question in enumerate(quiz.questions):
        if question.question_type in COMPETITION_QUESTION_TYPES:
            continue
        blocking.append(
            {
                "question_id": question.id,
                "position": index + 1,
                "question_type": question.question_type.value,
                "reason": (
                    "Draw Response and Short Answer need a coach to grade them, so they "
                    "cannot be scored live."
                    if question.question_type
                    in {QuestionType.WRITTEN, QuestionType.DRAW_RESPONSE}
                    else "Fill in the Blank is not supported in Competition yet."
                ),
            }
        )
    return blocking


def launch_readiness(quiz: Quiz) -> dict:
    """Everything that would stop this quiz starting a competition."""
    blocking = unsupported_questions(quiz)
    return {
        "quiz_id": quiz.id,
        "question_count": len(quiz.questions),
        "supported_question_count": len(quiz.questions) - len(blocking),
        "unsupported_questions": blocking,
        "can_launch": len(quiz.questions) > 0 and not blocking,
    }


# ---------------------------------------------------------------------------
# Who may play
# ---------------------------------------------------------------------------


def eligible_players(session: CompetitionSession) -> list[dict]:
    """The canonical players allowed in this competition.

    Scope comes from the session's settings: either the whole active master
    roster, or the union of chosen groups. Multiple groups is supported
    because the existing group/player join makes it a one-line union - it did
    not complicate anything.

    Only ACTIVE players: a deactivated player is one a coach has already said
    is not on the team.
    """
    group_ids = (session.settings or {}).get("group_ids") or []
    query = Player.query.filter(
        Player.organization_id == session.organization_id,
        Player.is_active.is_(True),
    )
    if group_ids:
        # Explicit join on the link table rather than a relationship: a player
        # in two chosen groups would otherwise appear twice, and DISTINCT here
        # is clearer than de-duplicating a relationship load afterwards. The
        # Group filter also re-checks tenancy, so a group id from another
        # organization contributes nobody.
        query = (
            query.join(GroupPlayer, GroupPlayer.player_id == Player.id)
            .join(Group, Group.id == GroupPlayer.group_id)
            .filter(
                Group.organization_id == session.organization_id,
                GroupPlayer.group_id.in_(list(group_ids)),
            )
        )

    seen: dict[int, Player] = {}
    for player in query.all():
        seen[player.id] = player
    return [
        {"player_id": p.id, "display_name": p.full_name}
        for p in sorted(seen.values(), key=lambda p: (p.last_name.lower(), p.first_name.lower()))
    ]


def _generate_join_code() -> str:
    """A code no live session is already using.

    Retries rather than trusting one draw: with a live uniqueness constraint
    the collision would surface as a 500 at the worst possible moment - a
    coach standing in front of a room.
    """
    for _ in range(12):
        code = "".join(secrets.choice(JOIN_ALPHABET) for _ in range(JOIN_CODE_LENGTH))
        if not CompetitionSession.query.filter_by(join_code=code).first():
            return code
    raise CompetitionError(
        "Could not allocate a competition code - please try again.", status_code=503
    )


# ---------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------


def create_session(quiz: Quiz, coach, *, group_ids=None, question_time_seconds=None) -> CompetitionSession:
    readiness = launch_readiness(quiz)
    if not readiness["can_launch"]:
        if readiness["question_count"] == 0:
            raise CompetitionError(
                "Add at least one question before starting a competition.", status_code=422
            )
        raise ApiError(
            "This quiz has questions Competition Mode cannot score live.",
            status_code=422,
            reason="unsupported_questions",
            details={"unsupported_questions": readiness["unsupported_questions"]},
        )

    seconds = question_time_seconds or DEFAULT_QUESTION_TIME
    if seconds not in QUESTION_TIME_CHOICES:
        raise CompetitionError(
            f"Question time must be one of {', '.join(str(s) for s in QUESTION_TIME_CHOICES)}"
            " seconds.",
            status_code=422,
        )

    session = CompetitionSession(
        organization_id=quiz.organization_id,
        coach_id=coach.id,
        quiz_id=quiz.id,
        join_code=_generate_join_code(),
        status=LOBBY,
        version=1,
        question_time_seconds=seconds,
        settings={"group_ids": list(group_ids or [])},
        expires_at=CompetitionSession.default_expiry(),
    )
    db.session.add(session)
    db.session.commit()
    return session


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def session_by_code(join_code: str) -> CompetitionSession:
    """PUBLIC lookup - a player has no account and no token.

    The join code is the only credential, which is why it is long enough to
    resist guessing and why every mutating player route re-derives the session
    from it rather than trusting an id in the body.
    """
    code = (join_code or "").strip().upper()
    session = CompetitionSession.query.filter_by(join_code=code).first()
    if session is None:
        raise CompetitionError("That competition code is not valid.", status_code=404,
                               reason="invalid_code")
    return session


def active_sessions_for(coach) -> list[CompetitionSession]:
    """The live competitions this coach can walk back into.

    WHY THE SERVER OWNS THIS
    ------------------------
    A coach who closes the tab, refreshes, or opens Peira on the laptop
    attached to the projector has nothing in storage and may not remember the
    code. Recovery therefore cannot come from sessionStorage - it has to be a
    question the server answers from what it knows.

    DELIBERATELY NOT A HISTORY PAGE. Only sessions that are live RIGHT NOW:
    not terminal, not past their expiry. A finished competition is not
    something to return to, and listing it would turn a recovery affordance
    into a management screen nobody asked for.

    Scoped exactly like coach_session(): this coach's own sessions, plus the
    organization's if they are an admin. Never another organization's, so this
    cannot be used to discover that someone else is running a competition.
    """
    query = CompetitionSession.query.filter(
        CompetitionSession.organization_id == coach.organization_id,
        CompetitionSession.status.notin_(TERMINAL_STATUSES),
        CompetitionSession.expires_at > now(),
    )
    if not coach.is_admin():
        query = query.filter(CompetitionSession.coach_id == coach.id)
    return query.order_by(CompetitionSession.created_at.desc()).all()


def coach_session(session_id: int, coach) -> CompetitionSession:
    """A session this coach may CONTROL.

    Tenancy first, then ownership. 404 rather than 403 throughout, so a coach
    cannot learn that another organization's session exists by the error it
    produces - the rule utils/auth already documents.
    """
    session = db.session.get(CompetitionSession, session_id)
    if session is None or session.organization_id != coach.organization_id:
        raise CompetitionError("Competition not found.", status_code=404)
    if session.coach_id != coach.id and not coach.is_admin():
        raise CompetitionError("Competition not found.", status_code=404)
    return session


# ---------------------------------------------------------------------------
# Joining
# ---------------------------------------------------------------------------


def join(
    session: CompetitionSession, player_id: int, *, reconnect_token: str | None = None
) -> CompetitionParticipant:
    """Take a seat, or resume the one already held.

    IDEMPOTENT FOR THE PLAYER WHO HOLDS THE SEAT, AND ONLY THEM.
    A double-tap or a refresh must land back in the same seat. But "already
    joined" is also exactly what an attacker sees when they pick someone
    else's name off the public roster, so resuming requires the token minted
    when that seat was taken.
    
    Without it the answer is 409, not the participant record - handing back
    the seat would be identity takeover, and in M2 it would mean answering on
    someone else's behalf. A player who genuinely lost their token recovers by
    asking the coach to remove them, which frees the identity to be claimed
    again; that path already exists and is deliberate, because the coach can
    see who is actually standing in the room and the server cannot.
    """
    if session.is_terminal:
        raise CompetitionError("This competition has ended.", status_code=409,
                               reason="session_ended")
    if session.is_expired:
        raise CompetitionError("This competition code has expired.", status_code=410,
                               reason="session_expired")

    allowed = {entry["player_id"] for entry in eligible_players(session)}
    if player_id not in allowed:
        # Same 404-not-403 reasoning: never confirm that a player id exists
        # to someone guessing at one.
        raise CompetitionError(
            "That player is not on the roster for this competition.", status_code=404,
            reason="not_eligible",
        )

    existing = CompetitionParticipant.query.filter_by(
        session_id=session.id, player_id=player_id
    ).first()
    if existing is not None:
        # compare_digest, not ==: token comparison should not leak its answer
        # through timing. Cheap here, and the habit is worth keeping.
        if reconnect_token and secrets.compare_digest(
            existing.reconnect_token, reconnect_token
        ):
            existing.last_seen_at = now()
            db.session.commit()
            return existing
        raise CompetitionError(
            "Someone has already joined as that player. Ask your coach to remove them "
            "if this is you.",
            status_code=409,
            reason="identity_taken",
        )

    if not session.accepts_joins:
        raise CompetitionError(
            "This competition has already started.", status_code=409, reason="already_started"
        )

    player = db.session.get(Player, player_id)
    participant = CompetitionParticipant(
        session_id=session.id,
        player_id=player_id,
        display_name=player.full_name,
        reconnect_token=CompetitionParticipant.new_token(),
        joined_at=now(),
        last_seen_at=now(),
    )
    db.session.add(participant)
    session.bump()  # the lobby list changed, so every poller should refetch
    try:
        db.session.commit()
    except Exception:
        # A genuine race between two taps: converge on whichever won rather
        # than surfacing a constraint error to a player.
        db.session.rollback()
        again = CompetitionParticipant.query.filter_by(
            session_id=session.id, player_id=player_id
        ).first()
        if again is None:
            raise
        # Lost the race. Whoever won holds a token this caller does not, so
        # this is the takeover case again - refuse rather than return the seat.
        raise CompetitionError(
            "Someone has already joined as that player. Ask your coach to remove them "
            "if this is you.",
            status_code=409,
            reason="identity_taken",
        )
    return participant


def participant_by_token(
    session: CompetitionSession, reconnect_token: str
) -> CompetitionParticipant:
    """Resolve a player-private request. THE ONLY way a player proves identity.

    Scoped to the session as well as the token, so a token from one
    competition cannot address a seat in another. Looked up BY TOKEN rather
    than by player id - there is deliberately no path here that accepts an
    identifier a third party could know.
    """
    if not reconnect_token:
        raise CompetitionError("Missing session token.", status_code=401,
                               reason="missing_token")
    participant = CompetitionParticipant.query.filter_by(
        session_id=session.id, reconnect_token=reconnect_token
    ).first()
    if participant is None:
        # 401, and the same message whether the token is wrong or the seat was
        # removed - distinguishing them would confirm which tokens exist.
        raise CompetitionError("This session is no longer valid.", status_code=401,
                               reason="invalid_token")
    return participant


def remove_participant(session: CompetitionSession, participant_id: int) -> None:
    """Coach-only, and lobby-only.

    Removing someone mid-competition would delete answers they have already
    given and silently change everyone else's rank, so it is refused once the
    event is under way.
    """
    if session.status != LOBBY:
        raise CompetitionError(
            "Participants can only be removed before the competition starts.", status_code=409
        )
    participant = CompetitionParticipant.query.filter_by(
        id=participant_id, session_id=session.id
    ).first()
    if participant is None:
        raise CompetitionError("Participant not found.", status_code=404)
    db.session.delete(participant)
    session.bump()
    db.session.commit()


def end_session(session: CompetitionSession, *, abandoned: bool = False) -> CompetitionSession:
    if session.is_terminal:
        return session
    session.status = ABANDONED if abandoned else COMPLETE
    session.ended_at = now()
    session.bump()
    db.session.commit()
    return session


def expire_stale_sessions() -> int:
    """Close out lobbies nobody came back to.

    Called opportunistically rather than on a schedule - there is no worker in
    this deployment, and an expired session is harmless until someone tries to
    use it. The join path checks `is_expired` directly, so this is tidying,
    not a correctness guarantee.
    """
    stale = CompetitionSession.query.filter(
        CompetitionSession.status.notin_((COMPLETE, ABANDONED)),
        CompetitionSession.expires_at <= now(),
    ).all()
    for session in stale:
        session.status = ABANDONED
        session.ended_at = now()
        session.bump()
    if stale:
        db.session.commit()
    return len(stale)
