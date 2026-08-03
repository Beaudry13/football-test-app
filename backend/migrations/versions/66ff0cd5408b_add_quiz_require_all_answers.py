"""Add quiz require_all_answers

Purely additive: one new NOT NULL boolean column, server_default 'false'
during the add so every existing quiz backfills to false (the same
opt-in-only behavior it already has today - players may leave questions
blank) without a separate UPDATE pass. false stays the correct default
forever, unlike a timestamp-style column, so the server_default is left in
place rather than dropped afterward.

Revision ID: 66ff0cd5408b
Revises: 22d0ec57689a
Create Date: 2026-08-03 17:05:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '66ff0cd5408b'
down_revision = '22d0ec57689a'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                'require_all_answers', sa.Boolean(), nullable=False, server_default=sa.text('false')
            )
        )


def downgrade():
    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.drop_column('require_all_answers')
