"""Player PIN enforcement - PHASE 3A: cutover configuration, secured codes, and
authorizing player writes.

OFF BY DEFAULT, AND OFF MEANS EXACTLY PHASE 2. With PLAYER_PIN_ENFORCEMENT
unset, `authorize_player_write` returns the attempt untouched without locking
or reading anything, and every player route behaves as it did before this file
existed. The player impersonation vulnerability is NOT closed by this slice.

THE SWITCH IS TEMPORARY. It exists for a controlled cutover and an emergency
rollback during the compatibility window, and is removed in Phase 4 once hard
cutover is proven. It is not a permanent way to run without player security.

SECURED CODES
-------------
A code is SECURED when enforcement is on AND
  * it was activated at or after PLAYER_PIN_CUTOVER_AT, OR
  * the clock has passed PLAYER_PIN_COMPAT_UNTIL.
`activated_at`, never `expires_at`: a coach can extend a code's expiry, and
that must never extend its exemption. Codes cannot be reactivated, so the
activation time is fixed for the life of the code.

OLD CODES DURING THE WINDOW
---------------------------
A code activated before cutover, used before COMPAT_UNTIL, is not secured - but
a canonical attempt under it still requires its token when either:
  * the attempt has ever been issued a token (once tokened, always tokened), or
  * the player has a PIN (a credential that exists is a credential that is
    required).
Only a never-tokened attempt of a player without a PIN writes without a token.

LEGACY FREE-TEXT ATTEMPTS (player_id IS NULL) never require a token: there is
no player to own one. The name-only fences are Phase 3b.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import current_app

from app.errors import ApiError
from app.extensions import db
from app.models import PlayerAttempt, PlayerCredential
from app.services import attempt_tokens

# The attempt row lock lives with the other /play attempt lookups in
# services/attempts.py, and is re-exported here for the routes that authorize.
from app.services.attempts import lock_attempt  # noqa: F401

#: The longest compatibility window the configuration will accept. Old codes
#: must not keep an open-ended exemption.
MAX_COMPAT_WINDOW = timedelta(days=14)


class EnforcementConfigError(RuntimeError):
    """Enforcement is on and the cutover configuration cannot be trusted.

    Raised at startup so a bad deploy fails loudly rather than booting with
    security silently half-configured."""


@dataclass(frozen=True)
class EnforcementSettings:
    enabled: bool
    cutover_at: datetime | None = None
    compat_until: datetime | None = None


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _aware(name: str, raw) -> datetime:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raise EnforcementConfigError(f"{name} is required when PLAYER_PIN_ENFORCEMENT is on.")
    if isinstance(raw, datetime):
        value = raw
    else:
        try:
            value = datetime.fromisoformat(str(raw).strip())
        except ValueError as exc:
            raise EnforcementConfigError(
                f"{name} must be an ISO 8601 timestamp, got {raw!r}."
            ) from exc
    if value.tzinfo is None or value.utcoffset() is None:
        raise EnforcementConfigError(
            f"{name} must include a timezone (for example 2026-10-01T06:00:00+00:00), got {raw!r}."
        )
    return value


def parse_settings(config) -> EnforcementSettings:
    """Read and validate the enforcement configuration.

    With enforcement off the dates are not read at all, so their absence (or a
    placeholder) can never stop the app starting.
    """
    if not _truthy(config.get("PLAYER_PIN_ENFORCEMENT", False)):
        return EnforcementSettings(enabled=False)
    cutover = _aware("PLAYER_PIN_CUTOVER_AT", config.get("PLAYER_PIN_CUTOVER_AT"))
    compat = _aware("PLAYER_PIN_COMPAT_UNTIL", config.get("PLAYER_PIN_COMPAT_UNTIL"))
    if compat <= cutover:
        raise EnforcementConfigError("PLAYER_PIN_COMPAT_UNTIL must be after PLAYER_PIN_CUTOVER_AT.")
    if compat - cutover > MAX_COMPAT_WINDOW:
        raise EnforcementConfigError(
            "The compatibility window (PLAYER_PIN_CUTOVER_AT to PLAYER_PIN_COMPAT_UNTIL) "
            f"may not exceed {MAX_COMPAT_WINDOW.days} days."
        )
    return EnforcementSettings(enabled=True, cutover_at=cutover, compat_until=compat)


def validate_config(config) -> None:
    """Startup hook: raises EnforcementConfigError on an unusable configuration."""
    parse_settings(config)


def current_settings() -> EnforcementSettings:
    return parse_settings(current_app.config)


def is_code_secured(
    access_code, *, now: datetime | None = None, settings: EnforcementSettings | None = None
) -> bool:
    settings = settings or current_settings()
    if not settings.enabled:
        return False
    now = now or datetime.now(timezone.utc)
    return access_code.activated_at >= settings.cutover_at or now >= settings.compat_until


# ---------------------------------------------------------------------------
# The authentication error contract
# ---------------------------------------------------------------------------
#
# One shape everywhere: {"error": <plain message>, "reason": <code>}. Missing,
# invalid and "PIN required" deliberately share a message - the reason code is
# for the client to branch on, and the words give an unauthenticated caller
# nothing to learn from. `attempt_moved` is NOT a server reason: the server
# keeps no old token hashes, so only a device that held a working token can
# know its attempt moved.

TOKEN_MISSING = "token_missing"
TOKEN_INVALID = "token_invalid"
TOKEN_REVOKED = "token_revoked"
PIN_REQUIRED = "pin_required"

_AUTH_MESSAGES = {
    TOKEN_MISSING: "Enter your PIN to continue.",
    TOKEN_INVALID: "Enter your PIN to continue.",
    PIN_REQUIRED: "Enter your PIN to continue.",
    TOKEN_REVOKED: "Your PIN was changed. Enter your new PIN to continue.",
}

#: token_revoked ONLY for a token whose hash matched the attempt but whose
#: pin_version is stale - i.e. only its legitimate former holder can learn that a
#: PIN was reset. Everything else that fails is the generic token_invalid.
_REASON_FOR_TOKEN_STATUS = {
    attempt_tokens.MISSING: TOKEN_MISSING,
    attempt_tokens.NOT_ISSUED: TOKEN_INVALID,
    attempt_tokens.MISMATCH: TOKEN_INVALID,
    attempt_tokens.NO_CREDENTIAL: TOKEN_INVALID,
    attempt_tokens.REVOKED: TOKEN_REVOKED,
}


def auth_error(reason: str) -> ApiError:
    return ApiError(_AUTH_MESSAGES[reason], status_code=401, reason=reason)


def token_refusal(check: attempt_tokens.TokenCheck) -> ApiError:
    return auth_error(_REASON_FOR_TOKEN_STATUS.get(check.status, TOKEN_INVALID))


# ---------------------------------------------------------------------------
# Authorizing a player write
# ---------------------------------------------------------------------------


def _player_has_credential(player_id: int) -> bool:
    return db.session.query(
        db.exists().where(PlayerCredential.player_id == player_id)
    ).scalar()


def token_required(
    access_code, attempt: PlayerAttempt, *, now: datetime | None = None,
    settings: EnforcementSettings | None = None,
) -> bool:
    settings = settings or current_settings()
    if attempt.player_id is None or not settings.enabled:
        return False
    if is_code_secured(access_code, now=now, settings=settings):
        return True
    if attempt.token_hash is not None:
        return True
    return _player_has_credential(attempt.player_id)


def authorize_player_write(access_code, attempt: PlayerAttempt) -> PlayerAttempt:
    """Return the attempt a player write may proceed through, or raise 401.

    Enforcement off, or a legacy free-text attempt: the attempt comes back
    exactly as given - no lock, no query, no behaviour change.

    Otherwise the attempt row is LOCKED first, and the token decision and check
    are made against that locked row, so nothing can rotate the token between
    the check and the write. The caller must use the returned attempt and
    commit (or roll back) to release the lock.
    """
    if attempt.player_id is None:
        return attempt
    settings = current_settings()
    if not settings.enabled:
        return attempt
    locked = lock_attempt(attempt.id)
    if not token_required(access_code, locked, settings=settings):
        return locked
    check = attempt_tokens.check_request(locked, locked.player_id)
    if not check.ok:
        db.session.rollback()
        raise token_refusal(check)
    return locked
