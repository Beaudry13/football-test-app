"""Reshape answer_drawings around the versioned DrawingDocument

The table was designed before the document format was, and its columns
duplicate what the envelope already carries: canvas_width/canvas_height
against the document's coordinate_width/coordinate_height, source_image_url
against source.image_id + source.image_version. Two copies of one fact drift,
and the copy outside the versioned envelope is the one that drifts silently.

Dropped and recreated rather than altered, because the table has never held a
row in any environment - no data to preserve, no backfill to get wrong. Doing
this now costs nothing; doing it after Phase 3 starts writing rows would cost
a data migration.

Revision ID: e3c6a9b52d43
Revises: d2b5f8a41c32
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e3c6a9b52d43"
down_revision = "d2b5f8a41c32"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index(op.f("ix_answer_drawings_answer_id"), table_name="answer_drawings")
    op.drop_table("answer_drawings")

    op.create_table(
        "answer_drawings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("answer_id", sa.Integer(), nullable=False),
        # The whole DrawingDocument, envelope included. JSONB rather than JSON
        # so it is queryable later (which strokes touched which region, how
        # many marks) without a schema change, and because the format carries
        # its own `format`/`version` so a reader can refuse what it cannot
        # parse rather than half-render it.
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        # Bumped server-side on every write. The client sends the revision it
        # last saw; a mismatch is a 409 rather than a silent overwrite. This is
        # what stops a phone that spent five minutes in a tunnel clobbering a
        # drawing the player has since redone on another device.
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        # Phase 6. Stays NULL until the PDF export needs a raster - it points
        # at external storage, so unlike the dropped columns it is genuinely a
        # column and not a duplicate of something inside the document.
        sa.Column("preview_url", sa.String(length=1024), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        # Unchanged from the original shape: a coach resetting an attempt
        # deletes its answers, and the drawings must go with them rather than
        # being orphaned.
        sa.ForeignKeyConstraint(["answer_id"], ["answers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("answer_id", name="uq_one_drawing_per_answer"),
    )
    op.create_index(
        op.f("ix_answer_drawings_answer_id"), "answer_drawings", ["answer_id"], unique=False
    )


def downgrade():
    op.drop_index(op.f("ix_answer_drawings_answer_id"), table_name="answer_drawings")
    op.drop_table("answer_drawings")

    # The original shape, restored exactly. Any Phase 3 drawings are lost in
    # the process - there is nowhere in these columns to put a versioned
    # envelope - so this downgrade is only safe on a database that has not
    # collected real drawings yet.
    op.create_table(
        "answer_drawings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("answer_id", sa.Integer(), nullable=False),
        sa.Column("strokes", sa.JSON(), nullable=False),
        sa.Column("canvas_width", sa.Integer(), nullable=False),
        sa.Column("canvas_height", sa.Integer(), nullable=False),
        sa.Column("source_image_url", sa.String(length=1024), nullable=False),
        sa.Column("preview_url", sa.String(length=1024), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        sa.ForeignKeyConstraint(["answer_id"], ["answers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("answer_id", name="uq_one_drawing_per_answer"),
    )
    op.create_index(
        op.f("ix_answer_drawings_answer_id"), "answer_drawings", ["answer_id"], unique=False
    )
