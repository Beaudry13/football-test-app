"""Add attempt_question_snapshots

Records what each attempt was actually DELIVERED, one row per question in the
attempt's frozen order, written at POST /play/start. See
docs/DESIGN-delivered-question-snapshots.md and
models/attempt_question_snapshot.py for why this is a sibling table rather than
a column on `answers` (short version: an unanswered question has no Answer row,
and an unanswered question is still in the denominator).

Purely additive: one new table, no column changed, no data rewritten, and
NOTHING BACKFILLED. Pre-existing attempts deliberately end up with zero rows -
manufacturing snapshots from today's questions would invent a history that
never happened. The downgrade is therefore a clean drop.

Revision ID: f9a3c07b21de
Revises: e7c2b48d15fa
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f9a3c07b21de"
down_revision = "e7c2b48d15fa"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "attempt_question_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("attempt_id", sa.Integer(), nullable=False),
        # NULLABLE, with ON DELETE SET NULL below: the row has to outlive the
        # question it describes. That is the entire point - a deleted question
        # must leave its delivered content behind rather than taking the
        # evidence with it.
        sa.Column("question_id", sa.Integer(), nullable=True),
        # The position AS DELIVERED, not questions.position. A randomized
        # practice attempt disagrees with the quiz's authored order, and this
        # records the order the player actually saw.
        sa.Column("position", sa.Integer(), nullable=False),
        # JSONB rather than JSON: this will be queried by key (which snapshots
        # point at a given image) the moment historical image preservation
        # runs, and JSON would make that a full text comparison.
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # CASCADE: resetting an attempt (which already deletes its answers)
        # takes its delivery record with it. The snapshot describes THAT
        # attempt and means nothing without it.
        sa.ForeignKeyConstraint(["attempt_id"], ["player_attempts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        # Postgres treats NULLs as distinct in a unique constraint, which is
        # required here rather than merely tolerated: two questions deleted
        # after delivery both land on question_id NULL for the same attempt and
        # must both survive.
        sa.UniqueConstraint(
            "attempt_id", "question_id", name="uq_one_snapshot_per_question_per_attempt"
        ),
    )
    op.create_index(
        op.f("ix_attempt_question_snapshots_attempt_id"),
        "attempt_question_snapshots",
        ["attempt_id"],
        unique=False,
    )
    # Not redundant with the unique constraint's index: preservation looks rows
    # up by question_id ALONE ("which deliveries depend on this question's
    # image"), which the (attempt_id, question_id) index cannot serve.
    op.create_index(
        op.f("ix_attempt_question_snapshots_question_id"),
        "attempt_question_snapshots",
        ["question_id"],
        unique=False,
    )


def downgrade():
    op.drop_index(
        op.f("ix_attempt_question_snapshots_question_id"),
        table_name="attempt_question_snapshots",
    )
    op.drop_index(
        op.f("ix_attempt_question_snapshots_attempt_id"),
        table_name="attempt_question_snapshots",
    )
    op.drop_table("attempt_question_snapshots")
