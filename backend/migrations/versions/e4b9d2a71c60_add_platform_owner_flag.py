"""Add coaches.is_platform_owner

The Peira Owner Dashboard's permission, and nothing else.

WHY A BOOLEAN AND NOT A THIRD coachrole VALUE
----------------------------------------------
`coachrole` is a native Postgres enum, so adding a value is a one-way door
and cannot run in the transaction that created the type (see CLAUDE.md #8).
More importantly it would be the wrong shape: the platform operator is an
ADMIN of their own organization *and* the owner of Peira, and a role column
holds one value. A separate flag keeps the two orthogonal, which is what
guarantees Coach View, Admin View and organization boundaries are unchanged
by granting it.

THIS MIGRATION GRANTS NOTHING
------------------------------
Every existing and future coach defaults to false. Ownership is conferred
deliberately by `flask owner grant <email>`, never as a side effect of a
deploy - a migration that hardcoded an email would put it in the repo
forever and could not express a second owner.

Unlike d7a2f91c53e8 this downgrade is unconditionally safe: dropping a
boolean column has no uniqueness or data implications.

Revision ID: e4b9d2a71c60
Revises: d7a2f91c53e8
Create Date: 2026-08-10
"""

import sqlalchemy as sa
from alembic import op

revision = "e4b9d2a71c60"
down_revision = "d7a2f91c53e8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "coaches",
        sa.Column(
            "is_platform_owner",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade():
    op.drop_column("coaches", "is_platform_owner")
