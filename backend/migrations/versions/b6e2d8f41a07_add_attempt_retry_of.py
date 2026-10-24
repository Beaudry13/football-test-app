"""A practice attempt that tries an earlier run's misses again

Revision ID: b6e2d8f41a07
Revises: e4b9d2a6c815
Create Date: 2026-10-21

TRY THE MISSES AGAIN. After a practice run (a Rep, or a practice quiz) a player
can start a new practice attempt holding only the questions that run missed.
`retry_of_attempt_id` names the run it retries. It is what lets the delivery
stop at those questions (a retry never picks up the rest of the quiz) and what
keeps a retry out of every run-level score: the coach's Rep results, a player's
"since last time", first tries. The run it retries is never touched.

Additive and reversible: one nullable column with an index, ON DELETE SET NULL
so resetting the earlier attempt never deletes the retry. No backfill - every
existing attempt is simply not a retry. Downgrading drops the column, after
which a retry reads as an ordinary short practice run.
"""
import sqlalchemy as sa
from alembic import op

revision = "b6e2d8f41a07"
down_revision = "e4b9d2a6c815"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("player_attempts", sa.Column("retry_of_attempt_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_player_attempts_retry_of_attempt_id",
        "player_attempts",
        "player_attempts",
        ["retry_of_attempt_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_player_attempts_retry_of_attempt_id", "player_attempts", ["retry_of_attempt_id"])


def downgrade():
    op.drop_index("ix_player_attempts_retry_of_attempt_id", table_name="player_attempts")
    op.drop_constraint("fk_player_attempts_retry_of_attempt_id", "player_attempts", type_="foreignkey")
    op.drop_column("player_attempts", "retry_of_attempt_id")
