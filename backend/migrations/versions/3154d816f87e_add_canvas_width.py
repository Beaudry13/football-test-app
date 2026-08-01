"""Add canvas_width to question_images

Revision ID: 3154d816f87e
Revises: c614749e6a09
Create Date: 2026-08-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '3154d816f87e'
down_revision = 'c614749e6a09'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('question_images', schema=None) as batch_op:
        batch_op.add_column(sa.Column('canvas_width', sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table('question_images', schema=None) as batch_op:
        batch_op.drop_column('canvas_width')
