"""Add question_regions and Fill in the Blank answer columns

Separate from a7e1c4b93d20 because that one added the FILL_BLANK enum value and
Postgres will not let a value be used in the transaction that created it. This
revision only adds tables and columns, so it is fully reversible.

Revision ID: b8f2d5c04e31
Revises: a7e1c4b93d20
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b8f2d5c04e31"
down_revision = "a7e1c4b93d20"
branch_labels = None
depends_on = None


def upgrade():
    # Nullable, and only ever populated for FILL_BLANK. Not a separate table:
    # unlike a region (which the roadmap will want several of per question),
    # a question has exactly one set of accepted answers, and splitting a
    # one-to-one out costs a join on every read for no future flexibility.
    op.add_column(
        "questions",
        sa.Column("expected_answers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("questions", sa.Column("answer_matching", sa.String(length=32), nullable=True))

    op.create_table(
        "question_regions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("question_id", sa.Integer(), nullable=False),
        sa.Column("document_page_id", sa.Integer(), nullable=False),
        # The extension point for polygons; only 'rect' exists today.
        sa.Column(
            "shape", sa.String(length=16), nullable=False, server_default="rect"
        ),
        # NORMALISED 0-1, not pixels. A region stays correct across a re-render
        # at any DPI, which is possible here because the source PDF is kept.
        # See app/services/document_geometry.py for the full contract.
        sa.Column("x", sa.Float(), nullable=False),
        sa.Column("y", sa.Float(), nullable=False),
        sa.Column("width", sa.Float(), nullable=False),
        sa.Column("height", sa.Float(), nullable=False),
        # mask / focus / crop. Stored rather than inferred from the question
        # type, so a masked multiple choice is expressible without a migration.
        sa.Column("role", sa.String(length=16), nullable=False, server_default="mask"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        # Derived cache of the masked render. Safe to delete at any time.
        sa.Column("masked_image_key", sa.String(length=512), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"], ondelete="CASCADE"),
        # RESTRICT, not CASCADE: deleting a source document whose pages are
        # still referenced by live quiz questions must fail loudly rather than
        # quietly destroying those questions' only image. The documents route
        # turns that into a readable refusal.
        sa.ForeignKeyConstraint(
            ["document_page_id"], ["document_pages.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_question_regions_question_id", "question_regions", ["question_id"])
    # "What else is on this page" - the editor's per-page question list, and
    # the join a future region-analytics feature would use.
    op.create_index(
        "ix_question_regions_document_page_id", "question_regions", ["document_page_id"]
    )


def downgrade():
    op.drop_index("ix_question_regions_document_page_id", table_name="question_regions")
    op.drop_index("ix_question_regions_question_id", table_name="question_regions")
    op.drop_table("question_regions")
    op.drop_column("questions", "answer_matching")
    op.drop_column("questions", "expected_answers")
