"""Add DRAW_RESPONSE to the questiontype enum

Alone in its own revision, and deliberately so. PostgreSQL will not let a
newly added enum value be *used* in the transaction that added it, and
Alembic wraps each migration in one. The conversion that needs this value
therefore lives in the next revision (d2b5f8a41c32), not here.

`ALTER TYPE ... ADD VALUE` also cannot run inside a transaction block at all
on older PostgreSQL, hence the autocommit block. A consequence worth knowing:
this statement commits independently of the rest of the migration run, so if
a later revision in the same `flask db upgrade` fails, this value is still
added. That is safe - an unused enum label is inert - but it is why this
revision does exactly one thing.

Revision ID: c1a4e7f30b21
Revises: b7e4c1d92f08
"""

from alembic import op

revision = "c1a4e7f30b21"
down_revision = "b7e4c1d92f08"
branch_labels = None
depends_on = None


def upgrade():
    # IF NOT EXISTS makes this idempotent, so a retried deploy - or a database
    # that already received the value from a rehearsal - does not fail here.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE questiontype ADD VALUE IF NOT EXISTS 'DRAW_RESPONSE'")


def downgrade():
    # Intentionally not reversible.
    #
    # PostgreSQL cannot remove a value from an enum. Undoing this would mean
    # creating a replacement type, rewriting every dependent column, and
    # destroying any question already using the value. An unused label costs
    # nothing, so the honest downgrade is to leave it in place rather than
    # pretend a reversal happened.
    #
    # If it ever genuinely must go, that is a deliberate, separately reviewed
    # data migration - not a step someone runs by typing `flask db downgrade`.
    pass
