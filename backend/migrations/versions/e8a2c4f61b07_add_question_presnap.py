"""Situational Rep: the pre-snap moment, so the player sees the motion

Revision ID: e8a2c4f61b07
Revises: d2f7b3a61c94

EXPERIMENTAL, AND PURELY ADDITIVE. One nullable JSONB column.

  questions.presnap   For a decision made from a Motion Lab play with authored
                      pre-snap motion: the PRE-SNAP part of that play, frozen
                      when the decision was made - each man's alignment, label,
                      side, authored motion and speed, and the situation - so
                      the player's screen can run the motion on Motion Lab's own
                      timeline and freeze at the snap, the decision moment.
                      Post-snap routes, the ball and blocks are never stored
                      here: they would answer the question. Null on every other
                      question, which is every existing row.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e8a2c4f61b07"
down_revision = "d2f7b3a61c94"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("questions", sa.Column("presnap", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("questions", "presnap")
