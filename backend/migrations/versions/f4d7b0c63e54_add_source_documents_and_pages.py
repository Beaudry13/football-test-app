"""Add source_documents and document_pages (Playbook Quiz, Milestone 1)

Two new tables, nothing existing touched. Fully reversible - unlike the
questiontype enum additions, which cannot be undone in Postgres, there is no
one-way door here.

NAMING: "document", not "playbook". The machinery serves scouting reports,
install sheets and whiteboard photos as readily as playbooks; only the product
name says Playbook Quiz. See docs/DESIGN-playbook-quiz.md §1.

COORDINATE SPACE: render_width/render_height describe the raster, they do not
define position. Regions (Milestone 2) store normalised 0-1 coordinates and
stay correct if a page is ever re-rendered at another DPI, which is possible
here precisely because the source PDF is retained. See §4a and
app/services/document_geometry.py.

Revision ID: f4d7b0c63e54
Revises: e3c6a9b52d43
"""

import sqlalchemy as sa
from alembic import op

revision = "f4d7b0c63e54"
down_revision = "e3c6a9b52d43"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "source_documents",
        sa.Column("id", sa.Integer(), nullable=False),
        # Tenancy is the organization: a playbook must outlive the coach who
        # uploaded it, so ownership is the program's, not the individual's.
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("uploaded_by_coach_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        # An opaque key into PRIVATE storage. Never a URL, never returned by
        # the API. See app/services/private_storage.py.
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        # SET NULL, not CASCADE: removing a coach must not delete the team's
        # playbooks along with them.
        sa.ForeignKeyConstraint(["uploaded_by_coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_source_documents_organization_id", "source_documents", ["organization_id"]
    )
    # Indexed but NOT unique. The design calls for recognising a byte-identical
    # re-upload and offering to reuse it - a conversation with the coach, not a
    # constraint that refuses their upload outright.
    op.create_index("ix_source_documents_content_hash", "source_documents", ["content_hash"])

    op.create_table(
        "document_pages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_document_id", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        # The page's own size in PDF points - the real invariant. Everything
        # below is derived from these, so a re-render at any DPI starts from
        # the same place the first one did.
        sa.Column("width_pt", sa.Float(), nullable=False),
        sa.Column("height_pt", sa.Float(), nullable=False),
        sa.Column("render_width", sa.Integer(), nullable=False),
        sa.Column("render_height", sa.Integer(), nullable=False),
        sa.Column("render_dpi", sa.Integer(), nullable=False),
        sa.Column("renderer_version", sa.String(length=64), nullable=False),
        # NULL until a coach opens the page: full renders are produced on
        # demand so an unused page of a 200-page playbook costs nothing.
        sa.Column("image_key", sa.String(length=512), nullable=True),
        sa.Column("thumbnail_key", sa.String(length=512), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.ForeignKeyConstraint(
            ["source_document_id"], ["source_documents.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_document_id", "page_number", name="uq_document_page_number"),
    )
    op.create_index(
        "ix_document_pages_source_document_id", "document_pages", ["source_document_id"]
    )


def downgrade():
    op.drop_index("ix_document_pages_source_document_id", table_name="document_pages")
    op.drop_table("document_pages")
    op.drop_index("ix_source_documents_content_hash", table_name="source_documents")
    op.drop_index("ix_source_documents_organization_id", table_name="source_documents")
    op.drop_table("source_documents")
