"""Add practice question randomization

Two additive columns. Nothing existing changes meaning.

    access_codes.randomize_questions  - the coach's ASSIGNMENT intent
    player_attempts.question_order    - the FROZEN order that attempt started

WHY THE ORDER LIVES ON THE ATTEMPT
-----------------------------------
The access code says "shuffle for each new attempt"; it cannot say what order
a particular player got. If the presentation order were re-derived from the
code on every request, a refresh would reshuffle mid-attempt and a coach
toggling the setting would retroactively reorder work already in progress.
Freezing it on the attempt makes the order a historical fact, not a live
computation.

NULL IS MEANINGFUL, AND IT IS THE DEFAULT
------------------------------------------
`question_order` NULL means "the quiz's authored order". Every existing
attempt therefore stays correct with no backfill, and graded attempts never
write it at all - graded behaviour is untouched by construction rather than
by a filter someone could forget.

Revision ID: a2f5c91d64e7
Revises: f1c73d8e2a45
Create Date: 2026-08-11
"""

import sqlalchemy as sa
from alembic import op

revision = "a2f5c91d64e7"
down_revision = "f1c73d8e2a45"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "access_codes",
        sa.Column(
            "randomize_questions",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Nullable on purpose - see the module docstring. A JSON array of question
    # ids, not a join table: it is never queried, never joined, and always read
    # whole, so a child table would add a cascade to maintain for nothing.
    op.add_column("player_attempts", sa.Column("question_order", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("player_attempts", "question_order")
    op.drop_column("access_codes", "randomize_questions")
