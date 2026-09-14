"""The private per-attempt token. PHASE 2: ISSUED, VALIDATED - NOT YET REQUIRED.

WHY A TOKEN AT ALL. A PIN proves who a player is, but asking for it on every
autosave would be unusable. So a correct PIN buys a token for ONE attempt, and
the device that holds it continues that attempt without being asked again.

WHAT MUST STAY TRUE
-------------------
* The raw token is 32 bytes from `secrets` (256 bits). It is returned to the
  player's device once, when issued, and never stored, logged or put in a URL.
* Only its SHA-256 is stored. Not bcrypt: bcrypt exists to slow down guessing
  something a human chose, and nobody guesses 256 random bits - hashing here
  only has to make a stolen database row useless, which SHA-256 does, in
  microseconds, on every autosave.
* A token belongs to exactly one attempt. It is checked against that attempt's
  own row, so a token for attempt A can never authenticate attempt B.
* A token carries the player's `pin_version` at issue. A coach resetting the
  PIN bumps the version, which revokes every token issued under the old PIN
  without touching a single attempt.
* Issuing a new token for an attempt REPLACES the old hash. That is what makes
  a PIN reclaim on a new device sign the old device out.

NOTHING READS THIS FOR AUTHORIZATION YET. Phase 3 wires `check_request` into the
player routes. Until then every existing route works exactly as it did.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone

from flask import request

from app.models import PlayerAttempt, PlayerCredential

#: Matches the existing player-token convention, `X-Competition-Token`. A
#: header rather than a body field or query string, so it never lands in a URL,
#: an access log line, or a request body a client might echo back.
TOKEN_HEADER = "X-Attempt-Token"

TOKEN_BYTES = 32

# Why a token did or did not check out. Distinct server-side so Phase 3 can
# decide what each should mean to a player; how much of this a CLIENT is ever
# told is a separate decision, deliberately not made here.
VALID = "valid"
MISSING = "missing"
#: Tokens do not apply: a legacy free-text attempt has no player to own one.
LEGACY_ATTEMPT = "legacy_attempt"
#: This attempt has never had a token issued (created without a PIN).
NOT_ISSUED = "not_issued"
#: Not this attempt's current token. Deliberately covers BOTH a forged token
#: and one superseded by a reclaim: telling them apart would mean keeping old
#: token hashes, and a device that held a working token already knows it was
#: moved.
MISMATCH = "mismatch"
#: The right token, issued under a PIN the coach has since reset.
REVOKED = "revoked"
#: The token matches but the player no longer has a credential at all.
NO_CREDENTIAL = "no_credential"


@dataclass(frozen=True)
class TokenCheck:
    status: str

    @property
    def ok(self) -> bool:
        return self.status == VALID


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def issue_token(attempt: PlayerAttempt, pin_version: int, now: datetime | None = None) -> str:
    """Issue (or replace) this attempt's token and return the raw value.

    Does not commit - the caller owns the transaction. Replacing is the point:
    the previous token for this attempt stops validating the moment this
    commits.
    """
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    attempt.token_hash = hash_token(raw)
    attempt.token_pin_version = pin_version
    attempt.token_issued_at = now or datetime.now(timezone.utc)
    return raw


def check_token(attempt: PlayerAttempt, raw: str | None, player_id: int | None = None) -> TokenCheck:
    """Does `raw` authenticate THIS attempt, right now?

    `player_id`, when given, must also be the attempt's player - a belt to the
    braces of the hash already being this attempt's own.
    """
    if attempt.player_id is None:
        return TokenCheck(LEGACY_ATTEMPT)
    if not raw or not raw.strip():
        return TokenCheck(MISSING)
    if attempt.token_hash is None:
        return TokenCheck(NOT_ISSUED)
    if player_id is not None and player_id != attempt.player_id:
        return TokenCheck(MISMATCH)
    # Constant-time: the comparison must not reveal how much of a guess matched.
    if not hmac.compare_digest(hash_token(raw.strip()), attempt.token_hash):
        return TokenCheck(MISMATCH)
    credential_version = (
        PlayerCredential.query.with_entities(PlayerCredential.pin_version)
        .filter_by(player_id=attempt.player_id)
        .scalar()
    )
    if credential_version is None:
        return TokenCheck(NO_CREDENTIAL)
    if attempt.token_pin_version != credential_version:
        return TokenCheck(REVOKED)
    return TokenCheck(VALID)


def token_from_request() -> str | None:
    value = (request.headers.get(TOKEN_HEADER) or "").strip()
    return value or None


def check_request(attempt: PlayerAttempt, player_id: int | None = None) -> TokenCheck:
    """`check_token` against the token this request carried. Phase 3's hook."""
    return check_token(attempt, token_from_request(), player_id)
