"""Situational Rep: tap the man - where each answer stands in the picture

Revision ID: d2f7b3a61c94
Revises: c5e1a9d47b20

EXPERIMENTAL, AND PURELY ADDITIVE. One nullable JSONB column.

  questions.tap_targets   For a decision whose answers are players ("Who gets
                          the ball?"): one {x, y} per option, in option order,
                          as fractions of the picture (0..1). The player taps
                          the man instead of a button. Null on every other
                          question, which is every existing row.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "d2f7b3a61c94"
down_revision = "c5e1a9d47b20"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("questions", sa.Column("tap_targets", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("questions", "tap_targets")
