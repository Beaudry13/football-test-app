"""Issuing and resetting player PINs. Coach-side only in Phase 1.

THE RULES THIS FILE HOLDS
-------------------------
* A PIN is 6 random digits from `secrets`, never a guessable pattern.
* Only a bcrypt hash is stored. The raw PIN exists in memory for exactly as
  long as it takes to hash it and hand it back to the coach who asked - it is
  never logged, never persisted, and never recoverable afterwards.
* "Generate missing" NEVER replaces a PIN. A coach who has already handed out
  PINs must not have them silently invalidated by clicking the same button
  again; replacing one is always the explicit, per-player reset.
* A reset changes the credential and nothing else. It does not delete, reset
  or alter any attempt. It bumps `pin_version`, which is how Phase 2 will
  invalidate tokens issued under the old PIN.
* PINs are not unique across players and must not be: a PIN is only ever
  checked against ONE player, and enforcing uniqueness would mean comparing
  a new PIN against every other player's - which is exactly the kind of
  cross-player lookup a credential must never support.

NOT HERE YET: verifying a PIN on behalf of a player, and throttling wrong
guesses. That is Phase 2, and it will wrap `pin_matches` rather than expose it.
"""

from __future__ import annotations

import math
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import current_app
from sqlalchemy.dialects.postgresql import insert

from app.extensions import bcrypt, db
from app.models import Player, PlayerCredential

PIN_LENGTH = 6

#: How many PINs one "generate missing" request issues. Each costs one bcrypt
#: hash (~90ms at cost 10, measured locally, and Render is slower), and
#: production serves every request from one process. A 120-player roster in a
#: single request would sit near gunicorn's 30-second timeout; in batches the
#: coach's browser simply asks again until nothing is left.
GENERATE_BATCH_LIMIT = 25

PIN_SET = "set"
PIN_MISSING = "missing"
PIN_LOCKED = "locked"


