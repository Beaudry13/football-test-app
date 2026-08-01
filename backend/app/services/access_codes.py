"""Access code generation and lookup.

Codes are short, uppercase, and avoid visually ambiguous characters
(0/O, 1/I/L) since players type them in by hand from a screen or sideline card.
"""

import random
import string
from datetime import datetime, timezone

from app.models import AccessCode

CODE_ALPHABET = "".join(sorted(set(string.ascii_uppercase + string.digits) - set("0O1IL")))
CODE_LENGTH = 6


def generate_unique_code() -> str:
    while True:
        candidate = "".join(random.choices(CODE_ALPHABET, k=CODE_LENGTH))
        if AccessCode.query.filter_by(code=candidate).first() is None:
            return candidate


def find_valid_access_code(code: str) -> AccessCode | None:
    normalized = code.strip().upper()
    access_code = AccessCode.query.filter_by(code=normalized).first()
    if access_code is None or not access_code.is_valid():
        return None
    return access_code


def expire_stale_codes(quiz_id: int) -> None:
    """Mark any access codes for this quiz as inactive once they've passed expiry."""
    now = datetime.now(timezone.utc)
    stale = AccessCode.query.filter(
        AccessCode.quiz_id == quiz_id,
        AccessCode.is_active.is_(True),
        AccessCode.expires_at <= now,
    )
    stale.update({"is_active": False}, synchronize_session=False)
