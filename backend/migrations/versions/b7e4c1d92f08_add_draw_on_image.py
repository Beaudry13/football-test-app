"""Add Draw on Image: questions.allow_drawing + answer_drawings

Deliberately introduces NO new value on the `questiontype` native Postgres
enum. Adding one would need ALTER TYPE ... ADD VALUE, which cannot be used
in the same transaction that adds it - and Alembic wraps this migration in
one. A boolean flag on the existing question avoids that entirely, and
composes better anyway: a multiple-choice question can ask for a drawing
AND an option.

Both changes are purely additive and default to off, so every existing
question and answer is unaffected and the downgrade is clean.

Revision ID: b7e4c1d92f08
Revises: 8b2f61c9a4d3
"""

import sqlalchemy as sa
from alembic import op

revision = "b7e4c1d92f08"
down_revision = "8b2f61c9a4d3"
branch_labels = None
depends_on = None


def upgrade():
    # server_default false (not just a Python-side default) so the NOT NULL
    # holds for every pre-existing row without a backfill pass.
    op.add_column(
        "questions",
        sa.Column(
            "allow_drawing",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.create_table(
        "answer_drawings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("answer_id", sa.Integer(), nullable=False),
        sa.Column("strokes", sa.JSON(), nullable=False),
        # NOT NULL: a stroke array without the coordinate space it was
        # authored in is unrenderable. There is no legacy data here to
        # accommodate, unlike question_images.canvas_width.
        sa.Column("canvas_width", sa.Integer(), nullable=False),
        sa.Column("canvas_height", sa.Integer(), nullable=False),
        # What the player actually drew on - a coach can replace a
        # question's image afterwards.
        sa.Column("source_image_url", sa.String(length=1024), nullable=False),
        # Nullable: the flattened composite is a cache for thumbnails and
        # the PDF, never the record of truth.
        sa.Column("preview_url", sa.String(length=1024), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        # CASCADE so a coach resetting an attempt (which deletes its
        # answers) takes the drawings with it rather than orphaning them.
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
    op.drop_column("questions", "allow_drawing")
