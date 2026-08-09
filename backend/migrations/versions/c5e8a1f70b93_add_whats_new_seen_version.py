"""Add coaches.whats_new_seen_version

Per-coach read state for What's New, so a coach who reads the release notes
on a laptop does not see them unread on a phone.

Nullable with no default and no backfill, which is the point: NULL means
"never opened", so every coach that exists when this deploys sees the unread
indicator once, exactly as intended.

Purely additive; downgrade is a clean drop.

Revision ID: c5e8a1f70b93
Revises: a91c3e7d40f5
Create Date: 2026-08-09
"""

import sqlalchemy as sa
from alembic import op

revision = "c5e8a1f70b93"
down_revision = "a91c3e7d40f5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "coaches",
        sa.Column("whats_new_seen_version", sa.String(length=32), nullable=True),
    )


def downgrade():
    op.drop_column("coaches", "whats_new_seen_version")
