"""Add question_clips.decision_point_ms

WHERE THE FILM STOPS SO THE PLAYER CAN DECIDE.

Football recognition is tested BEFORE the outcome exists - identify the
coverage, the fit, the leverage, the responsibility - and a clip that plays
through to the whistle answers its own question. A decision point stops the
film at the moment the player would actually have to decide.

ADDITIVE AND NULLABLE, SO THERE IS NOTHING TO BACKFILL. NULL keeps its
existing meaning by construction: an ordinary Record Clip that autoplays and
loops, exactly as every clip recorded before today does. A value makes it a
decision-point clip. No existing row changes and no existing behaviour moves.

Not a new question type, deliberately. What changes is how the film is
PRESENTED; the answer semantics - written, multiple choice, fill blank - are
untouched, and a new type would have multiplied against every one of them.

Revision ID: a4c1d7e93b28
Revises: f7a3c91b2e40
"""

import sqlalchemy as sa
from alembic import op

revision = "a4c1d7e93b28"
down_revision = "f7a3c91b2e40"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "question_clips",
        sa.Column("decision_point_ms", sa.Integer(), nullable=True),
    )


def downgrade():
    op.drop_column("question_clips", "decision_point_ms")
