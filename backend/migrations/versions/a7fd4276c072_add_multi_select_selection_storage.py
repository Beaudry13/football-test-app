"""add multi-select selection storage

Multi-Select M1 - STORAGE FOUNDATION ONLY. Deliberately behaviour-inert:
nothing reads `answer_selected_options` yet, and `allows_multiple_answers` is
FALSE for every row, so single-choice behaves exactly as it did before.

TWO REPRESENTATIONS EXIST ON PURPOSE, FOR NOW
---------------------------------------------
`answers.selected_option_id` is KEPT and remains what current product
behaviour reads. Every existing selection is also copied into the new table, so
both are true at once. That is the safe order: the join table gets exercised by
real data long before anything depends on it, and the single-choice path -
which ~1,600 tests and every historical answer run through - is not disturbed.

Removing `selected_option_id` is explicitly NOT part of this migration and
should not happen until the join-table path is proven everywhere.

`option_id` HAS NO FOREIGN KEY, AND THAT IS DELIBERATE
------------------------------------------------------
It records WHICH OPTION A PLAYER CHOSE at the time they answered, and that fact
must outlive the live option row. A FK would force one of three bad outcomes:
CASCADE silently shrinks a recorded answer (A + C + D becomes A + D when
somebody deletes C); SET NULL is impossible because the column is half the
primary key; RESTRICT makes deleting a question depend on the order Postgres
processes two cascades.

The option's WORDING and CORRECTNESS are resolved from the delivered
question snapshot, which is immutable - the same rule the rest of the
historical surfaces already follow. See models/answer_selected_option.py for
the full reasoning before "fixing" this.

The application, not the database, validates that a submitted option id belongs
to the question being answered.

Revision ID: a7fd4276c072
Revises: eda136c89785
Create Date: 2026-08-17
"""

import sqlalchemy as sa
from alembic import op

revision = "a7fd4276c072"
down_revision = "eda136c89785"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "questions",
        sa.Column(
            "allows_multiple_answers",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.create_table(
        "answer_selected_options",
        sa.Column("answer_id", sa.Integer(), nullable=False),
        # NO ForeignKeyConstraint on this column - see the module docstring.
        sa.Column("option_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["answer_id"], ["answers.id"], ondelete="CASCADE"),
        # Composite PK: makes "a set" a property of the schema. The same option
        # cannot be selected twice for one answer, and no ordering is stored,
        # because order is not part of a set and exact-set grading must never
        # depend on the sequence a player happened to tap.
        sa.PrimaryKeyConstraint("answer_id", "option_id"),
    )
    # The PK already indexes (answer_id, option_id) for "what did this answer
    # select". This covers the other direction - "who selected this option" -
    # which is what a future per-option breakdown would ask.
    op.create_index(
        "ix_answer_selected_options_option_id",
        "answer_selected_options",
        ["option_id"],
    )

    # BACKFILL. Every existing single-choice answer gains its matching row, so
    # the new table describes all of history and not just answers written from
    # today onward.
    #
    # In SQL rather than Python: this runs against production data during a
    # pre-deploy migration, and loading every answer row into the app to insert
    # them one at a time would be slow and pointless. ON CONFLICT DO NOTHING
    # makes the migration re-runnable without a duplicate-key failure.
    op.execute(
        """
        INSERT INTO answer_selected_options (answer_id, option_id)
        SELECT id, selected_option_id
        FROM answers
        WHERE selected_option_id IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )


def downgrade():
    # Drops the copy, never the original: `answers.selected_option_id` was
    # untouched by the upgrade, so nothing a player did is lost by reversing
    # this. That is the point of keeping both during the transition.
    op.drop_index(
        "ix_answer_selected_options_option_id", table_name="answer_selected_options"
    )
    op.drop_table("answer_selected_options")
    op.drop_column("questions", "allows_multiple_answers")
