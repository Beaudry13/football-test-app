"""Add master-roster Player model, dual-write columns, migration

Purely additive: every existing table/column is preserved untouched.

- New `players` table: one canonical, durable record per real person in an
  organization, identified by `id` only (deliberately no unique constraint
  on name or jersey number - two players can share a name).
- `group_players.player_id` / `roster_players.player_id`: nullable links to
  a canonical Player. NULL means a legacy free-text row exactly as before;
  set means the row is a canonical membership and `player_name` becomes
  just a display snapshot. Both kinds may coexist on the same
  group/roster during the transition (dual-read/dual-write - see the
  models' own docstrings). A partial unique index on each table prevents
  the same Player being added to the same group/roster twice, but only
  applies where player_id IS NOT NULL - legacy name rows are untouched and
  keep relying on the existing application-level dedupe.
- `player_attempts.player_id`: nullable link to a canonical Player. This
  replaces the single UniqueConstraint('access_code_id', 'player_name')
  with two partial unique indexes:
    - one on (access_code_id, player_name) WHERE player_id IS NULL,
      preserving the exact original name-collision rule for legacy,
      non-canonical attempts;
    - one on (access_code_id, player_id) WHERE player_id IS NOT NULL,
      which is what lets two different canonical Players who happen to
      share a display name (e.g. two "Chris Smith"s) both attempt the same
      activation without colliding - the old single name-based constraint
      could not represent that at all.
  Every row that satisfies the old constraint today has player_id NULL, so
  it automatically satisfies the new legacy-only index identically -
  nothing about existing data changes meaning.

No backfill in this migration. Every existing group_players/roster_players/
player_attempts row keeps player_id = NULL and continues to work exactly
as it does today; canonical linking happens going forward as coaches build
out their master roster (see routes/players.py, routes/groups.py's
add_group_members, routes/rosters.py's add_roster_members).

Revision ID: 8b2f61c9a4d3
Revises: 66ff0cd5408b
Create Date: 2026-08-04 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8b2f61c9a4d3'
down_revision = '66ff0cd5408b'
branch_labels = None
depends_on = None


def upgrade():
    # --- 1. New players table ----------------------------------------------
    op.create_table(
        'players',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('organization_id', sa.Integer(), nullable=False),
        sa.Column('first_name', sa.String(length=100), nullable=False),
        sa.Column('last_name', sa.String(length=100), nullable=False),
        sa.Column('jersey_number', sa.String(length=4), nullable=True),
        sa.Column('position', sa.String(length=10), nullable=True),
        sa.Column('photo_url', sa.String(length=500), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('players', schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f('ix_players_organization_id'), ['organization_id'], unique=False
        )

    # --- 2. group_players.player_id -----------------------------------------
    with op.batch_alter_table('group_players', schema=None) as batch_op:
        batch_op.add_column(sa.Column('player_id', sa.Integer(), nullable=True))
        batch_op.create_index(
            batch_op.f('ix_group_players_player_id'), ['player_id'], unique=False
        )
        batch_op.create_foreign_key(
            'fk_group_players_player_id_players', 'players', ['player_id'], ['id'],
            ondelete='CASCADE',
        )
    op.execute(sa.text(
        "CREATE UNIQUE INDEX uq_group_players_group_player "
        "ON group_players (group_id, player_id) WHERE player_id IS NOT NULL"
    ))

    # --- 3. roster_players.player_id ----------------------------------------
    with op.batch_alter_table('roster_players', schema=None) as batch_op:
        batch_op.add_column(sa.Column('player_id', sa.Integer(), nullable=True))
        batch_op.create_index(
            batch_op.f('ix_roster_players_player_id'), ['player_id'], unique=False
        )
        batch_op.create_foreign_key(
            'fk_roster_players_player_id_players', 'players', ['player_id'], ['id'],
            ondelete='CASCADE',
        )
    op.execute(sa.text(
        "CREATE UNIQUE INDEX uq_roster_players_roster_player "
        "ON roster_players (roster_id, player_id) WHERE player_id IS NOT NULL"
    ))

    # --- 4. player_attempts.player_id + corrected uniqueness ---------------
    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('player_id', sa.Integer(), nullable=True))
        batch_op.create_index(
            batch_op.f('ix_player_attempts_player_id'), ['player_id'], unique=False
        )
        batch_op.create_foreign_key(
            'fk_player_attempts_player_id_players', 'players', ['player_id'], ['id'],
            ondelete='SET NULL',
        )
        batch_op.drop_constraint('uq_one_attempt_per_player_per_activation', type_='unique')

    op.execute(sa.text(
        "CREATE UNIQUE INDEX uq_legacy_attempt_by_name "
        "ON player_attempts (access_code_id, player_name) WHERE player_id IS NULL"
    ))
    op.execute(sa.text(
        "CREATE UNIQUE INDEX uq_canonical_attempt_by_player "
        "ON player_attempts (access_code_id, player_id) WHERE player_id IS NOT NULL"
    ))


def downgrade():
    op.execute(sa.text("DROP INDEX IF EXISTS uq_canonical_attempt_by_player"))
    op.execute(sa.text("DROP INDEX IF EXISTS uq_legacy_attempt_by_name"))
    with op.batch_alter_table('player_attempts', schema=None) as batch_op:
        batch_op.create_unique_constraint(
            'uq_one_attempt_per_player_per_activation', ['access_code_id', 'player_name']
        )
        batch_op.drop_constraint('fk_player_attempts_player_id_players', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_player_attempts_player_id'))
        batch_op.drop_column('player_id')

    op.execute(sa.text("DROP INDEX IF EXISTS uq_roster_players_roster_player"))
    with op.batch_alter_table('roster_players', schema=None) as batch_op:
        batch_op.drop_constraint('fk_roster_players_player_id_players', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_roster_players_player_id'))
        batch_op.drop_column('player_id')

    op.execute(sa.text("DROP INDEX IF EXISTS uq_group_players_group_player"))
    with op.batch_alter_table('group_players', schema=None) as batch_op:
        batch_op.drop_constraint('fk_group_players_player_id_players', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_group_players_player_id'))
        batch_op.drop_column('player_id')

    with op.batch_alter_table('players', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_players_organization_id'))
    op.drop_table('players')
