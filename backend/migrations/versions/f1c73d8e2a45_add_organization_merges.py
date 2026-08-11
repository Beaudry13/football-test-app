"""Add organization_merges

The permanent record of Owner-performed organization merges.

WHY source_organization_id IS NOT A FOREIGN KEY
------------------------------------------------
A merge deletes the source organization. A foreign key to it could not
survive the operation this row exists to describe, so the id is stored as a
plain integer and the name is snapshotted alongside it.

`destination_organization_id` IS a real FK, but ON DELETE SET NULL with the
name snapshotted too - so the history survives even if the destination is
itself merged away or deleted later.

Purely additive: one new table, no existing column or constraint touched, and
the downgrade drops only what this created.

Revision ID: f1c73d8e2a45
Revises: e4b9d2a71c60
Create Date: 2026-08-11
"""

import sqlalchemy as sa
from alembic import op

revision = "f1c73d8e2a45"
down_revision = "e4b9d2a71c60"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "organization_merges",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_organization_id", sa.Integer(), nullable=False),
        sa.Column("source_organization_name", sa.String(length=255), nullable=False),
        sa.Column("destination_organization_id", sa.Integer(), nullable=True),
        sa.Column("destination_organization_name", sa.String(length=255), nullable=False),
        sa.Column("performed_by_coach_id", sa.Integer(), nullable=True),
        sa.Column("performed_by_email", sa.String(length=255), nullable=False),
        sa.Column("performed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("counts_moved", sa.JSON(), nullable=False),
        sa.Column("coach_role_decisions", sa.JSON(), nullable=False),
        sa.Column("invitations_revoked", sa.Integer(), nullable=False),
        sa.Column("collision_warnings", sa.JSON(), nullable=False),
        sa.Column("duplicate_player_warnings", sa.JSON(), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["destination_organization_id"], ["organizations.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["performed_by_coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade():
    op.drop_table("organization_merges")
