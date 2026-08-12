"""Add Competition Mode session, participants and answers

Three new tables. NOTHING EXISTING IS TOUCHED - no column added to
player_attempts, no value added to any enum, no index rebuilt.

WHY COMPETITION GETS ITS OWN TABLES
------------------------------------
A competition has state a quiz attempt has no room for: a lobby, a current
round, a server deadline, points, a rank. Bolting those onto PlayerAttempt
would distort a table that four analytics surfaces already read.

More importantly it makes analytics isolation STRUCTURAL. Competition never
writes to player_attempts or answers, so official Results, cumulative
reports, Player Profile, the grading queue and quiz averages cannot see it -
not because a filter excludes it, but because the rows are not there. A
filter can be forgotten; an absent row cannot.

STATUS IS VARCHAR + CHECK, NOT A NATIVE ENUM
---------------------------------------------
Same reasoning as assessment_mode. A Postgres enum is a one-way door - values
cannot be removed, and ALTER TYPE ... ADD VALUE cannot run in the transaction
that created the type. A live-session state machine is exactly the kind of
thing that gains a state later, so a CHECK constraint keeps that an ordinary
reversible migration.

THE TWO UNIQUE CONSTRAINTS ARE THE PRODUCT RULES
-------------------------------------------------
One participant per canonical player per session, and one answer per
participant per round, are enforced by the DATABASE. A refresh, a double-tap
or two phones cannot produce a second identity or a second answer, whatever
the application layer believes.

Revision ID: b8e41c7d92a3
Revises: a2f5c91d64e7
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "b8e41c7d92a3"
down_revision = "a2f5c91d64e7"
branch_labels = None
depends_on = None

#: The live-session states. Kept in the migration as a literal so the CHECK
#: constraint is readable here rather than only in the model.
_STATUSES = (
    "LOBBY",
    "QUESTION_OPEN",
    "QUESTION_REVEAL",
    "LEADERBOARD",
    "COMPLETE",
    "ABANDONED",
)


def upgrade():
    op.create_table(
        "competition_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        # Tenancy first: every read is scoped by it, exactly like quizzes.
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("coach_id", sa.Integer(), nullable=True),
        sa.Column("quiz_id", sa.Integer(), nullable=False),
        sa.Column("join_code", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="LOBBY"),
        # Bumped on EVERY state change. The one-second poll compares this and
        # nothing else, so the hot path stays a single indexed row read.
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("current_round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("question_time_seconds", sa.Integer(), nullable=False, server_default="20"),
        # M2 fills these; declared now so rounds need no schema surgery later.
        sa.Column("question_opened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("question_closes_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        # An abandoned lobby must not live forever - see services/competition.
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["coach_id"], ["coaches.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["quiz_id"], ["quizzes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            " OR ".join(f"status = '{status}'" for status in _STATUSES),
            name="ck_competition_sessions_status",
        ),
    )
    # A join code is typed by a player on a phone and must resolve in one
    # indexed lookup; unique because it IS the address of the session.
    op.create_index(
        "ix_competition_sessions_join_code",
        "competition_sessions",
        ["join_code"],
        unique=True,
    )
    op.create_index(
        "ix_competition_sessions_organization_id",
        "competition_sessions",
        ["organization_id"],
    )

    op.create_table(
        "competition_participants",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        # CANONICAL identity. Never a typed nickname, never a fuzzy name
        # match - the same rule the roster work already established.
        sa.Column("player_id", sa.Integer(), nullable=False),
        # Snapshotted so the lobby still reads correctly if the player is
        # renamed or deactivated mid-session.
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        # M2 scoring columns, declared now for the same reason as the timer.
        sa.Column("total_points", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("current_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("best_streak", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(["session_id"], ["competition_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["player_id"], ["players.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # THE RULE: one seat per person. A refresh or a second phone cannot
        # produce a second participant, whatever the client tries.
        sa.UniqueConstraint("session_id", "player_id", name="uq_competition_participant"),
    )
    op.create_index(
        "ix_competition_participants_session_id", "competition_participants", ["session_id"]
    )

    op.create_table(
        "competition_answers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("participant_id", sa.Integer(), nullable=False),
        sa.Column("question_id", sa.Integer(), nullable=False),
        sa.Column("round_index", sa.Integer(), nullable=False),
        sa.Column("selected_option_id", sa.Integer(), nullable=True),
        sa.Column("answer_text", sa.Text(), nullable=True),
        sa.Column("is_correct", sa.Boolean(), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=False),
        # The audit trail for a score: how fast, and what that earned. Stored
        # so a disputed result can be explained rather than recomputed from
        # assumptions.
        sa.Column("response_ms", sa.Integer(), nullable=False),
        sa.Column("points_awarded", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["competition_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["participant_id"], ["competition_participants.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["question_id"], ["questions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # One answer per player per round, enforced by the database.
        sa.UniqueConstraint(
            "session_id", "participant_id", "round_index", name="uq_competition_answer_per_round"
        ),
    )
    op.create_index("ix_competition_answers_session_id", "competition_answers", ["session_id"])


def downgrade():
    op.drop_table("competition_answers")
    op.drop_table("competition_participants")
    op.drop_index("ix_competition_sessions_organization_id", table_name="competition_sessions")
    op.drop_index("ix_competition_sessions_join_code", table_name="competition_sessions")
    op.drop_table("competition_sessions")
