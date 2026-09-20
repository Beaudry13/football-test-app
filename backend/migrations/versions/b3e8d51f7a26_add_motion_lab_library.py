"""Motion Lab library: organization-owned plays and looks, and motion folders

Motion Lab moves from browser storage to PEIRA. Three changes, all additive:

1. `folders.area` - "quizzes" | "motion". ONE folder system with two separate
   trees. Every existing folder becomes "quizzes" through the server default,
   which is exactly what it already is, so no quiz folder changes. varchar +
   CHECK rather than a native enum (CLAUDE.md #8).
2. `motion_plays` - a play's authored intent as JSONB, owned by an
   organization, with a revision counter for safe concurrent editing.
3. `motion_looks` - saved starting arrangements, likewise.

No backfill: nothing existed before. Browser-stored prototype plays are not
imported by this migration.

Revision ID: b3e8d51f7a26
Revises: f1a6c27b90d4
Create Date: 2026-09-16

RE-POINTED 20 Sep 2026, when master was merged into the Motion Lab branch.
This revision and f1a6c27b90d4 (organization Player PIN Security) were both
authored against e5b2c8a41f73, so together they were two Alembic heads and
`flask db upgrade` would have refused to run. Re-pointing this one behind the
PIN revision restores a single line rather than leaving a merge node in the
graph forever.

Safe to re-point rather than merge because Motion Lab has never been deployed:
this revision has never run on production, whose chain ends at f1a6c27b90d4.
The two are operationally independent anyway - the PIN revision adds a column
to `organizations`, this one adds `folders.area` and the motion tables - so
the order they run in changes nothing.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b3e8d51f7a26"
down_revision = "f1a6c27b90d4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "folders",
        sa.Column("area", sa.String(length=16), nullable=False, server_default="quizzes"),
    )
    op.create_check_constraint("ck_folders_area", "folders", "area IN ('quizzes', 'motion')")
    op.create_index("ix_folders_area", "folders", ["area"])

    op.create_table(
        "motion_plays",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("created_by_coach_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("folder_id", sa.Integer(), nullable=True),
        sa.Column("copied_from_play_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        # SET NULL: plays are the organization's, not the coach's.
        sa.ForeignKeyConstraint(["created_by_coach_id"], ["coaches.id"], ondelete="SET NULL"),
        # SET NULL: deleting a folder returns its plays to the Library root.
        sa.ForeignKeyConstraint(["folder_id"], ["folders.id"], ondelete="SET NULL"),
        # Provenance only: deleting the original must not touch its copies.
        sa.ForeignKeyConstraint(
            ["copied_from_play_id"], ["motion_plays.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_motion_plays_organization_id", "motion_plays", ["organization_id"])
    op.create_index("ix_motion_plays_created_by_coach_id", "motion_plays", ["created_by_coach_id"])
    op.create_index("ix_motion_plays_folder_id", "motion_plays", ["folder_id"])

    op.create_table(
        "motion_looks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("created_by_coach_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by_coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_motion_looks_organization_id", "motion_looks", ["organization_id"])
    op.create_index("ix_motion_looks_created_by_coach_id", "motion_looks", ["created_by_coach_id"])


def downgrade():
    op.drop_index("ix_motion_looks_created_by_coach_id", table_name="motion_looks")
    op.drop_index("ix_motion_looks_organization_id", table_name="motion_looks")
    op.drop_table("motion_looks")
    op.drop_index("ix_motion_plays_folder_id", table_name="motion_plays")
    op.drop_index("ix_motion_plays_created_by_coach_id", table_name="motion_plays")
    op.drop_index("ix_motion_plays_organization_id", table_name="motion_plays")
    op.drop_table("motion_plays")
    # Motion folders cannot survive the column that marks them as motion
    # folders: they would silently become quiz folders. Remove them first,
    # deepest-first because parent_folder_id is RESTRICT. (A motion folder only
    # ever has a motion parent - the API enforces it - so leaf-first removal
    # never strands a quiz folder.)
    connection = op.get_bind()
    while True:
        removed = connection.execute(
            sa.text(
                "DELETE FROM folders WHERE area = 'motion' AND id NOT IN "
                "(SELECT parent_folder_id FROM folders WHERE parent_folder_id IS NOT NULL)"
            )
        ).rowcount
        if not removed:
            break
    op.drop_index("ix_folders_area", table_name="folders")
    op.drop_constraint("ck_folders_area", "folders", type_="check")
    op.drop_column("folders", "area")
