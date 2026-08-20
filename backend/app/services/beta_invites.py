"""Issuing and redeeming beta invitations.

THE TOKEN FORMAT, AND WHY IT IS NOT SIX CHARACTERS
---------------------------------------------------
    PEIRA-XXXX-XXXX-XXXX

Twelve characters from a 32-character alphabet - about 60 bits. A player's
quiz access code is six characters because a fourteen-year-old types it off a
whiteboard for a code that unlocks one quiz for a day; that trade does not
transfer to a token which creates an ACCOUNT. This one is normally clicked as
a link and only occasionally read aloud, so it can afford real entropy and
still be sayable in three short groups.

The alphabet excludes I, L, O, U, 0 and 1: read down a phone line, those are
the characters that get written wrong. `normalise` maps the common confusions
back, so a coach who writes O for 0 is not told their invite is invalid.

WHY LOOKUP IS BY HASH
---------------------
Only the SHA-256 is stored (see models/beta_invite.py), so the lookup hashes
the candidate and matches on that. This is also constant-time by construction:
the comparison happens inside the database on a fixed-width digest, and there
is no branch on how much of the token matched.
"""

from __future__ import annotations

import hashlib
import secrets

from sqlalchemy import update as sa_update

from app.extensions import db
from app.models.beta_invite import BetaInvite

#: No I, L, O, U, 0 or 1 - the characters that get misheard or miswritten.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
GROUPS = 3
GROUP_LENGTH = 4
PREFIX = "PEIRA"

#: What a coach is told when a token does not work, whatever the reason.
#: ONE MESSAGE FOR EVERY FAILURE - unknown, revoked and already-redeemed are
#: indistinguishable from outside, so a guessed token cannot be probed to learn
#: which invites exist. The owner can see the real state; the internet cannot.
INVALID_INVITE = "That invite code is not valid."

#: Read-aloud confusions, mapped back before lookup.
_CONFUSIONS = str.maketrans({"O": "0", "0": "O", "I": "1", "1": "I", "L": "I", "U": "V"})


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def format_token(raw: str) -> str:
    groups = [raw[i : i + GROUP_LENGTH] for i in range(0, len(raw), GROUP_LENGTH)]
    return "-".join([PREFIX, *groups])


def normalise(candidate: str) -> str:
    """Whatever the coach typed, as the token we would have issued.

    Case, spaces, the PEIRA prefix and the group dashes are all presentation.
    A coach reading one off a text message should not fail because they typed
    it in lower case or left the dashes out.
    """
    cleaned = (candidate or "").strip().upper().replace(" ", "").replace("-", "")
    if cleaned.startswith(PREFIX):
        cleaned = cleaned[len(PREFIX) :]
    return cleaned


def _canonical_variants(cleaned: str) -> list[str]:
    """The typed value, plus the one a misheard character would have produced.

    Only two candidates are ever checked, so this cannot become a way to
    brute-force by submitting near-misses.
    """
    swapped = cleaned.translate(_CONFUSIONS)
    return [cleaned] if swapped == cleaned else [cleaned, swapped]


def issue(label: str | None = None, created_by_coach_id: int | None = None) -> tuple[BetaInvite, str]:
    """Create an invite and return it WITH its plaintext token.

    The token is returned exactly once, here. Nothing stores it, so this
    return value is the only chance to show it to the person who will send it
    on - which is why the caller gets a tuple rather than just the row.
    """
    raw = "".join(secrets.choice(ALPHABET) for _ in range(GROUPS * GROUP_LENGTH))
    invite = BetaInvite(
        token_hash=_digest(raw),
        token_prefix=raw[:GROUP_LENGTH],
        label=(label or "").strip() or None,
        created_by_coach_id=created_by_coach_id,
    )
    db.session.add(invite)
    db.session.commit()
    return invite, format_token(raw)


def find_usable(candidate: str) -> BetaInvite | None:
    """An invite that can still be redeemed, or None for every failure.

    None covers unknown, revoked and already-redeemed alike - see
    INVALID_INVITE. Callers must not distinguish them to the outside.
    """
    cleaned = normalise(candidate)
    if not cleaned:
        return None
    for variant in _canonical_variants(cleaned):
        invite = BetaInvite.query.filter_by(token_hash=_digest(variant)).first()
        if invite is not None and invite.is_usable():
            return invite
    return None


def redeem(invite: BetaInvite, coach_id: int) -> bool:
    """Claim this invite for `coach_id`. True if this call is the one that won.

    A CONDITIONAL UPDATE, NOT A READ-THEN-WRITE, and that is the whole point of
    this function. Checking `is_usable()` and then assigning would let two
    requests holding the same link both pass the check and both succeed - the
    invite would be redeemed twice and the record of who used it would be
    whichever committed last. The `WHERE redeemed_at IS NULL` makes the
    database the arbiter, and `rowcount` reports who won.

    Callers MUST treat False as "this invite is already gone" and abandon the
    signup, rather than continuing with an account that no invite paid for.
    """
    result = db.session.execute(
        sa_update(BetaInvite)
        .where(
            BetaInvite.id == invite.id,
            BetaInvite.redeemed_at.is_(None),
            BetaInvite.revoked_at.is_(None),
        )
        .values(redeemed_at=BetaInvite.now(), redeemed_by_coach_id=coach_id)
    )
    return result.rowcount == 1


def revoke(invite: BetaInvite) -> bool:
    """Stop an invite being used. True if this call revoked it.

    Redeeming and revoking race the same way, so this is conditional for the
    same reason: an invite that was redeemed a moment ago must not be recorded
    as revoked, or the history would say it was cancelled when it was used.
    """
    result = db.session.execute(
        sa_update(BetaInvite)
        .where(
            BetaInvite.id == invite.id,
            BetaInvite.redeemed_at.is_(None),
            BetaInvite.revoked_at.is_(None),
        )
        .values(revoked_at=BetaInvite.now())
    )
    return result.rowcount == 1
