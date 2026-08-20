"""Organization invite code generation and lookup.

Deliberately NOT reusing `services/access_codes.py::generate_unique_code()`.
Player access codes are 6 characters from a 31-character alphabet because a
player types them in by hand from a sideline card; that's a reasonable
trade-off for a code that only unlocks one quiz for 24 hours. An invite code
grants standing access to an entire organization's data and arrives as a
clickable link, so there's no typability constraint to trade entropy
against - use a full-strength token instead.
"""

import secrets
from datetime import datetime, timezone

from sqlalchemy import update as sa_update

from app.extensions import db
from app.models import OrganizationInvite

INVITE_TTL_DAYS = 14


def generate_invite_code() -> str:
    while True:
        candidate = secrets.token_urlsafe(32)
        if OrganizationInvite.query.filter_by(code=candidate).first() is None:
            return candidate


def find_usable_invite(code: str) -> OrganizationInvite | None:
    """An invite that can still be accepted: not revoked, not already used,
    not expired. Returns None for every failure so callers can emit a single
    generic error rather than distinguishing the cases for an attacker."""
    normalized = (code or "").strip()
    if not normalized:
        return None
    invite = OrganizationInvite.query.filter_by(code=normalized).first()
    if invite is None or not invite.is_usable():
        return None
    return invite


def claim(invite: OrganizationInvite, coach_id: int) -> bool:
    """Accept this invite for `coach_id`. True if this call is the one that won.

    A CONDITIONAL UPDATE, NOT A READ-THEN-WRITE. `find_usable_invite` above
    reads; assigning `accepted_at` afterwards let two requests holding the same
    link both pass the read and both succeed - the invite was accepted twice
    and `accepted_by_coach_id` recorded whichever committed last. A single-use
    invitation that admits two people to an organization's data is the failure
    that matters here, not the bookkeeping.

    The `WHERE accepted_at IS NULL` makes the database the arbiter and
    `rowcount` reports who won. A caller that loses MUST abandon the signup -
    rolling back the coach it was about to create - rather than continuing with
    an account no invitation paid for.

    Deliberately the same shape as services/beta_invites.redeem: two invite
    types, one rule about claiming them.
    """
    now = datetime.now(timezone.utc)
    # The WHERE mirrors `is_usable` exactly - accepted, revoked and expired -
    # so `claim` is self-sufficient rather than trusting that its caller looked
    # first. A guard that only re-checks some of the conditions is worse than
    # none, because it reads as though it covers them all.
    result = db.session.execute(
        sa_update(OrganizationInvite)
        .where(
            OrganizationInvite.id == invite.id,
            OrganizationInvite.accepted_at.is_(None),
            OrganizationInvite.is_revoked.is_(False),
            OrganizationInvite.expires_at > now,
        )
        .values(accepted_at=now, accepted_by_coach_id=coach_id)
    )
    return result.rowcount == 1
