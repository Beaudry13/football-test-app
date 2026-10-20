"""WHAT IS OUT FOR ONE PLAYER RIGHT NOW - groundwork for a player home.

Today a player is identified one code at a time (a code + his name, and under
PIN security his attempt token), so nothing can answer "what is waiting for
me?" across codes. This module answers it for the server, from the rules that
already decide who may use a code - it does not invent a second rule:

  * a code counts while it is live (`reason_for_invalid` is None) and belongs
    to the player's organization;
  * he counts on it exactly when the name picker would offer him
    (`selectable_players_for_code`): live in a linked group or on the quiz's
    own roster, or already holding an attempt there.

NO ROUTE USES THIS YET, deliberately. Serving it to a player needs a proof of
identity that spans codes, which does not exist (see docs/PLAYER-HOME.md for
the recommended design and its security review). Until then it is reversible
groundwork: read-only, covered by tests, unreachable from outside.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.models import AccessCode, PlayerAttempt, Quiz
from app.services.access_codes import reason_for_invalid, selectable_players_for_code


def open_assignments(player) -> list[dict]:
    """Live codes this player may use now, soonest closing first, with how far
    he got on each (from his own attempts only)."""
    now = datetime.now(timezone.utc)
    codes = (
        AccessCode.query.join(Quiz, Quiz.id == AccessCode.quiz_id)
        .filter(
            Quiz.organization_id == player.organization_id,
            AccessCode.is_active.is_(True),
            AccessCode.expires_at > now,
        )
        .order_by(AccessCode.expires_at.asc(), AccessCode.id.asc())
        .all()
    )
    out = []
    for code in codes:
        if reason_for_invalid(code) is not None:
            continue
        if not any(entry["player_id"] == player.id for entry in selectable_players_for_code(code)):
            continue
        mine = (
            PlayerAttempt.query.filter_by(access_code_id=code.id, player_id=player.id)
            .order_by(PlayerAttempt.started_at.desc(), PlayerAttempt.id.desc())
            .first()
        )
        out.append(
            {
                "access_code_id": code.id,
                "code": code.code,
                "quiz_id": code.quiz_id,
                "title": code.quiz.title,
                "kind": code.quiz.kind,
                "mode": code.mode,
                "is_retest": code.quiz.retest_of_quiz_id is not None,
                "expires_at": code.expires_at.isoformat(),
                # Not started / started / finished - his own attempt, nobody else's.
                "status": "not_started" if mine is None else mine.status.value.lower(),
            }
        )
    return out
