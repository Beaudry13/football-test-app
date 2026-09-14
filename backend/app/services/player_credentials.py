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

import secrets
from datetime import datetime, timezone

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


def reset_pin(player: Player, coach) -> tuple[dict, int]:
    """Issue a new PIN for one player, creating their credential if needed.

    One atomic upsert: a new hash, `pin_version + 1`, the throttle cleared, and
    the issuer recorded. Attempts are not touched - see the module docstring.
    Returns the one-time PIN payload and the new version.
    """
    pin = generate_pin()
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
