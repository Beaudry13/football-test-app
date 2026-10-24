"""The coach's own drawing of the right answer to a Draw Response question

Revision ID: e4b9d2a6c815
Revises: d7f3b1c58e29
Create Date: 2026-10-20

DRAW YOUR ASSIGNMENT, WITH SOMETHING TO COMPARE IT TO. A Draw Response question
can now carry the coach's drawing of the answer - a peira.drawing document in
the question picture's coordinate space, strokes on the 'coach' layer. The
coach reviews each player's drawing against it; a Situational Rep (teaching)
shows it to the player after he locks his own. Never sent to a player on a quiz.

Additive and reversible: one nullable column, no backfill, no constraint on
existing rows. Downgrading drops the column and every answer drawing in it.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e4b9d2a6c815"
down_revision = "d7f3b1c58e29"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("questions", sa.Column("answer_drawing", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("questions", "answer_drawing")
