"""Installs: the coach's current install, explicitly

Revision ID: f2c9d41e7a58
Revises: a7d4e2c19b63
Create Date: 2026-10-23

CURRENT INSTALL (app/models/install.py). Which install is "this week" is the
coach's choice - Set as current - not whichever one he edited last. One flag
on the install, and a partial unique index so the database itself holds at
most one current install per coach.

Additive and reversible: one boolean column (false for every existing row -
no install becomes current behind anyone's back) and one index. Downgrading
drops both; nothing else depends on them.
"""
import sqlalchemy as sa
from alembic import op

revision = "f2c9d41e7a58"
down_revision = "a7d4e2c19b63"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "installs",
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        "uq_installs_current_per_coach",
        "installs",
        ["coach_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )


def downgrade():
    op.drop_index("uq_installs_current_per_coach", table_name="installs")
    op.drop_column("installs", "is_current")
