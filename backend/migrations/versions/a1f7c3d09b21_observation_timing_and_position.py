"""Record when an answer happened, how long it took, and who the player was then

Revision ID: a1f7c3d09b21
Revises: e5c2a71bd490

PHASE A, PART 1. Three nullable columns, no backfill, no new table.

NULL MEANS "NOT RECORDED", NEVER "ZERO". Every attempt that already exists
predates all three of these, and manufacturing values for them would invent
history - the same rule the delivered-question snapshots follow.

answers.answered_at
    When the player first committed an answer to this question. Stamped once,
    on the first write, and never moved by a later edit or autosave retry -
    "when did they answer" is a different question from "when did this row
    last change".

answers.time_to_answer_ms
    Elapsed milliseconds from the question being PUT IN FRONT OF THE PLAYER to
    that first commit. Measured on the client, because the server cannot see
    when a question appeared on a phone.

    Recorded ONLY for one-question-at-a-time delivery, and NULL otherwise. In
    an all-at-once quiz every question is on screen from the moment the page
    loads, so "time to answer question 7" would silently include the time
    spent reading and answering questions 1 to 6. That is a different quantity
    wearing this column's name, and mixing the two would make the column
    useless for exactly the analysis it exists to support.

player_attempts.position_at_attempt
    The player's roster position when the attempt STARTED. players.position is
    live and editable: move a player from CB to S in October and, without
    this, every September result silently re-attributes itself. Copied at the
    attempt rather than onto every answer because a position cannot change
    part-way through one attempt, so per-answer copies would add rows and no
    historical value.

    NULL where the attempt has no linked player (a legacy free-text name) or
    the player has no position recorded. NULL is honest; a guess is not.
"""

import sqlalchemy as sa
from alembic import op

revision = "a1f7c3d09b21"
down_revision = "e5c2a71bd490"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("answers", sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("answers", sa.Column("time_to_answer_ms", sa.Integer(), nullable=True))
    op.add_column(
        "player_attempts",
        # Same width as players.position, which it is a copy of.
        sa.Column("position_at_attempt", sa.String(length=10), nullable=True),
    )


def downgrade():
    op.drop_column("player_attempts", "position_at_attempt")
    op.drop_column("answers", "time_to_answer_ms")
    op.drop_column("answers", "answered_at")
