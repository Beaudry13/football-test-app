"""Concepts: what a question is about

Revision ID: b2e9d51a7c48
Revises: a1f7c3d09b21

PHASE A, PART 2. One table and one nullable column.

No backfill and no default concept. Every existing question keeps concept_id
NULL, which reads as "General" - honest, where guessing a tag for thousands of
questions nobody has classified would not be.

The unique index is CASE-INSENSITIVE and functional (lower(name)) rather than
a stored normalised column: one source of truth for the name, and the coach's
own capitalisation survives. It deliberately does NOT exclude archived rows -
letting an archived name be re-created would produce two concepts meaning the
same thing, which is precisely the split this prevents. Un-archive instead.
"""

import sqlalchemy as sa
from alembic import op

revision = "b2e9d51a7c48"
down_revision = "a1f7c3d09b21"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "concepts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column(
            "is_archived", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_concepts_organization_id", "concepts", ["organization_id"])
    op.create_index(
        "uq_concept_name_per_org",
        "concepts",
        ["organization_id", sa.text("lower(name)")],
        unique=True,
    )

    op.add_column("questions", sa.Column("concept_id", sa.Integer(), nullable=True))
    op.create_index("ix_questions_concept_id", "questions", ["concept_id"])
    op.create_foreign_key(
        "fk_questions_concept_id", "questions", "concepts", ["concept_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_questions_concept_id", "questions", type_="foreignkey")
    op.drop_index("ix_questions_concept_id", table_name="questions")
    op.drop_column("questions", "concept_id")
    op.drop_index("uq_concept_name_per_org", table_name="concepts")
    op.drop_index("ix_concepts_organization_id", table_name="concepts")
    op.drop_table("concepts")
