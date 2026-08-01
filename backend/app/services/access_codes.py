"""Access code generation and lookup.

Codes are short, uppercase, and avoid visually ambiguous characters
(0/O, 1/I/L) since players type them in by hand from a screen or sideline card.
"""

import secrets
import string

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


def find_valid_access_code(code: str) -> AccessCode | None:
    normalized = code.strip().upper()
    access_code = AccessCode.query.filter_by(code=normalized).first()
    if access_code is None or not access_code.is_valid():
        return None
    return access_code


def find_access_code_by_code(code: str) -> AccessCode | None:
    """Like `find_valid_access_code`, but doesn't gate on expiry/deactivation.

    For looking up a player's already-submitted results after the code has
    expired - the join/submit flow should still reject an expired code, but
    a response that was already recorded under it should stay reviewable.
    """
    normalized = code.strip().upper()
    return AccessCode.query.filter_by(code=normalized).first()
