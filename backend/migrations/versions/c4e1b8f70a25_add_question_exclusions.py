"""Add question_exclusions ("don't count this question")

Lets a coach remove a broken question from scoring AFTER players have taken it,
without resetting attempts and without touching a single answer row. See
models/question_exclusion.py and docs/DESIGN-delivered-question-snapshots.md.

Purely additive: one new table, no column changed, no row rewritten, NOTHING
BACKFILLED. An empty `question_exclusions` makes every existing score identical
to what it was the moment before this deployed - the anti-join in
routes/quizzes.py and the Python predicate both degrade to "nothing excluded".
The downgrade is therefore a clean drop.

WHY TWO PARTIAL UNIQUE INDEXES AND NOT ONE
-------------------------------------------
The obvious single index

    UNIQUE (question_id, access_code_id) WHERE restored_at IS NULL

does NOT prevent duplicate quiz-wide exclusions, because Postgres treats NULLs
as DISTINCT in a unique index - every quiz-wide row has access_code_id NULL, so
any number of them satisfy it. The same NULL semantics that
attempt_question_snapshots RELIES on (two deleted questions both landing on
NULL and both surviving) is a hazard here. Splitting into two partial indexes
states each rule where it can actually be enforced, and deliberately lets an
assignment-scoped and a quiz-wide exclusion of the same question coexist - a
question covered by either is simply excluded once.

Revision ID: c4e1b8f70a25
Revises: f9a3c07b21de
"""

import sqlalchemy as sa
from alembic import op

revision = "c4e1b8f70a25"
down_revision = "f9a3c07b21de"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "question_exclusions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("question_id", sa.Integer(), nullable=False),
        # NULL = quiz-wide; a value scopes the exclusion to one assignment.
        sa.Column("access_code_id", sa.Integer(), nullable=True),
        sa.Column("coach_id", sa.Integer(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "excluded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # NULL means ACTIVE. Restoring sets this; the row is never deleted.
        sa.Column("restored_at", sa.DateTime(timezone=True), nullable=True),
        # CASCADE: an answered question cannot be hard-deleted today, and if a
        # question does go its answers cascade with it - leaving an exclusion
        # that points at no evidence. See the model for the full reasoning.
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["access_code_id"], ["access_codes.id"], ondelete="CASCADE"),
        # SET NULL: a coach leaving the org loses the attribution, not the record.
        sa.ForeignKeyConstraint(["coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    # Serves the SQL anti-join in routes/quizzes.py, which looks rows up by
    # question_id alone ("is this question excluded for this attempt").
    op.create_index(
        op.f("ix_question_exclusions_question_id"),
        "question_exclusions",
        ["question_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_question_exclusions_access_code_id"),
        "question_exclusions",
        ["access_code_id"],
        unique=False,
    )

    # At most one ACTIVE exclusion of this question for this assignment.
    op.create_index(
        "uq_active_exclusion_per_assignment",
        "question_exclusions",
        ["question_id", "access_code_id"],
        unique=True,
        postgresql_where=sa.text("restored_at IS NULL AND access_code_id IS NOT NULL"),
    )
    # At most one ACTIVE quiz-wide exclusion of this question. Keyed on
    # question_id ALONE - see the module docstring for why including the NULL
    # column here would enforce nothing.
    op.create_index(
        "uq_active_quiz_wide_exclusion",
        "question_exclusions",
        ["question_id"],
        unique=True,
        postgresql_where=sa.text("restored_at IS NULL AND access_code_id IS NULL"),
    )


def downgrade():
    op.drop_index("uq_active_quiz_wide_exclusion", table_name="question_exclusions")
    op.drop_index("uq_active_exclusion_per_assignment", table_name="question_exclusions")
    op.drop_index(
        op.f("ix_question_exclusions_access_code_id"), table_name="question_exclusions"
    )
    op.drop_index(op.f("ix_question_exclusions_question_id"), table_name="question_exclusions")
    op.drop_table("question_exclusions")
