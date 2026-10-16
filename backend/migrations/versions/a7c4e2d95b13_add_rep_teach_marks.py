"""Situational Rep: a taught problem, stored, so Retest guidance follows the Rep

Revision ID: a7c4e2d95b13
Revises: e8a2c4f61b07

EXPERIMENTAL, AND PURELY ADDITIVE. One new table; no existing table changes.

  rep_teach_marks   One row per Rep and football problem a coach has taught
                    (Teach on the Rep page). Its presence turns that problem's
                    next step into Retest - on every device, for every coach in
                    the organization who opens the Rep. Before this table the
                    same fact lived in one browser's localStorage. No row means
                    "not taught yet", which is every existing Rep.

Downgrade drops the table, losing only "taught" marks (the guidance falls back
to Teach first); nothing else reads it.
"""

import sqlalchemy as sa
from alembic import op

revision = "a7c4e2d95b13"
down_revision = "e8a2c4f61b07"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "rep_teach_marks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("quiz_id", sa.Integer(), sa.ForeignKey("quizzes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("concept_key", sa.String(length=32), nullable=False),
        sa.Column("concept_id", sa.Integer(), sa.ForeignKey("concepts.id", ondelete="SET NULL"), nullable=True),
        sa.Column(
            "taught_by_coach_id", sa.Integer(), sa.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("taught_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("quiz_id", "concept_key", name="uq_rep_teach_marks_quiz_concept"),
    )
    op.create_index("ix_rep_teach_marks_quiz_id", "rep_teach_marks", ["quiz_id"])


def downgrade():
    op.drop_index("ix_rep_teach_marks_quiz_id", table_name="rep_teach_marks")
    op.drop_table("rep_teach_marks")
