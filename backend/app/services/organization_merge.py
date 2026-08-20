"""Merging one organization into another.

THE WHOLE MECHANICAL MERGE IS SEVEN UPDATES AND A DELETE
--------------------------------------------
Only eight tables carry `organization_id`: coaches, players, quizzes, groups,
folders, source_documents, staff_invite_requests, organization_invites.
Everything else - questions, answers, attempts, rosters, access codes,
drawings, document pages, audit logs - is reached THROUGH those eight and needs
no statement at all. Re-pointing them moves the entire organization.

That also means the source organization row deletes cleanly at the end: the
`NO ACTION NOT NULL` references that normally make an organization undeletable
are exactly the ones we just emptied. If that DELETE fails, some
row was missed, and the whole transaction rolls back. THE DATABASE IS THE
FINAL CHECK, not a count we computed ourselves.

WHAT THIS DELIBERATELY DOES NOT DO
-----------------------------------
* No player deduplication. Two Player rows with the same name are not proof
  of one human, and combining them would silently reassign somebody's grades.
  Duplicates are REPORTED and moved intact, ids and history untouched.
* No renaming or de-duplicating of quizzes, groups or folders. None of those
  names is constrained to be unique, so both copies survive side by side.
* No re-parenting of folders. The tree moves whole, so its shape is preserved
  and a cycle is impossible.
* No storage calls. Storage keys are opaque and carry no organization, so
  files follow their rows automatically. A test asserts this module never
  imports or invokes a storage client.

THE SECURITY DECISION
---------------------
A source ADMIN moved as-is becomes an admin of the DESTINATION's data - Admin
View over quizzes and results they could not previously see. Nothing in the
schema prevents it. So every source coach is demoted to MEMBER unless the
platform owner explicitly decides otherwise, per coach, in the acknowledgements.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata

import sqlalchemy as sa

from app.extensions import db
from app.models import Coach, CoachRole, Organization
from app.models.organization_merge import OrganizationMerge

#: The SEVEN organization-owned tables that are re-pointed. The remaining
#: table carrying organization_id - organization_invites - is deleted instead,
#: not moved (see INVITES_TABLE). Order is irrelevant to correctness, since these
#: are independent UPDATEs inside one transaction, but it is fixed so the
#: audit's counts_moved is always keyed the same way.
ORG_OWNED_TABLES = (
    "coaches",
    "players",
    "quizzes",
    "groups",
    "folders",
    "source_documents",
    # A pending staff invite request MOVES rather than being revoked, and the
    # distinction from organization_invites is the whole reason both exist. An
    # invitation is a CREDENTIAL: redirecting one would drop somebody into an
    # organization they never agreed to join. A request is an ASK with no token
    # in it, and the coach who made it is being moved by this same merge - so
    # carrying it across is what keeps their colleague's route in working.
    "staff_invite_requests",
    # Live competitions are re-pointed like anything else the organization
    # owns. Their participants and answers reference the SESSION, not the
    # organization, so they follow without a rule of their own - which is the
    # whole reason the coverage test below is keyed on organization_id.
    "competition_sessions",
)

#: Counted for the preview but NOT re-pointed - unused invitations to a
#: vanishing organization are revoked instead. Redirecting one would drop
#: somebody into an organization they never agreed to join.
INVITES_TABLE = "organization_invites"


class MergeRefused(Exception):
    """Any condition that must stop a merge. Messages are written to be read
    in a confirmation dialog with no other context."""


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------

#: Per-organization record counts. Reached through the one join path that
#: leads to an organization, so nothing can be double-counted or attributed
#: to the wrong tenant.
COUNT_QUERIES = {
    "coaches": "SELECT count(*) FROM coaches WHERE organization_id=:o",
    "players": "SELECT count(*) FROM players WHERE organization_id=:o",
    "quizzes": "SELECT count(*) FROM quizzes WHERE organization_id=:o",
    "competition_sessions": (
        "SELECT count(*) FROM competition_sessions WHERE organization_id=:o"
    ),
    "groups": "SELECT count(*) FROM groups WHERE organization_id=:o",
    "folders": "SELECT count(*) FROM folders WHERE organization_id=:o",
    "playbooks": "SELECT count(*) FROM source_documents WHERE organization_id=:o",
    "invitations": "SELECT count(*) FROM organization_invites WHERE organization_id=:o",
    "questions": (
        "SELECT count(*) FROM questions qu JOIN quizzes q ON q.id=qu.quiz_id"
        " WHERE q.organization_id=:o"
    ),
    "access_codes": (
        "SELECT count(*) FROM access_codes ac JOIN quizzes q ON q.id=ac.quiz_id"
        " WHERE q.organization_id=:o"
    ),
    "graded_attempts": (
        "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
        " WHERE q.organization_id=:o AND pa.mode='GRADED'"
    ),
    "practice_attempts": (
        "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
        " WHERE q.organization_id=:o AND pa.mode='PRACTICE'"
    ),
    "answers": (
        "SELECT count(*) FROM answers a JOIN player_attempts pa ON pa.id=a.attempt_id"
        " JOIN quizzes q ON q.id=pa.quiz_id WHERE q.organization_id=:o"
    ),
    "answer_drawings": (
        "SELECT count(*) FROM answer_drawings ad JOIN answers a ON a.id=ad.answer_id"
        " JOIN player_attempts pa ON pa.id=a.attempt_id"
        " JOIN quizzes q ON q.id=pa.quiz_id WHERE q.organization_id=:o"
    ),
    # Reached through questions -> quizzes, so re-pointing quizzes.
    # organization_id carries these with no UPDATE of their own - the merge
    # needs no new logic. Counted here so the before/after census does not
    # silently under-report an org that had exclusions.
    "question_exclusions": (
        "SELECT count(*) FROM question_exclusions qe"
        " JOIN questions qu ON qu.id=qe.question_id"
        " JOIN quizzes q ON q.id=qu.quiz_id WHERE q.organization_id=:o"
    ),
    "document_pages": (
        "SELECT count(*) FROM document_pages dp"
        " JOIN source_documents sd ON sd.id=dp.source_document_id"
        " WHERE sd.organization_id=:o"
    ),
}


def _scalar(sql, **params):
    """A count. None becomes 0 - correct for counting, wrong for anything else."""
    return db.session.execute(sa.text(sql), params).scalar() or 0


def _name(org_id: int) -> str:
    value = db.session.execute(
        sa.text("SELECT name FROM organizations WHERE id=:o"), {"o": org_id}
    ).scalar()
    return value or ""


def organization_counts(org_id: int) -> dict:
    return {label: _scalar(sql, o=org_id) for label, sql in COUNT_QUERIES.items()}


# ---------------------------------------------------------------------------
# Fingerprint
# ---------------------------------------------------------------------------


def fingerprint(source_id: int, destination_id: int) -> str:
    """A hash of everything a preview described.

    Covers BOTH organizations, so a change to either invalidates the preview -
    a quiz added to the destination between preview and execute means the
    operator approved a picture that no longer exists.

    Includes max(id) alongside counts: a row deleted and another added would
    leave the count unchanged while the contents differ.
    """
    material = {
        "source": organization_counts(source_id),
        "destination": organization_counts(destination_id),
        "source_max": {
            table: _scalar(
                f"SELECT coalesce(max(id), 0) FROM {table} WHERE organization_id=:o",  # noqa: S608
                o=source_id,
            )
            for table in ORG_OWNED_TABLES
        },
        "destination_max": {
            table: _scalar(
                f"SELECT coalesce(max(id), 0) FROM {table} WHERE organization_id=:o",  # noqa: S608
                o=destination_id,
            )
            for table in ORG_OWNED_TABLES
        },
        # Names go through a separate helper: _scalar coerces None to 0 for
        # counting, which would silently turn an organization name into 0.
        "source_name": _name(source_id),
        "destination_name": _name(destination_id),
    }
    encoded = json.dumps(material, sort_keys=True, default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


# ---------------------------------------------------------------------------
# Warnings
# ---------------------------------------------------------------------------


def _normalize(name: str) -> str:
    """Casefold + strip accents, for spotting LIKELY duplicates only.

    This never drives an automatic action. It exists so the operator is told
    "these two names look the same" and can decide; combining people by name
    is exactly the fabrication this feature refuses to perform.
    """
    decomposed = unicodedata.normalize("NFKD", name or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip().casefold()


def possible_duplicate_players(source_id: int, destination_id: int) -> list[dict]:
    """Players whose normalized names appear in BOTH organizations.

    A WARNING ONLY. Same name is not the same person - two schools can each
    have a John Smith, and so can one school. Nothing here is merged.
    """
    def by_name(org_id):
        rows = db.session.execute(
            sa.text(
                "SELECT id, first_name, last_name FROM players WHERE organization_id=:o"
            ),
            {"o": org_id},
        ).all()
        grouped: dict[str, list[int]] = {}
        for player_id, first, last in rows:
            grouped.setdefault(_normalize(f"{first} {last}"), []).append(player_id)
        return grouped

    source, destination = by_name(source_id), by_name(destination_id)
    overlaps = []
    for key in sorted(set(source) & set(destination)):
        overlaps.append(
            {
                "normalized_name": key,
                "source_player_ids": source[key],
                "destination_player_ids": destination[key],
            }
        )
    return overlaps


def name_collisions(source_id: int, destination_id: int) -> list[dict]:
    """Objects sharing a name across the two organizations.

    None of these names is constrained to be unique, so BOTH copies survive
    the merge untouched. Reported so two identical "Linebackers" groups are an
    expectation rather than a surprise.
    """
    checks = {
        "quizzes": ("quizzes", "title"),
        "groups": ("groups", "name"),
        "folders": ("folders", "name"),
    }
    collisions = []
    for label, (table, column) in checks.items():
        rows = db.session.execute(
            sa.text(
                f"SELECT lower({column}) FROM {table} WHERE organization_id=:src"  # noqa: S608
                f" INTERSECT SELECT lower({column}) FROM {table} WHERE organization_id=:dst"
            ),
            {"src": source_id, "dst": destination_id},
        ).all()
        for (value,) in rows:
            collisions.append({"type": label, "name": value})
    return collisions


def coach_role_plan(source_id: int, decisions: dict | None = None) -> list[dict]:
    """What happens to each source coach's role.

    MEMBER is the default for everyone, including existing ADMINs. Moving an
    ADMIN as-is would hand them Admin View over the destination's quizzes and
    results - a real widening of access that must be a decision, never a side
    effect. `decisions` maps coach_id -> "ADMIN"|"MEMBER" and is the only way
    to keep an ADMIN.
    """
    decisions = {int(k): v for k, v in (decisions or {}).items()}
    plan = []
    rows = db.session.execute(
        sa.text(
            "SELECT id, username, email, role, is_platform_owner FROM coaches"
            " WHERE organization_id=:o ORDER BY id"
        ),
        {"o": source_id},
    ).all()
    for coach_id, username, email, role, is_owner in rows:
        current = role.value.upper() if hasattr(role, "value") else str(role).upper()
        chosen = str(decisions.get(coach_id, "MEMBER")).upper()
        plan.append(
            {
                "coach_id": coach_id,
                "username": username,
                "email": email,
                "current_role": current,
                "new_role": chosen,
                "is_platform_owner": bool(is_owner),
                # The operator must decide explicitly for anyone who is
                # currently an ADMIN, in either direction.
                "requires_decision": current == "ADMIN",
                "widens_access": chosen == "ADMIN",
            }
        )
    return plan


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


def _load(org_id: int, label: str) -> Organization:
    organization = db.session.get(Organization, org_id)
    if organization is None:
        raise MergeRefused(f"{label} organization {org_id} does not exist")
    return organization


def preview(source_id: int, destination_id: int, decisions: dict | None = None) -> dict:
    """Everything that would happen. Performs ZERO writes."""
    if source_id == destination_id:
        raise MergeRefused("source and destination must be different organizations")

    source = _load(source_id, "source")
    destination = _load(destination_id, "destination")

    source_counts = organization_counts(source_id)
    destination_counts = organization_counts(destination_id)
    coaches = coach_role_plan(source_id, decisions)
    duplicates = possible_duplicate_players(source_id, destination_id)
    collisions = name_collisions(source_id, destination_id)

    warnings = []
    if duplicates:
        warnings.append(
            f"{len(duplicates)} player name(s) appear in both organizations. They will be "
            "moved as separate people with their history intact - nothing is combined."
        )
    if collisions:
        warnings.append(
            f"{len(collisions)} name collision(s). Both copies survive; nothing is renamed "
            "or overwritten."
        )
    if source_counts["invitations"]:
        warnings.append(
            f"{source_counts['invitations']} invitation(s) to the source organization will be "
            "revoked rather than redirected."
        )
    for coach in coaches:
        if coach["widens_access"]:
            warnings.append(
                f"{coach['email']} will KEEP ADMIN and gain Admin View over "
                f"{destination.name}'s data."
            )

    blockers = []
    # A platform owner moving is fine - the flag is per coach and unaffected -
    # but it is surfaced so nobody is surprised by their own account moving.
    resulting = {
        key: destination_counts.get(key, 0) + source_counts.get(key, 0)
        for key in COUNT_QUERIES
    }
    # Invitations are revoked, not moved, so they do not accumulate.
    resulting["invitations"] = destination_counts["invitations"]

    return {
        "source": {"id": source.id, "name": source.name, "counts": source_counts},
        "destination": {
            "id": destination.id,
            "name": destination.name,
            "counts": destination_counts,
        },
        "coaches": coaches,
        "possible_duplicate_players": duplicates,
        "name_collisions": collisions,
        "invitations_to_revoke": source_counts["invitations"],
        "resulting_destination_counts": resulting,
        "warnings": warnings,
        "blockers": blockers,
        "requires_acknowledgement": {
            "collisions": bool(collisions),
            "duplicate_players": bool(duplicates),
            "coach_roles": [c["coach_id"] for c in coaches if c["requires_decision"]],
        },
        "fingerprint": fingerprint(source_id, destination_id),
    }


# ---------------------------------------------------------------------------
# Execute
# ---------------------------------------------------------------------------


def execute(
    source_id: int,
    destination_id: int,
    *,
    expected_fingerprint: str,
    performed_by: Coach,
    decisions: dict | None = None,
    acknowledge_collisions: bool = False,
    acknowledge_duplicate_players: bool = False,
) -> dict:
    """Perform the merge in ONE transaction.

    Every failure path rolls the whole thing back. There is no partial merge
    and no storage side effect to leave behind.
    """
    if source_id == destination_id:
        raise MergeRefused("source and destination must be different organizations")

    source = _load(source_id, "source")
    destination = _load(destination_id, "destination")
    source_name, destination_name = source.name, destination.name

    # -- the preview must still describe reality ---------------------------
    current = fingerprint(source_id, destination_id)
    if current != expected_fingerprint:
        raise MergeRefused(
            "The organizations changed since the preview was generated, so the preview no "
            "longer describes what would happen. Run a fresh preview and review it again."
        )

    plan = preview(source_id, destination_id, decisions)

    # -- every warning must have been acknowledged -------------------------
    if plan["requires_acknowledgement"]["collisions"] and not acknowledge_collisions:
        raise MergeRefused(
            "Name collisions were reported and must be acknowledged before merging."
        )
    if plan["requires_acknowledgement"]["duplicate_players"] and not acknowledge_duplicate_players:
        raise MergeRefused(
            "Possible duplicate players were reported and must be acknowledged before merging."
        )
    decided = {int(k) for k in (decisions or {})}
    undecided = [
        coach["coach_id"]
        for coach in plan["coaches"]
        if coach["requires_decision"] and coach["coach_id"] not in decided
    ]
    if undecided:
        raise MergeRefused(
            f"Source organization admin(s) {undecided} need an explicit role decision "
            "(MEMBER or ADMIN) before merging."
        )

    counts_moved = {}
    try:
        # 1. Revoke source invitations. They are deleted rather than moved:
        #    an accepted link must never drop somebody into an organization
        #    they did not choose.
        invitations_revoked = db.session.execute(
            sa.text("DELETE FROM organization_invites WHERE organization_id=:src"),
            {"src": source_id},
        ).rowcount

        # 2. Drop source staff invite requests the destination is ALREADY
        #    waiting on. `staff_invite_requests` is the only moved table with
        #    an organization-scoped unique index (one pending ask per person
        #    per organization), so without this the UPDATE below would raise
        #    on any person both programs happen to want - and a merge would
        #    fail for a reason that has nothing to do with merging.
        #
        #    Nothing is lost: the identical ask already exists on the side
        #    everything is moving to.
        db.session.execute(
            sa.text(
                "DELETE FROM staff_invite_requests s "
                "WHERE s.organization_id=:src "
                "  AND s.approved_at IS NULL AND s.declined_at IS NULL "
                "  AND EXISTS (SELECT 1 FROM staff_invite_requests d "
                "              WHERE d.organization_id=:dst AND d.email=s.email "
                "                AND d.approved_at IS NULL AND d.declined_at IS NULL)"
            ),
            {"dst": destination_id, "src": source_id},
        )

        # 3. Re-point the seven remaining organization-owned tables. Everything
        #    beneath them follows without a statement.
        for table in ORG_OWNED_TABLES:
            moved = db.session.execute(
                sa.text(
                    f"UPDATE {table} SET organization_id=:dst WHERE organization_id=:src"  # noqa: S608
                ),
                {"dst": destination_id, "src": source_id},
            ).rowcount
            counts_moved[table] = moved

        # 4. Apply the role decisions. Done through the ORM so the native
        #    enum is written exactly as the model defines it.
        role_decisions = []
        for coach in plan["coaches"]:
            record = db.session.get(Coach, coach["coach_id"])
            if record is None:  # pragma: no cover - defensive
                raise MergeRefused(f"coach {coach['coach_id']} vanished mid-merge")
            record.role = CoachRole.ADMIN if coach["new_role"] == "ADMIN" else CoachRole.MEMBER
            role_decisions.append(
                {
                    "coach_id": coach["coach_id"],
                    "email": coach["email"],
                    "previous_role": coach["current_role"],
                    "new_role": coach["new_role"],
                }
            )

        # 5. The permanent record, written INSIDE the transaction so a
        #    rollback cannot leave an audit row for a merge that never
        #    happened.
        audit = OrganizationMerge(
            source_organization_id=source_id,
            source_organization_name=source_name,
            destination_organization_id=destination_id,
            destination_organization_name=destination_name,
            performed_by_coach_id=performed_by.id,
            performed_by_email=performed_by.email,
            fingerprint=expected_fingerprint,
            counts_moved=counts_moved,
            coach_role_decisions=role_decisions,
            invitations_revoked=invitations_revoked,
            collision_warnings=plan["name_collisions"],
            duplicate_player_warnings=plan["possible_duplicate_players"],
            outcome="SUCCESS",
        )
        db.session.add(audit)
        db.session.flush()

        # 6. The source organization must now delete cleanly. If ANY row
        #    still points at it the foreign keys refuse - which is the real
        #    proof that nothing was left behind, better than any count we
        #    could compute ourselves.
        removed = db.session.execute(
            sa.text("DELETE FROM organizations WHERE id=:src"), {"src": source_id}
        ).rowcount
        if removed != 1:
            raise MergeRefused(
                "the source organization did not delete cleanly - rolling back"
            )

        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    return {
        "merged": True,
        "audit_id": audit.id,
        "source": {"id": source_id, "name": source_name},
        "destination": {"id": destination_id, "name": destination_name},
        "counts_moved": counts_moved,
        "invitations_revoked": invitations_revoked,
        "coach_role_decisions": role_decisions,
        "resulting_destination_counts": organization_counts(destination_id),
    }
