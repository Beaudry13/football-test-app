"""Player PIN credentials, and the (unused) attempt-token columns

Phase 1 of player attempt integrity. Two additions, both inert for players:

* `player_credentials` - one bcrypt-hashed 6-digit PIN per canonical player,
  issued by a coach. Nothing player-facing reads it yet.
* `player_attempts.token_*` - the per-attempt token Phase 2 will issue. Added
  now so the security work needs one migration rather than two. NULL on every
  row and read by nothing until then.

NO BACKFILL, AND DELIBERATELY SO. Generating PINs here would create secrets
nobody can ever see: they are hashed on write and never shown, so every coach
would have to reset every one of them anyway. A credential exists only once a
coach has issued it and been shown it.

Additive only: no existing row changes, no enum changes.

Revision ID: e5b2c8a41f73
Revises: c7f41a9d5e60
Create Date: 2026-09-13
"""

import sqlalchemy as sa
from alembic import op

revision = "e5b2c8a41f73"
down_revision = "c7f41a9d5e60"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "player_credentials",
        sa.Column("player_id", sa.Integer(), nullable=False),
        sa.Column("pin_hash", sa.String(length=60), nullable=False),
        sa.Column("pin_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "set_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("set_by_coach_id", sa.Integer(), nullable=True),
        sa.Column("failures_in_window", sa.Integer(), server_default="0", nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consecutive_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["set_by_coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("player_id"),
        # The database's own refusal to hold a raw PIN. bcrypt output is always
        # 60 characters beginning `$2`; a bare "482915" is neither.
        sa.CheckConstraint(
            "char_length(pin_hash) = 60 AND pin_hash LIKE '$2%'",
            name="ck_player_credentials_pin_hash_is_bcrypt",
        ),
    )
    op.create_index(
        "ix_player_credentials_set_by_coach_id", "player_credentials", ["set_by_coach_id"]
    )

    op.add_column("player_attempts", sa.Column("token_hash", sa.String(length=64), nullable=True))
    op.add_column("player_attempts", sa.Column("token_pin_version", sa.Integer(), nullable=True))
    op.add_column(
        "player_attempts",
        sa.Column("token_issued_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_column("player_attempts", "token_issued_at")
    op.drop_column("player_attempts", "token_pin_version")
    op.drop_column("player_attempts", "token_hash")
    op.drop_index("ix_player_credentials_set_by_coach_id", table_name="player_credentials")
    op.drop_table("player_credentials")
