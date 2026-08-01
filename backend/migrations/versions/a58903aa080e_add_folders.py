"""Add folders

Revision ID: a58903aa080e
Revises: 3154d816f87e
Create Date: 2026-08-01 00:05:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a58903aa080e'
down_revision = '3154d816f87e'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('folders',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('coach_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['coach_id'], ['coaches.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('folders', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_folders_coach_id'), ['coach_id'], unique=False)

    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('folder_id', sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f('ix_quizzes_folder_id'), ['folder_id'], unique=False)
        batch_op.create_foreign_key(
            'fk_quizzes_folder_id_folders', 'folders', ['folder_id'], ['id'], ondelete='SET NULL'
        )


def downgrade():
    with op.batch_alter_table('quizzes', schema=None) as batch_op:
        batch_op.drop_constraint('fk_quizzes_folder_id_folders', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_quizzes_folder_id'))
        batch_op.drop_column('folder_id')

    with op.batch_alter_table('folders', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_folders_coach_id'))

    op.drop_table('folders')
