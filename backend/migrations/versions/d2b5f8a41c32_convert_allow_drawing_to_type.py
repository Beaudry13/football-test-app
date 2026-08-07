"""Convert allow_drawing questions to DRAW_RESPONSE and drop the column

Drawing shipped as a boolean flag on any question type. It becomes a question
type of its own, so that "is this a drawing question" has exactly one answer
in exactly one place - and so a Draw Response question can later carry its own
requirements (an explanation, a choice) without every other type growing them
too. See docs/DESIGN-draw-response-phase-3.md.

Separate from c1a4e7f30b21 because PostgreSQL forbids using an enum value in
the transaction that added it. That revision adds DRAW_RESPONSE; this one is
the first that may reference it.

Existing option rows on a converted question are deliberately KEPT. They go
inert while the question is DRAW_RESPONSE (nothing reads them), but deleting a
coach's authored answer choices to tidy up a column would destroy work to save
nothing - and the planned combined-response feature will want them back.

Revision ID: d2b5f8a41c32
Revises: c1a4e7f30b21
"""

import sqlalchemy as sa
from alembic import op

revision = "d2b5f8a41c32"
down_revision = "c1a4e7f30b21"
branch_labels = None
depends_on = None


def upgrade():
    # Every question a coach had ticked the old checkbox on becomes the new
    # type. Written as raw SQL against the enum's stored MEMBER NAME - the
    # column holds 'WRITTEN', not 'written' - which is the detail that makes
    # hand-written enum SQL go wrong.
    op.execute(
        """
        UPDATE questions
           SET question_type = 'DRAW_RESPONSE'
         WHERE allow_drawing = TRUE
        """
    )
    op.drop_column("questions", "allow_drawing")


def downgrade():
    # Reversible in shape: the column comes back and the converted questions
    # get their flag again. What cannot come back is which type they were
    # BEFORE conversion (WRITTEN, MULTIPLE_CHOICE, ...), because that fact was
    # overwritten. They all return as WRITTEN, which is the safest landing
    # spot: it accepts free text, needs no options, and never silently marks a
    # player's answer wrong the way a restored multiple-choice question could.
    op.add_column(
        "questions",
        sa.Column("allow_drawing", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        """
        UPDATE questions
           SET allow_drawing = TRUE,
               question_type = 'WRITTEN'
         WHERE question_type = 'DRAW_RESPONSE'
        """
    )
