"""Add groups

Revision ID: 4233792f38ab
Revises: a58903aa080e
Create Date: 2026-08-01 00:10:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '4233792f38ab'
down_revision = 'a58903aa080e'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('groups',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('coach_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['coach_id'], ['coaches.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('groups', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_groups_coach_id'), ['coach_id'], unique=False)

    op.create_table('group_players',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('group_id', sa.Integer(), nullable=False),
    sa.Column('player_name', sa.String(length=255), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('group_players', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_group_players_group_id'), ['group_id'], unique=False)

    op.create_table('access_code_groups',
    sa.Column('access_code_id', sa.Integer(), nullable=False),
    sa.Column('group_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['access_code_id'], ['access_codes.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('access_code_id', 'group_id')
    )


def downgrade():
    op.drop_table('access_code_groups')

    with op.batch_alter_table('group_players', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_group_players_group_id'))
    op.drop_table('group_players')

    with op.batch_alter_table('groups', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_groups_coach_id'))
    op.drop_table('groups')
