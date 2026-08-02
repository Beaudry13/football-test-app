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
