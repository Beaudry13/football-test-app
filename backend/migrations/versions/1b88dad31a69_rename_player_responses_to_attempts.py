"""Rename PlayerResponse to PlayerAttempt (server-side attempt tracking)

Attempts are now created the moment a player picks their name
(status=IN_PROGRESS), not only at final submit, so answers have somewhere
durable to autosave into before the player is done. Every pre-migration row
in player_responses *is* a completed submission under the old model (that
table was only ever written to at final submit), so backfilling
status='SUBMITTED' for every existing row is exact, not an approximation -
achieved via the new column's server_default rather than a separate raw-SQL
pass, since that default is simultaneously correct for every existing row.

started_at has no historical equivalent - the old schema never recorded
when a player began a quiz - so existing rows are backfilled with their
own submitted_at as the closest available proxy, then the column is locked
to NOT NULL going forward (new attempts always set it explicitly at
creation).

Every index/constraint that names the old table/column is renamed in place
(Postgres supports RENAME CONSTRAINT/RENAME INDEX directly - no need to
drop and recreate), so nothing self-documents the wrong entity afterward.

NOTE: downgrade() is destructive to any IN_PROGRESS attempt - the old
schema (no status column) cannot represent one, so any attempt that hasn't
been submitted yet is deleted before the rename is reversed.

Revision ID: 1b88dad31a69
Revises: d58221544f26
Create Date: 2026-08-02 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '1b88dad31a69'
down_revision = 'd58221544f26'
branch_labels = None
depends_on = None


attempt_status_enum = sa.Enum('IN_PROGRESS', 'SUBMITTED', name='attemptstatus')


def upgrade():
    bind = op.get_bind()

    # --- 1. Rename the table and every index/constraint naming it ----------
    op.rename_table('player_responses', 'player_attempts')

    for old, new in (
        ('ix_player_responses_access_code_id', 'ix_player_attempts_access_code_id'),
        ('ix_player_responses_player_name', 'ix_player_attempts_player_name'),
        ('ix_player_responses_quiz_id', 'ix_player_attempts_quiz_id'),
    ):
        op.execute(sa.text(f"ALTER INDEX {old} RENAME TO {new}"))

    op.execute(sa.text(
        "ALTER TABLE player_attempts RENAME CONSTRAINT "
        "player_responses_access_code_id_fkey TO player_attempts_access_code_id_fkey"
    ))
    op.execute(sa.text(
        "ALTER TABLE player_attempts RENAME CONSTRAINT "
        "player_responses_quiz_id_fkey TO player_attempts_quiz_id_fkey"
    ))

    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.drop_constraint('uq_one_response_per_player_per_activation', type_='unique')
        batch_op.create_unique_constraint(
            'uq_one_attempt_per_player_per_activation', ['access_code_id', 'player_name']
        )

    # --- 2. Rename the FK column on answers, and everything naming it ------
    with op.batch_alter_table('answers', schema=None) as batch_op:
        batch_op.alter_column(
            'player_response_id', new_column_name='attempt_id', existing_type=sa.Integer()
        )
        batch_op.drop_constraint('uq_one_answer_per_question_per_response', type_='unique')
        batch_op.create_unique_constraint(
            'uq_one_answer_per_question_per_attempt', ['attempt_id', 'question_id']
        )

    op.execute(sa.text(
        "ALTER TABLE answers RENAME CONSTRAINT "
        "answers_player_response_id_fkey TO answers_attempt_id_fkey"
    ))
    op.execute(sa.text(
        "ALTER INDEX ix_answers_player_response_id RENAME TO ix_answers_attempt_id"
    ))

    # --- 3. status - every existing row is a real completed submission -----
    attempt_status_enum.create(bind, checkfirst=True)
    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('status', attempt_status_enum, nullable=False, server_default='SUBMITTED')
        )

    # --- 4. started_at - nullable first, backfill, then lock down ----------
    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('started_at', sa.DateTime(timezone=True), nullable=True))

    bind.execute(sa.text("UPDATE player_attempts SET started_at = submitted_at"))

    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.alter_column(
            'started_at',
            existing_type=sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('now()'),
        )

    # --- 5. submitted_at was already nullable at the SQLA level (only a
    #        server_default made every row non-null in practice) - drop the
    #        default so a newly-created IN_PROGRESS attempt doesn't get a
    #        bogus current-timestamp before it's actually submitted --------
    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.alter_column(
            'submitted_at', existing_type=sa.DateTime(timezone=True), server_default=None
        )


def downgrade():
    bind = op.get_bind()

    # Destroys any IN_PROGRESS attempt outright - the pre-migration schema
    # has no way to represent one.
    bind.execute(sa.text("DELETE FROM player_attempts WHERE status = 'IN_PROGRESS'"))

    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.alter_column(
            'submitted_at',
            existing_type=sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
        )
        batch_op.drop_column('started_at')
        batch_op.drop_column('status')

    attempt_status_enum.drop(bind, checkfirst=True)

    op.execute(sa.text(
        "ALTER INDEX ix_answers_attempt_id RENAME TO ix_answers_player_response_id"
    ))
    op.execute(sa.text(
        "ALTER TABLE answers RENAME CONSTRAINT "
        "answers_attempt_id_fkey TO answers_player_response_id_fkey"
    ))

    with op.batch_alter_table('answers', schema=None) as batch_op:
        batch_op.drop_constraint('uq_one_answer_per_question_per_attempt', type_='unique')
        batch_op.alter_column(
            'attempt_id', new_column_name='player_response_id', existing_type=sa.Integer()
        )
        batch_op.create_unique_constraint(
            'uq_one_answer_per_question_per_response', ['player_response_id', 'question_id']
        )

    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.drop_constraint('uq_one_attempt_per_player_per_activation', type_='unique')
        batch_op.create_unique_constraint(
            'uq_one_response_per_player_per_activation', ['access_code_id', 'player_name']
        )

    op.execute(sa.text(
        "ALTER TABLE player_attempts RENAME CONSTRAINT "
        "player_attempts_quiz_id_fkey TO player_responses_quiz_id_fkey"
    ))
    op.execute(sa.text(
        "ALTER TABLE player_attempts RENAME CONSTRAINT "
        "player_attempts_access_code_id_fkey TO player_responses_access_code_id_fkey"
    ))

    for old, new in (
        ('ix_player_attempts_access_code_id', 'ix_player_responses_access_code_id'),
        ('ix_player_attempts_player_name', 'ix_player_responses_player_name'),
        ('ix_player_attempts_quiz_id', 'ix_player_responses_quiz_id'),
    ):
        op.execute(sa.text(f"ALTER INDEX {old} RENAME TO {new}"))

    op.rename_table('player_attempts', 'player_responses')
