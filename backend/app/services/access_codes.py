"""Access code generation and lookup.

Codes are short, uppercase, and avoid visually ambiguous characters
(0/O, 1/I/L) since players type them in by hand from a screen or sideline card.
"""

import secrets
import string
from datetime import datetime, timezone

from app.models import AccessCode

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
