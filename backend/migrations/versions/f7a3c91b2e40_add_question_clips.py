"""Add question_clips

A short silent looping video as a third source of a question's visual
material, alongside an uploaded still and a playbook page region.

ADDITIVE ONLY. No existing table is altered and nothing is backfilled - a
question without a clip simply has no row, which is what "this question has
no clip" has always meant for images too.

`question_images` is deliberately untouched: it is one-per-question and
carries the pinned Fabric coordinate space, which a clip has no use for.

Revision ID: f7a3c91b2e40
Revises: e5d2f9c4a771
"""

import sqlalchemy as sa
from alembic import op

revision = "f7a3c91b2e40"
down_revision = "e5d2f9c4a771"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "question_clips",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("question_id", sa.Integer(), nullable=False),
        # Opaque private-storage keys, never URLs. 512 matches the headroom
        # question_images.image_url already allows.
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("poster_key", sa.String(length=512), nullable=True),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True
        ),
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"]),
        sa.PrimaryKeyConstraint("id"),
        # One clip per question, matching the image rule. A question with two
        # clips would leave the renderer choosing, and either choice is wrong
        # half the time.
        sa.UniqueConstraint("question_id", name="uq_question_clips_question_id"),
    )
    op.create_index(
        op.f("ix_question_clips_question_id"), "question_clips", ["question_id"], unique=True
    )


def downgrade():
    op.drop_index(op.f("ix_question_clips_question_id"), table_name="question_clips")
    op.drop_table("question_clips")
