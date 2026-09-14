"""A player's private credential: the 6-digit PIN, as a bcrypt hash.

WHY THIS EXISTS. Quiz attempts are identified by access code plus player_id,
and player_id is published in the join picker - it is an identifier, not a
secret. So anyone holding a code could act as anyone on its roster. The PIN is
the thing a player KNOWS, which is the only way a legitimate player can prove
who they are from a device that has never seen them before.

PHASE 1: THIS TABLE IS WRITTEN BY COACHES AND READ BY NOTHING PLAYER-FACING.
No quiz route consults it yet. Player behaviour is unchanged until Phase 2/3.

WHAT MUST NEVER BE TRUE
-----------------------
* The raw PIN is never stored. `pin_hash` is bcrypt, and a CHECK constraint
  refuses anything that is not shaped like one - so a future bug that writes
  the raw PIN fails loudly instead of quietly leaking every player's PIN.
* There is deliberately NO `to_dict()`. Nothing should ever serialise this
  row; the only things that leave the server are the one-time raw PIN at
  generation and a derived status ("set" / "missing" / "locked").
* Peira cannot show a PIN again. A coach who loses one resets it.

Kept in its own table rather than as columns on `players` so that
`Player.to_dict()` - which a great many payloads reuse - can never pick a
credential up by accident.
"""

from app.extensions import db

#: bcrypt output is always 60 characters and starts `$2`. Shared with the
#: migration so the model and the database refuse the same things.
PIN_HASH_CHECK = "char_length(pin_hash) = 60 AND pin_hash LIKE '$2%'"


class PlayerCredential(db.Model):
    __tablename__ = "player_credentials"
    __table_args__ = (
        db.CheckConstraint(PIN_HASH_CHECK, name="ck_player_credentials_pin_hash_is_bcrypt"),
    )

    #: One credential per player. CASCADE: a player who is deleted has no
    #: credential worth keeping, and a leftover hash pointing at nobody is
    #: exactly the kind of row nothing would ever clean up.
    player_id = db.Column(
        db.Integer, db.ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    pin_hash = db.Column(db.String(60), nullable=False)

    #: Bumped on every reset. Phase 2 stamps it onto each attempt token, so a
    #: reset invalidates every token issued under the old PIN without touching
    #: a single attempt row.
    pin_version = db.Column(db.Integer, nullable=False, default=1, server_default="1")

    set_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=db.func.now())
    #: Who issued it, for the audit trail. SET NULL: removing a coach from the
    #: organization must not delete the credentials they happened to issue.
    set_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # --- Wrong-PIN throttling -------------------------------------------------
    # PER PLAYER, never per IP: behind Render's proxy the address is unreliable,
    # and on facility Wi-Fi a whole team shares one. Written by Phase 2's PIN
    # verification; Phase 1 only ever CLEARS them, on reset.
    failures_in_window = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    window_started_at = db.Column(db.DateTime(timezone=True), nullable=True)
    consecutive_failures = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    next_attempt_at = db.Column(db.DateTime(timezone=True), nullable=True)
    #: Set only by the hard lock. Cleared only by a coach reset.
    locked_at = db.Column(db.DateTime(timezone=True), nullable=True)
