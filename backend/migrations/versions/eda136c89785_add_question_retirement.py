"""add question retirement

Phase 4B step 2 - "stop sending this question".

NULL = deliverable, which is the whole reason no backfill is needed: every
existing row is already correct the instant the column appears. That also
makes rollback honest - dropping the columns loses retirement state and
nothing else, because nothing else is derived from them.

Additive and nullable throughout. No enum change, so none of the
`ALTER TYPE ... ADD VALUE` transaction hazards in CLAUDE.md apply here.

The partial index matches the only hot predicate this adds: the deliverable
questions of one quiz, read on every new attempt. Indexing `retired_at`
itself would be useless - almost every row is NULL.

Revision ID: eda136c89785
Revises: c4e1b8f70a25
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op

revision = "eda136c89785"
down_revision = "c4e1b8f70a25"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "questions", sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "questions", sa.Column("retired_by_coach_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_questions_retired_by_coach_id",
        "questions",
        "coaches",
        ["retired_by_coach_id"],
        ["id"],
        # The retirement decision outlives the coach who made it, exactly as
        # authorship does elsewhere in this schema.
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_questions_quiz_active",
        "questions",
        ["quiz_id"],
        unique=False,
        postgresql_where=sa.text("retired_at IS NULL"),
    )


def downgrade():
    op.drop_index("ix_questions_quiz_active", table_name="questions")
    op.drop_constraint("fk_questions_retired_by_coach_id", "questions", type_="foreignkey")
    op.drop_column("questions", "retired_by_coach_id")
    op.drop_column("questions", "retired_at")
