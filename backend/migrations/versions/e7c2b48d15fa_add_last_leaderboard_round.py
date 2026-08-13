"""Competition M2.4: record which round's standings the room actually saw

One nullable column. NULL means "no leaderboard has been shown yet", which is
why it is nullable rather than defaulting to 0 - round 0 is a real round, and
conflating "we showed standings after the first question" with "we have never
shown standings" would fabricate movement arrows out of nothing.

WHY THIS COLUMN AND NOT STORED RANKS
-------------------------------------
Movement needs a previous rank. The two obvious approaches are both wrong:

  * Deriving it from "the round before this one" is wrong whenever the coach
    skipped a leaderboard. Show standings after round 2, skip 3 and 4, show
    again after 5, and the arrows must compare against round 2 - the last
    thing the room actually saw - not round 4, which nobody was shown.

  * Storing previous_rank per participant mutates history on every reveal,
    cannot be recomputed if it drifts, and gives a replayed transition a way
    to corrupt it silently.

Standings are already fully derivable from competition_answers.points_awarded.
So the only thing that genuinely cannot be derived is WHICH ROUND the room was
last shown - and that is exactly one integer per session. Previous standings
are then the same pure ranking function run over `round_index <= this`.

No snapshot table, no per-player rank storage, nothing written that could
disagree with the answer rows it came from.

Revision ID: e7c2b48d15fa
Revises: d4a91f26b8c7
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "e7c2b48d15fa"
down_revision = "d4a91f26b8c7"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "competition_sessions",
        sa.Column("last_leaderboard_round", sa.SmallInteger(), nullable=True),
    )


def downgrade():
    # Dropping this loses only the movement baseline. Points, answers and
    # standings all remain derivable from competition_answers, so a downgraded
    # competition still ranks correctly - it just shows every row as NEW.
    op.drop_column("competition_sessions", "last_leaderboard_round")
