"""Access code generation and lookup.

Codes are short, uppercase, and avoid visually ambiguous characters
(0/O, 1/I/L) since players type them in by hand from a screen or sideline card.
"""

import secrets
import string
from datetime import datetime, timezone

from app.models import AccessCode, Quiz

CODE_ALPHABET = "".join(sorted(set(string.ascii_uppercase + string.digits) - set("0O1IL")))
CODE_LENGTH = 6


def generate_unique_code() -> str:
    while True:
        # secrets, not random: random's Mersenne Twister is predictable given
        # enough observed output, which matters for a code that gates quiz access.
        candidate = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if AccessCode.query.filter_by(code=candidate).first() is None:
            return candidate


def reason_for_invalid(access_code: AccessCode | None) -> str | None:
    """Why `access_code` can't be used right now, or None if it's valid.

    Never branches on org/quiz ownership - a code belonging to a different
    org must report the same "not_found" as a code that plain doesn't exist,
    or a caller could enumerate which codes are real across organizations
    they have no business knowing about.
    """
    if access_code is None:
        return "not_found"
    if not access_code.is_active:
        return "deactivated"
    if access_code.expires_at <= datetime.now(timezone.utc):
        return "expired"
    return None


def find_access_code_by_code(code: str) -> AccessCode | None:
    """Like `find_valid_access_code`, but doesn't gate on expiry/deactivation.

    For looking up a player's already-submitted results after the code has
    expired - the join/submit flow should still reject an expired code, but
    a response that was already recorded under it should stay reviewable.
    """
    normalized = code.strip().upper()
    return AccessCode.query.filter_by(code=normalized).first()


def effective_roster_names(access_code: AccessCode) -> list[str]:
    """The player names allowed to join/submit under this activation.

    If one or more saved Groups are linked to this code, they're the sole
    source of truth (a name not in any linked group is invisible at join
    time and rejected at submit time, even if it's also on the quiz's own
    Roster) - this is what lets a coach restrict a given activation to e.g.
    Varsity only. With no linked groups, falls back to the quiz's Roster,
    exactly like before groups existed.
    """
    if access_code.groups:
        seen: dict[str, str] = {}
        for group in access_code.groups:
            for player in group.players:
                # First-seen casing wins if the same name (case-insensitively)
                # appears in more than one linked group.
                seen.setdefault(player.player_name.lower(), player.player_name)
        return list(seen.values())

    quiz = access_code.quiz
    return [p.player_name for p in (quiz.roster.players if quiz.roster else [])]


def effective_roster_players(access_code: AccessCode) -> list[dict]:
    """Like `effective_roster_names`, but resolves each entry's canonical
    identity where one exists - `{"player_id", "name", "jersey_number",
    "position"}` per eligible player. A canonical entry's `name` is always
    the Player's *current* full_name (fresh, not a stale snapshot); a
    legacy entry (player_id None) is whatever the coach typed on the
    Roster/Group, with jersey_number/position both None (nothing else to
    show for it).

    jersey_number/position are included specifically so the frontend can
    tell two canonical Players who share a display name apart at a glance
    (e.g. two "Chris Smith"s) - `name` alone can't, and player_id isn't
    human-readable. The plain string list from effective_roster_names()
    can't represent any of this, which is why it stays unchanged for
    existing callers rather than being replaced outright.
    """
    if access_code.groups:
        seen: dict[str, dict] = {}
        for group in access_code.groups:
            for player in group.players:
                if player.player_id is not None and player.player is not None:
                    key = f"player:{player.player_id}"
                    seen.setdefault(
                        key,
                        {
                            "player_id": player.player_id,
                            "name": player.player.full_name,
                            "jersey_number": player.player.jersey_number,
                            "position": player.player.position,
                        },
                    )
                else:
                    key = f"name:{player.player_name.lower()}"
                    seen.setdefault(
                        key,
                        {
                            "player_id": None,
                            "name": player.player_name,
                            "jersey_number": None,
                            "position": None,
                        },
                    )
        return list(seen.values())

    quiz = access_code.quiz
    roster_players = quiz.roster.players if quiz.roster else []
    result = []
    seen_names: set[str] = set()
    for rp in roster_players:
        if rp.player_id is not None and rp.player is not None:
            result.append(
                {
                    "player_id": rp.player_id,
                    "name": rp.player.full_name,
                    "jersey_number": rp.player.jersey_number,
                    "position": rp.player.position,
                }
            )
        else:
            if rp.player_name.lower() not in seen_names:
                seen_names.add(rp.player_name.lower())
                result.append(
                    {"player_id": None, "name": rp.player_name, "jersey_number": None, "position": None}
                )
    return result


def effective_roster_names_for_quiz(quiz: Quiz, active_code: AccessCode | None) -> list[str]:
    """Same "who's eligible" rule as `effective_roster_names`, generalized
    for callers that show a roster-size stat per quiz rather than per
    activation (the dashboard's quiz-card list, the Results tab) - they
    don't have one specific access code in hand, just whichever one (if
    any) is currently active for the quiz. `active_code` is that code, or
    None if the quiz has never been activated or its code has since been
    deactivated/expired; either way this falls back to the quiz's own
    Roster, exactly like `effective_roster_names` does for a code with no
    linked groups.
    """
    if active_code is not None:
        return effective_roster_names(active_code)
    return [p.player_name for p in (quiz.roster.players if quiz.roster else [])]
