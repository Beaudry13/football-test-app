"""Situational Rep: which man in the play a decision tests, recorded

Revision ID: b4d8f1a26c37
Revises: a7c4e2d95b13

EXPERIMENTAL, AND PURELY ADDITIVE. One nullable column.

  questions.subject_man   The Motion Lab player id ("D4") of the man a
                          decision is about - the one ringed in its picture
                          and moving with the ring in its pre-snap moment.
                          `subject_role` is the coach's WORDS for him; this is
                          WHICH MAN, so the words, the ring and the picture can
                          be kept together (and changed together) rather than
                          drifting apart. Null on every other question, which
                          is every existing row.

Downgrade drops the column; the words and pictures are untouched.
"""

import sqlalchemy as sa
from alembic import op

revision = "b4d8f1a26c37"
down_revision = "a7c4e2d95b13"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("questions", sa.Column("subject_man", sa.String(length=32), nullable=True))


def downgrade():
    op.drop_column("questions", "subject_man")
