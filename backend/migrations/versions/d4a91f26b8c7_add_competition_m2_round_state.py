"""Competition M2.1: frozen question order, scoring version, podium state

Three columns and one widened CHECK constraint. No existing column changes
type, and nothing is dropped.

WHY question_order EXISTS
--------------------------
Rounds must NOT index into quiz.questions live. A coach who edits the quiz
while a competition is running would otherwise shift every later round, so a
player's answer to round 4 would be scored against a different question than
the one they saw. The order is therefore snapshotted the moment the first
question starts, exactly as Practice Mode freezes PlayerAttempt.question_order
for the same reason.

WHY scoring_version EXISTS
---------------------------
A score has to stay explainable after the formula changes. Recording which
version produced it means a future model cannot silently rewrite the meaning
of an old competition's standings - the row says how it was calculated.

WHY THE CHECK CONSTRAINT IS EASY TO WIDEN
------------------------------------------
This is the payoff for M1's decision to use VARCHAR + CHECK rather than a
native Postgres enum. Adding PODIUM is an ordinary reversible migration.
ALTER TYPE ... ADD VALUE would have been a one-way door that also cannot run
in the transaction that created the type (CLAUDE.md).

Revision ID: d4a91f26b8c7
Revises: c3f7a15e8b40
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "d4a91f26b8c7"
down_revision = "c3f7a15e8b40"
branch_labels = None
depends_on = None

_OLD_STATUSES = (
    "LOBBY",
    "QUESTION_OPEN",
    "QUESTION_REVEAL",
    "LEADERBOARD",
    "COMPLETE",
    "ABANDONED",
)

#: PODIUM is a real server state rather than a client animation because the
#: reveal is coach-paced and every phone in the room must agree on which place
#: has been shown. Sequencing it client-side would desync the room.
_NEW_STATUSES = _OLD_STATUSES[:4] + ("PODIUM",) + _OLD_STATUSES[4:]

_CONSTRAINT = "ck_competition_sessions_status"


def _status_check(statuses) -> str:
    return " OR ".join(f"status = '{status}'" for status in statuses)


def upgrade():
    op.add_column(
        "competition_sessions",
        # The snapshot of which questions this competition plays, in order.
        # Empty until the first question starts.
        sa.Column("question_order", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "competition_sessions",
        sa.Column("scoring_version", sa.SmallInteger(), nullable=False, server_default="1"),
    )
    op.add_column(
        "competition_sessions",
        # 0 = "competition complete" card, 1 = 3rd, 2 = 2nd, 3 = 1st,
        # 4 = full standings. Coach-advanced, so every client agrees.
        sa.Column("podium_step", sa.SmallInteger(), nullable=False, server_default="0"),
    )

    op.drop_constraint(_CONSTRAINT, "competition_sessions", type_="check")
    op.create_check_constraint(_CONSTRAINT, "competition_sessions", _status_check(_NEW_STATUSES))


def downgrade():
    # Any session sitting in PODIUM would violate the narrower constraint, so
    # it is moved to COMPLETE first. PODIUM is immediately before COMPLETE in
    # the lifecycle, so this loses a presentation step and no result data.
    op.execute("UPDATE competition_sessions SET status = 'COMPLETE' WHERE status = 'PODIUM'")

    op.drop_constraint(_CONSTRAINT, "competition_sessions", type_="check")
    op.create_check_constraint(_CONSTRAINT, "competition_sessions", _status_check(_OLD_STATUSES))

    op.drop_column("competition_sessions", "podium_step")
    op.drop_column("competition_sessions", "scoring_version")
    op.drop_column("competition_sessions", "question_order")
