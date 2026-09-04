"""Record clip objects that stop being live, so they can eventually be reclaimed

Replacing or removing a clip deletes the `question_clips` row and leaves the
stored object alone, because a delivered snapshot may still name its
`storage_key`. The side effect is that the key vanishes from the database
entirely at that moment, so nothing can ever ask "which stored clips does
nothing reference?" - the live tables can only list keys that ARE referenced.

This table is that missing record. It is a CANDIDATE list, not a delete list:
reachability is re-decided at collection time against `question_clips` AND
`attempt_question_snapshots`. See `services/clip_gc.py`.

No backfill. Objects orphaned before this existed are not in it and stay.
Manufacturing rows would mean guessing which stored objects were clips, and
guessing wrong there deletes a coach's playbook page.

Revision ID: c7f41a9d5e60
Revises: a4c1d7e93b28
Create Date: 2026-09-03
"""

import sqlalchemy as sa
from alembic import op

revision = "c7f41a9d5e60"
down_revision = "a4c1d7e93b28"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "unlinked_clip_objects",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        sa.Column("question_id", sa.Integer(), nullable=True),
        sa.Column(
            "unlinked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=True),
        # SET NULL, not CASCADE: deleting a question is one of the ways an
        # object becomes unlinked, so cascading would erase exactly the rows
        # that deletion just created.
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    # NOT unique. A duplicate row is harmless - the collector de-duplicates and
    # re-checks reachability - whereas a unique violation would turn a coach's
    # ordinary "remove this clip" into a 500.
    op.create_index(
        "ix_unlinked_clip_objects_storage_key",
        "unlinked_clip_objects",
        ["storage_key"],
    )
    # The collector's own scan: everything not yet reclaimed, oldest first.
    op.create_index(
        "ix_unlinked_clip_objects_uncollected",
        "unlinked_clip_objects",
        ["unlinked_at"],
        postgresql_where=sa.text("collected_at IS NULL"),
    )


def downgrade():
    op.drop_index("ix_unlinked_clip_objects_uncollected", table_name="unlinked_clip_objects")
    op.drop_index("ix_unlinked_clip_objects_storage_key", table_name="unlinked_clip_objects")
    op.drop_table("unlinked_clip_objects")
