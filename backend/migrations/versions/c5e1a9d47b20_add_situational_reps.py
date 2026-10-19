"""Situational Rep: a quiz kind, and who/where a decision is about

Revision ID: c5e1a9d47b20
Revises: b3e8d51f7a26

EXPERIMENTAL, AND PURELY ADDITIVE. Three columns, every one with a default or
nullable, so every existing row reads exactly as before and the downgrade is a
clean drop.

  quizzes.kind              QUIZ (every existing quiz) or REP. A Rep is a quiz
                            delivered one decision at a time with immediate
                            feedback; the kind is what tells the player screen
                            and the coach diagnostics to treat it as one. A
                            VARCHAR with a CHECK, not a native enum, for the
                            reason assessment_mode gives (CLAUDE.md #8).
  questions.subject_role    "Boundary safety" - who the player IS in this
                            decision. Free text, as the coach says it.
  questions.motion_play_id  The Motion Lab play the decision was made from, so
                            the coach's Teach opens it. SET NULL: deleting the
                            play must never delete or block the question.
"""

import sqlalchemy as sa
from alembic import op

revision = "c5e1a9d47b20"
down_revision = "b3e8d51f7a26"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "quizzes",
        sa.Column("kind", sa.String(length=8), nullable=False, server_default="QUIZ"),
    )
    op.create_check_constraint("ck_quizzes_kind", "quizzes", "kind IN ('QUIZ', 'REP')")

    op.add_column("questions", sa.Column("subject_role", sa.String(length=60), nullable=True))
    op.add_column("questions", sa.Column("motion_play_id", sa.Integer(), nullable=True))
    op.create_index("ix_questions_motion_play_id", "questions", ["motion_play_id"])
    op.create_foreign_key(
        "fk_questions_motion_play_id", "questions", "motion_plays",
        ["motion_play_id"], ["id"], ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_questions_motion_play_id", "questions", type_="foreignkey")
    op.drop_index("ix_questions_motion_play_id", table_name="questions")
    op.drop_column("questions", "motion_play_id")
    op.drop_column("questions", "subject_role")
    op.drop_constraint("ck_quizzes_kind", "quizzes", type_="check")
    op.drop_column("quizzes", "kind")