def is_weak_pin(pin: str) -> bool:
    """A PIN a teammate would try first.

    Refused: anything not exactly six digits; one digit repeated (000000);
    a straight run up or down (123456, 987654); and a short block repeated
    (121212, 123123). Deliberately a short, explainable list rather than a
    clever one - every rejection shrinks the space a little, and six digits
    only stay strong while that space stays close to a million.
    """
    if len(pin) != PIN_LENGTH or not pin.isdigit():
        return True
    if len(set(pin)) == 1:
        return True
    steps = {int(pin[i + 1]) - int(pin[i]) for i in range(PIN_LENGTH - 1)}
    if steps == {1} or steps == {-1}:
        return True
    for block in (2, 3):
        if pin == pin[:block] * (PIN_LENGTH // block):
            return True
    return False


def generate_pin(randbelow=secrets.randbelow) -> str:
    """Six uniformly random digits that are not a weak pattern.

    `randbelow` is injectable ONLY so a test can force a weak draw and prove it
    is rejected; production always uses the OS CSPRNG.
    """
    while True:
        pin = "".join(str(randbelow(10)) for _ in range(PIN_LENGTH))
        if not is_weak_pin(pin):
            return pin


def hash_pin(pin: str) -> str:
    """bcrypt at the PIN's OWN cost, `PIN_BCRYPT_ROUNDS` - never the coach
    password setting, which is tuned for a login a coach does twice a day
    rather than a check a whole team does in the same minute."""
    rounds = current_app.config["PIN_BCRYPT_ROUNDS"]
    return bcrypt.generate_password_hash(pin, rounds).decode("utf-8")


def pin_matches(pin_hash: str, pin: str) -> bool:
    """Constant-time bcrypt comparison.

    NOT AN AUTHORIZATION PATH. It applies no throttling. Phase 2's player-side
    verification must go through a throttled wrapper, never call this directly.
    """
    return bcrypt.check_password_hash(pin_hash, pin)


# ---------------------------------------------------------------------------
# Verifying a player's PIN, with throttling (Phase 2)
# ---------------------------------------------------------------------------
#
# PER PLAYER, NEVER PER IP. A whole team shares one address on facility Wi-Fi,
# and behind Render's proxy the address is not reliably the player's anyway.
# Every counter lives on the player's own credential row.
#
# THE RULES (locked in the design addendum):
#   * the first 5 wrong PINs cost nothing;
#   * each further wrong PIN makes the NEXT check wait - 1 minute, doubling, to
#     at most 15 minutes;
#   * an hour with no wrong PIN clears the run;
#   * 50 wrong PINs within the credential's CURRENT 24-hour failure window
#     lock it until a coach resets it (see HARD_LOCK_WINDOW - a FIXED window);
#   * during a wait, even the CORRECT PIN is refused - otherwise the refusal
#     itself would tell a guesser when they had found it;
#   * a device already holding a valid attempt token never reaches this.
#
# NO NEW COLUMNS. `next_attempt_at` is always "last wrong PIN + the wait that
# failure earned" (the wait is zero for the free ones), so the time of the last
# failure is recoverable from it exactly. That is what "an hour with no
# failures" and "free failures age out" are measured from.

FREE_FAILURES = 5
#: Free failures stop counting once this long has passed since the last one.
FREE_FAILURE_WINDOW = timedelta(minutes=15)
FIRST_WAIT = timedelta(minutes=1)
MAX_WAIT = timedelta(minutes=15)
#: An hour with no wrong PIN clears the whole run, cooldowns included.
QUIET_RESET = timedelta(hours=1)
HARD_LOCK_FAILURES = 50
#: THE HARD LOCK USES A FIXED WINDOW, AND THAT IS A V1 DECISION.
#: A window opens with the first counted wrong PIN after the previous window
#: has expired, and lasts 24 hours from that failure. It is NOT a rolling
#: 24 hours and is not equivalent to "any 24-hour period": 49 wrong PINs at
#: the end of one window and a 50th just after it land in different windows
#: and do not lock. Exact rolling history would need a row per failure; the
#: owner chose not to add that schema for V1.
HARD_LOCK_WINDOW = timedelta(hours=24)

PIN_OK = "ok"
PIN_WRONG = "wrong"
PIN_COOLDOWN = "cooldown"
PIN_HARD_LOCKED = "locked"
PIN_NOT_SET = "not_set"


@dataclass(frozen=True)
class PinCheck:
    outcome: str
    #: Set only on success: the version any token issued now must carry.
    pin_version: int | None = None
    #: Seconds until the next check will be evaluated, when there is a wait.
    retry_after_seconds: int | None = None

    @property
    def ok(self) -> bool:
        return self.outcome == PIN_OK


def wait_after(consecutive_failures: int) -> timedelta:
    """The wait earned by the Nth wrong PIN in a run: none for the first five,
    then 1, 2, 4, 8 minutes, capped at 15."""
    if consecutive_failures <= FREE_FAILURES:
        return timedelta(0)
    # The exponent is bounded BEFORE doubling. Doubling first and capping after
    # overflows timedelta once a persistent guesser passes ~40 wrong PINs, which
    # would turn a 15-minute wait into a 500. Anything past 2**4 minutes is
    # already over the cap, so 10 leaves ample headroom.
    doublings = min(consecutive_failures - FREE_FAILURES - 1, 10)
    return min(FIRST_WAIT * (2**doublings), MAX_WAIT)


def _last_failure_at(credential: PlayerCredential) -> datetime | None:
    if credential.next_attempt_at is None:
        return None
    return credential.next_attempt_at - wait_after(credential.consecutive_failures)


def _age_out(credential: PlayerCredential, now: datetime) -> None:
    """Forget what time has forgiven, before judging this attempt."""
    last = _last_failure_at(credential)
    if last is not None:
        quiet_for = now - last
        if quiet_for >= QUIET_RESET or (
            credential.consecutive_failures <= FREE_FAILURES and quiet_for >= FREE_FAILURE_WINDOW
        ):
            credential.consecutive_failures = 0
            credential.next_attempt_at = None
    # The current fixed failure window has run its 24 hours: close it. The
    # next COUNTED wrong PIN opens a new one. (A hard lock is checked before
    # this runs, so an expiring window never unlocks a credential.)
    if credential.window_started_at is not None and now - credential.window_started_at >= HARD_LOCK_WINDOW:
        credential.failures_in_window = 0
        credential.window_started_at = None


def _seconds_until(moment: datetime, now: datetime) -> int:
    return max(1, math.ceil((moment - now).total_seconds()))


def verify_player_pin(
    player_id: int, pin: str, now: datetime | None = None, *, commit_on_success: bool = True
) -> PinCheck:
    """Check a PIN for one player, applying and recording the throttle.

    Takes a row lock on the credential so two simultaneous guesses cannot both
    slip through the same allowance, and commits its own bookkeeping - a wrong
    PIN must be counted even if the caller goes on to raise.

    `now` is injectable for tests; production always uses the server clock.

    `commit_on_success=False` is for /claim: a CORRECT PIN then leaves the
    transaction open with the credential row still locked, so finding or
    creating the attempt and issuing its token happen in the same transaction
    - and a claim that fails after the PIN leaves nothing half-done. A WRONG
    PIN always commits its bookkeeping immediately, whatever the caller does
    next.
    """
    now = now or datetime.now(timezone.utc)
    credential = (
        PlayerCredential.query.filter_by(player_id=player_id)
        .with_for_update()
        .populate_existing()
        .one_or_none()
    )
    if credential is None:
        db.session.rollback()
        return PinCheck(PIN_NOT_SET)
    if credential.locked_at is not None:
        db.session.rollback()
        return PinCheck(PIN_HARD_LOCKED)

    _age_out(credential, now)

    if credential.next_attempt_at is not None and now < credential.next_attempt_at:
        # Refused WITHOUT evaluating the PIN and without counting it: a guess
        # made during a wait is not a guess at all.
        retry = _seconds_until(credential.next_attempt_at, now)
        db.session.commit()
        return PinCheck(PIN_COOLDOWN, retry_after_seconds=retry)

    if pin_matches(credential.pin_hash, pin):
        # A correct PIN ends the run of typos. It deliberately does NOT clear
        # the current failure window's count: success must not hand a guesser
        # a fresh budget.
        credential.consecutive_failures = 0
        credential.next_attempt_at = None
        version = credential.pin_version
        if commit_on_success:
            db.session.commit()
        return PinCheck(PIN_OK, pin_version=version)

    credential.consecutive_failures += 1
    credential.next_attempt_at = now + wait_after(credential.consecutive_failures)
    # This is the first counted wrong PIN since the last window closed, so it
    # opens the current fixed failure window.
    if credential.window_started_at is None:
        credential.window_started_at = now
    credential.failures_in_window += 1
    locked = credential.failures_in_window >= HARD_LOCK_FAILURES
    if locked:
        credential.locked_at = now
    wait = credential.next_attempt_at - now
    db.session.commit()
    if locked:
        return PinCheck(PIN_HARD_LOCKED)
    return PinCheck(PIN_WRONG, retry_after_seconds=_seconds_until(now + wait, now) if wait else None)


def status_of(credential: PlayerCredential | None) -> str:
    if credential is None:
        return PIN_MISSING
    if credential.locked_at is not None:
        return PIN_LOCKED
    return PIN_SET


def statuses_for(player_ids: list[int]) -> dict[int, str]:
    """Credential status for many players in ONE query, for the roster list.

    Reads only the columns status needs - never `pin_hash`.
    """
    statuses = {player_id: PIN_MISSING for player_id in player_ids}
    if not player_ids:
        return statuses
    rows = db.session.query(PlayerCredential.player_id, PlayerCredential.locked_at).filter(
        PlayerCredential.player_id.in_(player_ids)
    )
    for player_id, locked_at in rows:
        statuses[player_id] = PIN_LOCKED if locked_at is not None else PIN_SET
    return statuses


def _issued(player: Player, pin: str) -> dict:
    """The one-time payload a coach receives. The ONLY shape that ever carries
    a raw PIN, and it is built here so no route assembles one by hand."""
    return {
        "player_id": player.id,
        "first_name": player.first_name,
        "last_name": player.last_name,
        "full_name": player.full_name,
        "jersey_number": player.jersey_number,
        "position": player.position,
        "pin": pin,
    }


#: What a reset puts back to zero. A coach resetting a locked-out player's PIN
#: is exactly how that player gets back in.
_CLEARED_THROTTLE = {
    "failures_in_window": 0,
    "window_started_at": None,
    "consecutive_failures": 0,
    "next_attempt_at": None,
    "locked_at": None,
}


def _missing_query(organization_id: int):
    """Active canonical players in this organization with no credential.

    Active only: an inactive player cannot start anything, and if they are
    reactivated they simply appear here again. Every Player is canonical by
    definition - legacy free-text names have no Player row to hold a PIN.
    """
    has_credential = db.exists().where(PlayerCredential.player_id == Player.id)
    return Player.query.filter(
        Player.organization_id == organization_id,
        Player.is_active.is_(True),
        ~has_credential,
    )


def missing_count(organization_id: int) -> int:
    return _missing_query(organization_id).count()


def generate_missing(coach, limit: int = GENERATE_BATCH_LIMIT) -> tuple[list[dict], int]:
    """Issue PINs to up to `limit` players who have none.

    Returns the one-time PINs and how many players still have none.

    NEVER REPLACES. The insert is ON CONFLICT DO NOTHING, and a PIN is handed
    back only for a row this call actually inserted - so two coaches clicking at
    once cannot each walk away with a different PIN for the same player, and a
    player who got a PIN a moment ago keeps it.
    """
    candidates = (
        _missing_query(coach.organization_id)
        .order_by(Player.last_name, Player.first_name, Player.id)
        .limit(limit)
        .all()
    )
    if not candidates:
        return [], 0

    now = datetime.now(timezone.utc)
    pins = {player.id: generate_pin() for player in candidates}
    rows = [
        {
            "player_id": player.id,
            "pin_hash": hash_pin(pins[player.id]),
            "pin_version": 1,
            "set_at": now,
            "set_by_coach_id": coach.id,
        }
        for player in candidates
    ]
    statement = (
        insert(PlayerCredential)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["player_id"])
        .returning(PlayerCredential.player_id)
    )
    inserted = {row[0] for row in db.session.execute(statement)}
    # Built BEFORE commit: committing expires the players, and reading them
    # afterwards would cost one query each.
    issued = [_issued(player, pins[player.id]) for player in candidates if player.id in inserted]
    db.session.commit()
    return issued, missing_count(coach.organization_id)


