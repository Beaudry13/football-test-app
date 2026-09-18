"""Player PIN security is each organization's own choice

Adds organizations.player_pin_security_enabled, DEFAULT FALSE.

BACKWARD COMPATIBLE BY CONSTRUCTION. Every existing row gets false, so
deploying this cannot start asking anybody's players for a PIN; an
organization's staff admin turns it on when their roster has PINs. The column
is ANDed with the platform's PLAYER_PIN_ENFORCEMENT switch - see
services/player_enforcement.settings_for().

Additive only: older code that does not know the column keeps working, which is
what makes rolling the application back safe.

Revision ID: f1a6c27b90d4
Revises: e5b2c8a41f73
Create Date: 2026-09-18
"""

import sqlalchemy as sa
from alembic import op

revision = "f1a6c27b90d4"
down_revision = "e5b2c8a41f73"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "organizations",
        sa.Column(
            "player_pin_security_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade():
    # Drops one preference column. No credential, attempt, answer or result is
    # touched: an organization that had it on simply stops being protected,
    # which is exactly what turning the setting off does.
    op.drop_column("organizations", "player_pin_security_enabled")
