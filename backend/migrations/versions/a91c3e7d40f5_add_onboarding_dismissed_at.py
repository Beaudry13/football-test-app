"""Add coaches.onboarding_dismissed_at

The one piece of onboarding state that is persisted. Every checklist step is
derived from real application data on each request (see
app/services/onboarding.py) precisely so that existing accounts get a correct
checklist with no backfill - this column carries only the coach's choice to
hide it early, which no amount of data inspection could tell us.

Purely additive and nullable, so it needs no data migration and downgrade is
a clean drop.

Revision ID: a91c3e7d40f5
Revises: b8f2d5c04e31
Create Date: 2026-08-09
"""

import sqlalchemy as sa
from alembic import op

revision = "a91c3e7d40f5"
down_revision = "b8f2d5c04e31"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "coaches",
        sa.Column("onboarding_dismissed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_column("coaches", "onboarding_dismissed_at")
