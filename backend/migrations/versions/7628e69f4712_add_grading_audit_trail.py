"""add grading audit trail

Revision ID: 7628e69f4712
Revises: 1b88dad31a69
Create Date: 2026-08-02 15:52:48.900633

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '7628e69f4712'
down_revision = '1b88dad31a69'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('grade_audit_logs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('answer_id', sa.Integer(), nullable=False),
    sa.Column('coach_id', sa.Integer(), nullable=True),
    sa.Column('previous_is_correct', sa.Boolean(), nullable=True),
    sa.Column('previous_coach_feedback', sa.Text(), nullable=True),
    sa.Column('new_is_correct', sa.Boolean(), nullable=False),
    sa.Column('new_coach_feedback', sa.Text(), nullable=True),
    sa.Column('changed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['answer_id'], ['answers.id'], name='fk_grade_audit_logs_answer_id_answers', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['coach_id'], ['coaches.id'], name='fk_grade_audit_logs_coach_id_coaches', ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('grade_audit_logs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_grade_audit_logs_answer_id'), ['answer_id'], unique=False)

    with op.batch_alter_table('answers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('graded_by_coach_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_answers_graded_by_coach_id_coaches', 'coaches', ['graded_by_coach_id'], ['id'], ondelete='SET NULL'
        )


def downgrade():
    with op.batch_alter_table('answers', schema=None) as batch_op:
        batch_op.drop_constraint('fk_answers_graded_by_coach_id_coaches', type_='foreignkey')
        batch_op.drop_column('graded_by_coach_id')

    with op.batch_alter_table('grade_audit_logs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_grade_audit_logs_answer_id'))

    op.drop_table('grade_audit_logs')
