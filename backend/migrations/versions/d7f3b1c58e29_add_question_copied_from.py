"""Where a copied question came from - so a retest can say if it stuck

Revision ID: d7f3b1c58e29
Revises: c6e2a9f47d18

EXPERIMENTAL, AND PURELY ADDITIVE. One nullable column.

  questions.copied_from_question_id   On a question copied from another (a
                                      duplicate, a retest, a Rep made from a
                                      quiz), the question it was copied from.
                                      It is what lets a retest of an UNTAGGED
                                      question be compared with the original
                                      ("did it stick?") - concept-tagged
                                      retests compare on the concept. SET NULL
                                      if the source is deleted: the copy stays.
                                      Null on every other question, which is
                                      every existing row.

Downgrade drops the column; questions are untouched.
"""

import sqlalchemy as sa
from alembic import op

revision = "d7f3b1c58e29"
down_revision = "c6e2a9f47d18"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "questions",
        sa.Column(
            "copied_from_question_id",
            sa.Integer(),
            sa.ForeignKey("questions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_questions_copied_from_question_id", "questions", ["copied_from_question_id"])


def downgrade():
    op.drop_index("ix_questions_copied_from_question_id", table_name="questions")
    op.drop_column("questions", "copied_from_question_id")