class WeakPinError(ValueError):
    """A hand-picked PIN a teammate would try first."""


def set_pin(player: Player, coach, pin: str) -> tuple[dict, int]:
    """Set a player's PIN to one a coach chose, hashed exactly like a generated
    one.

    THE PLAINTEXT NEVER LANDS ANYWHERE. It arrives in one request, is hashed
    here, and is echoed back once in the no-store response so the coach can hand
    it over - the same one-time shape `generate_missing` and `reset_pin` return.
    Nothing writes it to a column or a log, and no later read can produce it.

    A player who already had a PIN is treated as a RESET, because that is what
    it is: `pin_version + 1` (which revokes their tokens), the throttle cleared,
    and not one attempt, answer or result touched.

    Refuses a weak PIN with the same rule generated ones are held to - a coach
    typing 123456 for a whole roster would undo the credential.
    """
    if is_weak_pin(pin):
        raise WeakPinError(
            "Pick a different 6-digit PIN - not all one digit, a run like 123456, "
            "or a repeated pair."
        )
    return _store_pin(player, coach, pin)


def reset_pin(player: Player, coach) -> tuple[dict, int]:
    """Issue a NEW, generated PIN for one player. See `_store_pin`."""
    return _store_pin(player, coach, generate_pin())


def _store_pin(player: Player, coach, pin: str) -> tuple[dict, int]:
    """Store one PIN - generated or chosen - and return it once.

    One atomic upsert: a new hash, `pin_version + 1` when a credential already
    existed, the throttle cleared, and the issuer recorded. Attempts are not
    touched - see the module docstring. The version bump is what revokes every
    token issued under the previous PIN, so a hand-set PIN signs old devices out
    exactly as a generated one does.
    """
    now = datetime.now(timezone.utc)
    statement = insert(PlayerCredential).values(
        player_id=player.id,
        pin_hash=hash_pin(pin),
        pin_version=1,
        set_at=now,
        set_by_coach_id=coach.id,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["player_id"],
        set_={
            "pin_hash": statement.excluded.pin_hash,
            "pin_version": PlayerCredential.pin_version + 1,
            "set_at": statement.excluded.set_at,
            "set_by_coach_id": statement.excluded.set_by_coach_id,
            **_CLEARED_THROTTLE,
        },
    ).returning(PlayerCredential.pin_version)
    version = db.session.execute(statement).scalar_one()
    issued = _issued(player, pin)
    db.session.commit()
    return issued, version
