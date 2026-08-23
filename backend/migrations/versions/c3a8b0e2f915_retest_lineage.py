"""Retest lineage: which quiz a quiz was built to re-ask

Revision ID: c3a8b0e2f915
Revises: b2e9d51a7c48

PHASE A, PART 4. One nullable self-referential FK. No UI, no endpoint.

This is the one relationship that cannot be reconstructed later: once a coach
has made a follow-up quiz by hand, nothing in the data says it was a follow-up.
Titles and timestamps are guesses. Recording it costs one column now and makes
"did they do better after I retaught it?" answerable when the loop is built.

SET NULL rather than CASCADE - deleting the original must never delete the
retest.
"""

import sqlalchemy as sa
from alembic import op

revision = "c3a8b0e2f915"
down_revision = "b2e9d51a7c48"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("quizzes", sa.Column("retest_of_quiz_id", sa.Integer(), nullable=True))
    op.create_index("ix_quizzes_retest_of_quiz_id", "quizzes", ["retest_of_quiz_id"])
    op.create_foreign_key(
        "fk_quizzes_retest_of_quiz_id", "quizzes", "quizzes",
        ["retest_of_quiz_id"], ["id"], ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_quizzes_retest_of_quiz_id", "quizzes", type_="foreignkey")
    op.drop_index("ix_quizzes_retest_of_quiz_id", table_name="quizzes")
    op.drop_column("quizzes", "retest_of_quiz_id")
