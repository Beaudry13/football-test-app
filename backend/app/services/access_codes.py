"""Access code generation and lookup.

Codes are short, uppercase, and avoid visually ambiguous characters
(0/O, 1/I/L) since players type them in by hand from a screen or sideline card.
"""

import secrets
import string
from datetime import datetime, timezone

from app.extensions import db
from app.models import AccessCode, Player, Quiz

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
    "position", "photo_url"}` per eligible player. A canonical entry's
    `name` is always the Player's *current* full_name (fresh, not a stale
    snapshot); a legacy entry (player_id None) is whatever the coach typed
    on the Roster/Group, with jersey_number/position/photo_url all None
    (nothing else to show for it).

    jersey_number/position/photo_url are included specifically so the
    frontend can tell two canonical Players who share a display name apart
    at a glance (e.g. two "Chris Smith"s) - `name` alone can't, and
    player_id isn't human-readable. The plain string list from
    effective_roster_names() can't represent any of this, which is why it
    stays unchanged for existing callers rather than being replaced
    outright.
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
                            "photo_url": player.player.photo_url,
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
                            "photo_url": None,
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
                    "photo_url": rp.player.photo_url,
                }
            )
        else:
            if rp.player_name.lower() not in seen_names:
                seen_names.add(rp.player_name.lower())
                result.append(
                    {
                        "player_id": None,
                        "name": rp.player_name,
                        "jersey_number": None,
                        "position": None,
                        "photo_url": None,
                    }
                )
    return result


def selectable_players_for_code(access_code: AccessCode) -> list[dict]:
    """WHO MAY IDENTIFY THEMSELVES against this code, for the name picker.

    Deliberately NOT the same question as `effective_roster_players`, which
    answers "who may BEGIN" and is what /play/start gates a new attempt on.
    This is the display set, and it is the union of two different kinds of
    authority:

      LIVE ELIGIBILITY - an active player currently in a linked group (or on
      the quiz's own roster). Groups stay live distribution lists, so somebody
      added after the quiz went out appears here immediately.

      AN ATTEMPT THAT ALREADY EXISTS - proof enough on its own, exactly as
      /play/start now treats it. A player removed from every linked group, or
      since deactivated, must still be able to point at their own name and
      finish what they started; the alternative is work the server would
      happily accept but the player can no longer reach.

    INACTIVE PLAYERS ARE DROPPED UNLESS THEY HOLD AN ATTEMPT. Deactivation is
    a coach saying "not on the team", which decides what happens next - so
    they are not offered a new start, but they are never stranded mid-quiz.

    IDENTITY IS NEVER INVENTED HERE. Canonical entries dedupe on player_id, so
    two people who share a display name stay two rows and one can never be
    offered the other's attempt; a legacy attempt (player_id NULL) is listed
    under its own recorded name with player_id still NULL, and is not upgraded
    into a canonical player by appearing in this list. Both keys match the ones
    `effective_roster_players` already uses, so a player who is both live and
    mid-attempt appears exactly once.
    """
    entries = effective_roster_players(access_code)
    by_key: dict[str, dict] = {}
    for entry in entries:
        key = (
            f"player:{entry['player_id']}"
            if entry["player_id"] is not None
            else f"name:{entry['name'].lower()}"
        )
        by_key[key] = entry

    # Imported here rather than at module scope: attempts.py imports nothing
    # from this module today, and a top-level import would create the cycle.
    from app.services.attempts import identities_with_attempts

    attempts = identities_with_attempts(access_code.id)
    holds_attempt = {
        (f"player:{pid}" if pid is not None else f"name:{name.lower()}")
        for pid, name in attempts
    }

    # An inactive player with nothing underway is not offered a start. Read
    # through the linked Player, so a legacy free-text entry - which has no
    # activity flag to consult - is left exactly as it was.
    for key, entry in list(by_key.items()):
        if entry["player_id"] is None or key in holds_attempt:
            continue
        player = db.session.get(Player, entry["player_id"])
        if player is not None and not player.is_active:
            del by_key[key]

    for attempt_player_id, attempt_player_name in attempts:
        if attempt_player_id is not None:
            key = f"player:{attempt_player_id}"
            if key in by_key:
                continue
            player = db.session.get(Player, attempt_player_id)
            by_key[key] = {
                "player_id": attempt_player_id,
                # The player's CURRENT name, matching how a live canonical
                # entry is rendered - the attempt's own player_name is a
                # snapshot of what they were called when they started, and is
                # left untouched.
                "name": player.full_name if player is not None else attempt_player_name,
                "jersey_number": player.jersey_number if player is not None else None,
                "position": player.position if player is not None else None,
                "photo_url": player.photo_url if player is not None else None,
            }
        else:
            key = f"name:{attempt_player_name.lower()}"
            if key in by_key:
                continue
            by_key[key] = {
                "player_id": None,
                "name": attempt_player_name,
                "jersey_number": None,
                "position": None,
                "photo_url": None,
            }

    return list(by_key.values())


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
