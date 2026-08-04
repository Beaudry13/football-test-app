"""Add composite index for player-progress analytics queries

Purely additive: no columns or tables change, only a new index.

Player Progress Analytics reads player_attempts filtered by player_id and
status (usually SUBMITTED), ordered by submitted_at - the hot path for a
Player's own summary/recent-performance/trend, and for the org-wide
"last activity" rollup across every Player. player_id and status already
each have their own single-column index (or are cheap to filter), but a
composite covering index matching this exact access pattern avoids a
Postgres bitmap-and across separate indexes on every request, which starts
to matter once an organization has hundreds of players and thousands of
attempts (see Player Progress Analytics manual verification for the
scale this was tested against).

Create Date: 2026-08-04 00:00:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = 'c1a4f9d0e7b2'
down_revision = '8b2f61c9a4d3'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_player_attempts_player_status_submitted",
        "player_attempts",
        ["player_id", "status", "submitted_at"],
    )


def downgrade():
    op.drop_index("ix_player_attempts_player_status_submitted", table_name="player_attempts")
