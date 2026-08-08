"""Add FILL_BLANK to the questiontype enum

ALONE IN THIS MIGRATION ON PURPOSE. Postgres cannot use a new enum value in the
same transaction that added it, and Alembic wraps each migration in one - so
the value is added here and everything that references it lands in the next
revision. The same split c1a4e7f30b21 used for DRAW_RESPONSE, for the same
reason. See CLAUDE.md, "Things that will bite you", item 8.

The enum stores MEMBER NAMES, not values: 'FILL_BLANK', not 'fill_blank'.

This is a ONE-WAY DOOR. Postgres cannot remove an enum value, so `downgrade`
is deliberately a no-op rather than a lie - see below.

Revision ID: a7e1c4b93d20
Revises: f4d7b0c63e54
"""

from alembic import op

revision = "a7e1c4b93d20"
down_revision = "f4d7b0c63e54"
branch_labels = None
depends_on = None


def upgrade():
    # autocommit_block escapes Alembic's surrounding transaction, which is what
    # makes ADD VALUE legal here at all.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE questiontype ADD VALUE IF NOT EXISTS 'FILL_BLANK'")


def downgrade():
    """Intentionally does nothing.

    Postgres has no DROP VALUE. Removing 'FILL_BLANK' would mean recreating the
    type, rewriting every questions row against it, and rebuilding the
    dependent constraints - all to undo something that is harmless to leave in
    place: an unused enum value costs nothing and breaks nothing.

    A downgrade that silently did less than it claimed would be worse than one
    that plainly does nothing.
    """
