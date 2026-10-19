"""A coach-placed ring on a photo: "you are this player"

Revision ID: c6e2a9f47d18
Revises: b4d8f1a26c37

EXPERIMENTAL, AND PURELY ADDITIVE. One nullable JSONB column.

  questions.subject_marker   On a question whose picture is an uploaded photo,
                             where the coach put the gold "YOU ARE THIS PLAYER"
                             ring: {x, y, r} as fractions of the picture (r of
                             its width). The coach places it - nothing is read
                             from the photo. The words for him stay in
                             subject_role. Null on every other question, which
                             is every existing row.

Downgrade drops the column; photos and words are untouched.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c6e2a9f47d18"
down_revision = "b4d8f1a26c37"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("questions", sa.Column("subject_marker", postgresql.JSONB(), nullable=True))


def downgrade():
    op.drop_column("questions", "subject_marker")
