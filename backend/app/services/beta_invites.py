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
from datetime import timedelta

from sqlalchemy import update as sa_update

from app.extensions import db
from app.models.beta_invite import BetaInvite
from app.services import invite_secrets

#: No I, L, O, U, 0 or 1 - the characters that get misheard or miswritten.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
GROUPS = 3
GROUP_LENGTH = 4
PREFIX = "PEIRA"

#: How long a new invite stays spendable. An invitation is a live grant to
#: create an account, so one that is mislaid or forwarded should stop working
#: without the owner having to remember to revoke it. A week is long enough for
#: a coach to get to it and short enough that a stale link is not a standing
#: hole; the owner can always issue another.
DEFAULT_EXPIRY_DAYS = 7

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


def issue(
    label: str | None = None,
    created_by_coach_id: int | None = None,
    expires_in_days: int | None = DEFAULT_EXPIRY_DAYS,
) -> tuple[BetaInvite, str]:
    """Create an invite and return it WITH its plaintext token.

    The token is returned exactly once, here. Nothing stores it, so this
    return value is the only chance to show it to the person who will send it
    on - which is why the caller gets a tuple rather than just the row.

    `expires_in_days=None` issues one that never expires. Not offered in the
    owner UI, but kept so the CLI can still cut a long-lived invite
    deliberately rather than by forgetting.
    """
    raw = "".join(secrets.choice(ALPHABET) for _ in range(GROUPS * GROUP_LENGTH))
    invite = BetaInvite(
        token_hash=_digest(raw),
        token_prefix=raw[:GROUP_LENGTH],
        label=(label or "").strip() or None,
        created_by_coach_id=created_by_coach_id,
        # ENCRYPTED SO THE OWNER CAN RESHARE THE SAME CODE. None whenever no
        # key is configured, which leaves the invite fully working and simply
        # not re-readable - see services/invite_secrets.
        token_ciphertext=invite_secrets.encrypt(format_token(raw)),
        expires_at=(
            BetaInvite.now() + timedelta(days=expires_in_days)
            if expires_in_days is not None
            else None
        ),
    )
    db.session.add(invite)
    db.session.commit()
    return invite, format_token(raw)


def reveal(invite: BetaInvite) -> str | None:
    """The original code for a PENDING invite, or None if it cannot be read.

    None covers every honest failure: an invite issued before ciphertext
    existed, a deployment with no key, a key that has been rotated, and a
    corrupt value. The caller must tell the owner the code cannot be recovered
    and offer to replace it - never guess, and never imply the original could
    be reconstructed.

    REFUSES ANYTHING NOT PENDING. A redeemed or revoked invite has had its
    ciphertext cleared already, and an expired one is not a live grant - so
    there is nothing worth handing back and no reason to.
    """
    if not invite.is_usable():
        return None
    return invite_secrets.decrypt(invite.token_ciphertext)


def replace_token(invite: BetaInvite) -> str | None:
    """Give a PENDING invite a brand new code, keeping the row.

    FOR AN INVITE WHOSE CODE CANNOT BE RECOVERED - one issued before this
    existed, or under a key that is gone. The alternative was revoke-and-create,
    which loses the label, the created date and the record of who issued it;
    keeping the row keeps the audit trail and the owner's own note about who it
    was for.

    THE PREVIOUS CODE STOPS WORKING, immediately and by construction: its hash
    is overwritten, so nothing can match it any more. That is acceptable here
    precisely because this is only offered where the previous code is already
    lost to the owner - it is not a way to rotate a code somebody is holding.

    Conditional on the invite still being open, so replacing one that was
    redeemed a moment ago fails rather than resurrecting it.
    """
    raw = "".join(secrets.choice(ALPHABET) for _ in range(GROUPS * GROUP_LENGTH))
    token = format_token(raw)
    result = db.session.execute(
        sa_update(BetaInvite)
        .where(*_still_open(invite.id))
        .values(
            token_hash=_digest(raw),
            token_prefix=raw[:GROUP_LENGTH],
            token_ciphertext=invite_secrets.encrypt(token),
        )
    )
    return token if result.rowcount == 1 else None


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


def _still_open(invite_id: int):
    """The WHERE clause shared by redeem and revoke.

    Spelled once because the two must agree about what "still open" means: an
    invite that expired between the lookup and the write must not be claimable
    by either, and letting the two drift would mean one of them could act on an
    invite the other considers dead.
    """
    return (
        BetaInvite.id == invite_id,
        BetaInvite.redeemed_at.is_(None),
        BetaInvite.revoked_at.is_(None),
        db.or_(BetaInvite.expires_at.is_(None), BetaInvite.expires_at > BetaInvite.now()),
    )


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
        .where(*_still_open(invite.id))
        # CLEARED IN THE SAME STATEMENT that spends it. Doing it as a separate
        # write would leave a window where a redeemed invitation still had a
        # recoverable code, and a failure between the two would leave that
        # window open permanently.
        .values(
            redeemed_at=BetaInvite.now(),
            redeemed_by_coach_id=coach_id,
            token_ciphertext=None,
        )
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
        # Revoking an EXPIRED invite is allowed to fail for the same reason
        # revoking a redeemed one does: it is already over, and recording a
        # decision to end something that ended on its own would misstate why.
        .where(*_still_open(invite.id))
        # Same statement, same reason as redeem: an invitation the owner has
        # called off must not keep a readable code.
        .values(revoked_at=BetaInvite.now(), token_ciphertext=None)
    )
    return result.rowcount == 1
