"""Add folder parent_folder_id (simple two-level nesting)

Purely additive: one new nullable, indexed, self-referential FK column.
Every existing folder row gets parent_folder_id=NULL, which is exactly its
current implicit state (root-level) - no backfill, no data change, no risk
to existing folders or quiz-folder assignments.

ondelete='RESTRICT' backs up delete_folder()'s own pre-check (reject
deleting a folder that still has subfolders) at the database level, so a
future bug in the application check can't silently orphan or cascade-delete
a subfolder tree.

Revision ID: 22d0ec57689a
Revises: 7628e69f4712
Create Date: 2026-08-03 11:31:08.682875

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '22d0ec57689a'
down_revision = '7628e69f4712'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('folders', schema=None) as batch_op:
        batch_op.add_column(sa.Column('parent_folder_id', sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f('ix_folders_parent_folder_id'), ['parent_folder_id'], unique=False)
        batch_op.create_foreign_key(
            'fk_folders_parent_folder_id_folders',
            'folders', ['parent_folder_id'], ['id'], ondelete='RESTRICT',
        )


def downgrade():
    with op.batch_alter_table('folders', schema=None) as batch_op:
        batch_op.drop_constraint('fk_folders_parent_folder_id_folders', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_folders_parent_folder_id'))
        batch_op.drop_column('parent_folder_id')
