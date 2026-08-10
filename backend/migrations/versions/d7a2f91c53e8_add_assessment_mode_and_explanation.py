"""Add assessment mode, answer explanation, and practice-aware uniqueness

Practice Mode V1. Three columns and two rebuilt indexes.

BACKWARD COMPATIBILITY IS THE POINT
------------------------------------
Both mode columns are NOT NULL with a server default of 'GRADED', so every
existing access code and every existing attempt is graded the moment this
runs. No backfill query, no historical attempt reclassified, and every
official number is identical before and after.

WHY VARCHAR + CHECK RATHER THAN A NATIVE ENUM
----------------------------------------------
A Postgres enum is a one-way door: values cannot be removed, and
`ALTER TYPE ... ADD VALUE` cannot run in the transaction that created the
type - which is why the questiontype migration had to be split. Mode is a
young concept likely to grow, so a CHECK constraint keeps a third mode an
ordinary reversible migration.

THE INDEX REBUILD IS THE INTERESTING PART
------------------------------------------
`player_attempts` enforced one attempt per player per access code through two
partial unique indexes. Practice needs unlimited retakes. Rather than adding
an attempt_number column and teaching the application to count, the two
predicates gain `AND mode = 'GRADED'`: graded keeps exactly-once semantics
enforced by the database, and practice is simply not covered by the
constraint. Unlimited retakes fall out of the schema.

THE DOWNGRADE IS ONE-WAY IN PRACTICE
-------------------------------------
Rolling this back rebuilds those stricter indexes, which cannot succeed once
any player has retaken a practice quiz - the second attempt is exactly the
row the old rule forbade. `downgrade()` therefore checks first and refuses
with an explanation rather than dying on an opaque duplicate-key error.

Before any practice code is activated the rollback is clean, so this is a
constraint on rolling back LATER, not on deploying now. Plan a fix-forward
migration rather than a rollback if something needs changing after players
have used it.

Revision ID: d7a2f91c53e8
Revises: c5e8a1f70b93
Create Date: 2026-08-10
"""

import sqlalchemy as sa
from alembic import op

revision = "d7a2f91c53e8"
down_revision = "c5e8a1f70b93"
branch_labels = None
depends_on = None

_MODES = ("GRADED", "PRACTICE")
_CHECK = " OR ".join(f"mode = '{mode}'" for mode in _MODES)


def upgrade():
    for table in ("access_codes", "player_attempts"):
        op.add_column(
            table,
            sa.Column(
                "mode",
                sa.String(length=16),
                nullable=False,
                server_default="GRADED",
            ),
        )
        op.create_check_constraint(f"ck_{table}_mode", table, sa.text(_CHECK))

    op.add_column("questions", sa.Column("answer_explanation", sa.Text(), nullable=True))
    # The practice lock. Nullable and unset everywhere, so no existing row
    # changes meaning and no graded attempt is affected.
    op.add_column(
        "answers", sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True)
    )

    # Rebuild both uniqueness indexes so they cover GRADED attempts only.
    op.drop_index("uq_legacy_attempt_by_name", table_name="player_attempts")
    op.drop_index("uq_canonical_attempt_by_player", table_name="player_attempts")
    op.create_index(
        "uq_legacy_attempt_by_name",
        "player_attempts",
        ["access_code_id", "player_name"],
        unique=True,
        postgresql_where=sa.text("player_id IS NULL AND mode = 'GRADED'"),
    )
    op.create_index(
        "uq_canonical_attempt_by_player",
        "player_attempts",
        ["access_code_id", "player_id"],
        unique=True,
        postgresql_where=sa.text("player_id IS NOT NULL AND mode = 'GRADED'"),
    )


#: Retakes that the pre-practice uniqueness rule could not have held. Checked
#: as two separate predicates because the two indexes cover disjoint rows:
#: legacy attempts (player_id IS NULL) key on the name, canonical ones on the id.
_RETAKE_PROBES = (
    (
        "uq_canonical_attempt_by_player",
        "SELECT count(*) FROM (SELECT 1 FROM player_attempts"
        " WHERE player_id IS NOT NULL"
        " GROUP BY access_code_id, player_id HAVING count(*) > 1) AS dupes",
    ),
    (
        "uq_legacy_attempt_by_name",
        "SELECT count(*) FROM (SELECT 1 FROM player_attempts"
        " WHERE player_id IS NULL"
        " GROUP BY access_code_id, player_name HAVING count(*) > 1) AS dupes",
    ),
)


def _refuse_if_retakes_exist():
    """Stop with an explanation rather than a raw UniqueViolation.

    THIS MIGRATION IS EFFECTIVELY ONE-WAY ONCE ANYONE HAS RETAKEN A PRACTICE
    QUIZ. Unlimited retakes exist precisely because the old indexes were
    narrowed; rebuilding those indexes over a player's second practice attempt
    cannot succeed, and Postgres reports it as an opaque duplicate-key error
    on an index the operator never mentioned.

    So it is detected up front and named. The fix is a deliberate decision
    about real player data - delete the surplus practice attempts, or stay on
    this revision - and neither is something a migration should quietly pick.
    """
    connection = op.get_bind()
    blocking = []
    for index_name, probe in _RETAKE_PROBES:
        count = connection.execute(sa.text(probe)).scalar() or 0
        if count:
            blocking.append(f"{count} for {index_name}")

    if blocking:
        raise RuntimeError(
            "Cannot downgrade d7a2f91c53e8: practice retakes exist ("
            + "; ".join(blocking)
            + "). The pre-practice unique indexes allow only one attempt per "
            "player per access code, so they cannot be rebuilt over these "
            "rows. Delete the surplus PRACTICE attempts first if you really "
            "mean to roll back - that destroys player work, so it is not done "
            "automatically."
        )


def downgrade():
    _refuse_if_retakes_exist()

    # Restore the original predicates first: they are stricter, and dropping
    # the column out from under them would fail.
    op.drop_index("uq_canonical_attempt_by_player", table_name="player_attempts")
    op.drop_index("uq_legacy_attempt_by_name", table_name="player_attempts")
    op.create_index(
        "uq_legacy_attempt_by_name",
        "player_attempts",
        ["access_code_id", "player_name"],
        unique=True,
        postgresql_where=sa.text("player_id IS NULL"),
    )
    op.create_index(
        "uq_canonical_attempt_by_player",
        "player_attempts",
        ["access_code_id", "player_id"],
        unique=True,
        postgresql_where=sa.text("player_id IS NOT NULL"),
    )

    op.drop_column("answers", "checked_at")
    op.drop_column("questions", "answer_explanation")
    for table in ("player_attempts", "access_codes"):
        op.drop_constraint(f"ck_{table}_mode", table, type_="check")
        op.drop_column(table, "mode")
