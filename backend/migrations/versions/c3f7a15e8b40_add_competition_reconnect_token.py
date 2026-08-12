"""Give every competition participant an opaque reconnect token

WHY THIS EXISTS
----------------
The first cut of Competition Mode authenticated a returning player with
(join_code, player_id). Both of those are public: the join code is read off a
projector, and the lobby endpoint publishes every eligible player_id so the
identity picker can render. That is not a credential - it is two pieces of
public information, and anyone holding the code could reconnect as any player,
read their private state, and (once M2 lands) submit answers as them.

A participant id would have been no better. It is a sequential primary key.

So identity gets a real secret: 32 random bytes, minted once when the seat is
taken, never derived from player_id, never returned in any list payload, and
required for every player-private request. The player picks their name in the
open, exactly as before - but proving you ARE that player later takes
something only that device was given.

NOT NULL IN THREE STEPS
------------------------
Added nullable, backfilled, then constrained. The tables are empty everywhere
today, but a migration that only works on an empty table is a migration that
fails the first time it meets data.

Revision ID: c3f7a15e8b40
Revises: b8e41c7d92a3
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "c3f7a15e8b40"
down_revision = "b8e41c7d92a3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "competition_participants",
        sa.Column("reconnect_token", sa.String(length=64), nullable=True),
    )

    # Backfill. md5(random()) rather than gen_random_uuid() so this does not
    # depend on pgcrypto being installed; these values only need to be unique
    # and unpredictable-enough for rows that cannot exist yet in any
    # deployment, since real tokens are minted by the application.
    op.execute(
        "UPDATE competition_participants "
        "SET reconnect_token = md5(random()::text || clock_timestamp()::text || id::text) "
        "WHERE reconnect_token IS NULL"
    )

    op.alter_column("competition_participants", "reconnect_token", nullable=False)

    # Unique AND indexed: the token is the lookup key for every player-private
    # request, so it must resolve in one indexed hit, and a collision must be
    # impossible rather than merely unlikely.
    op.create_index(
        "ix_competition_participants_reconnect_token",
        "competition_participants",
        ["reconnect_token"],
        unique=True,
    )


def downgrade():
    op.drop_index(
        "ix_competition_participants_reconnect_token",
        table_name="competition_participants",
    )
    op.drop_column("competition_participants", "reconnect_token")
