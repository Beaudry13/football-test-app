"""Remove the approved test/probe organizations from production.

    python tools/production_cleanup.py             # DRY RUN - changes nothing
    python tools/production_cleanup.py --execute   # destructive

DRY RUN IS THE DEFAULT, AND IT IS ENFORCED
-------------------------------------------
Without --execute the script pins itself to a `SET TRANSACTION READ ONLY`
transaction, exactly like the audit: Postgres refuses every write, so a dry
run cannot change anything even if this file is later edited carelessly. It
also never constructs a storage client, so it cannot delete an object either.

THE DELETE SET IS A FIXED LIST, NOT A HEURISTIC
------------------------------------------------
APPROVED_DELETE_IDS is the exact set the owner approved after reading the
audit. This tool never decides that something "looks like" a test
organization. If production no longer matches what was audited - an id
missing, an organization renamed, a coach moved - it FAILS CLOSED and
explains, rather than improvising.

WHY DATABASE FIRST AND STORAGE SECOND
--------------------------------------
R2 cannot join a Postgres transaction, so true all-or-nothing across both is
impossible. Of the two orderings, only one has a harmless failure mode:

  * DB first, then storage: a storage failure leaves orphaned objects. They
    cost a little space, belong to organizations that no longer exist, and
    can be swept later. Nothing in the app can reach them.
  * Storage first, then DB: a DB failure leaves live rows pointing at files
    that are gone - a broken product for a real customer.

So the rows go first, in ONE transaction that either fully commits or fully
rolls back, and the object keys are collected BEFORE that transaction (they
live in the rows being deleted). Any storage deletion that fails is reported
loudly with its exact key so it can be finished by hand.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

# ---------------------------------------------------------------------------
# The approved plan. Every constant here came from the owner's review of
# tools/production_cleanup_audit.py output and is deliberately hard-coded.
# ---------------------------------------------------------------------------

APPROVED_DELETE_IDS = frozenset({1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17})

PROTECTED_ORG_IDS = frozenset({2, 11})

PROTECTED_EMAILS = frozenset(
    {
        "brockc35@gmail.com",
        "mjbeaudry13@gmail.com",
        "sapashe@gmail.com",
        "will.hoge3@gmail.com",
    }
)

#: Which protected organization each real account must still belong to. A
#: coach having moved since the audit is exactly the kind of drift that should
#: stop the run rather than be worked around.
EXPECTED_EMAIL_ORG = {
    "brockc35@gmail.com": 2,
    "mjbeaudry13@gmail.com": 2,
    "sapashe@gmail.com": 2,
    "will.hoge3@gmail.com": 11,
}

EXPECTED_ORG_NAMES = {2: "University of Cincinnati", 11: "Cincinnati"}

#: The account that must still hold platform ownership afterwards. Named once
#: rather than inlined at both check sites, so the pre-flight and the
#: post-cleanup verification cannot end up asserting different things.
PLATFORM_OWNER_EMAIL = "mjbeaudry13@gmail.com"

#: The owner's approved end state. Checked after execution; a mismatch is
#: reported rather than silently accepted.
EXPECTED_AFTER = {
    "organizations": 2,
    "coaches": 4,
    "active_players": 117,
    "quizzes": 11,
    "graded_attempts": 126,
    "practice_attempts": 0,
    "playbooks": 1,
    "groups": 3,
    "folders": 5,
}

# A belt-and-braces check that runs at import: the two sets must never
# intersect, no matter how either is edited later.
assert not (APPROVED_DELETE_IDS & PROTECTED_ORG_IDS), "approved set includes a protected org"

# ---------------------------------------------------------------------------
# Deletion plan
#
# There is NO cascade from `organizations` - seven tables reference it with
# NO ACTION NOT NULL - so children must go first, in this order. Each entry is
# (label, DELETE statement scoped to the approved organizations). The scoping
# subquery is repeated per statement on purpose: every statement independently
# proves which organizations it touches, so no single edit can widen the blast
# radius of the whole plan.
# ---------------------------------------------------------------------------

ORG_QUIZZES = "SELECT id FROM quizzes WHERE organization_id = ANY(:ids)"
ORG_ATTEMPTS = f"SELECT id FROM player_attempts WHERE quiz_id IN ({ORG_QUIZZES})"
ORG_ANSWERS = f"SELECT id FROM answers WHERE attempt_id IN ({ORG_ATTEMPTS})"
ORG_QUESTIONS = f"SELECT id FROM questions WHERE quiz_id IN ({ORG_QUIZZES})"
ORG_CODES = f"SELECT id FROM access_codes WHERE quiz_id IN ({ORG_QUIZZES})"
ORG_ROSTERS = f"SELECT id FROM rosters WHERE quiz_id IN ({ORG_QUIZZES})"
ORG_DOCS = "SELECT id FROM source_documents WHERE organization_id = ANY(:ids)"

DELETION_PLAN = [
    # Listed explicitly even though attempt_id is ON DELETE CASCADE, for the
    # same reason `answers` is: every statement here proves its own scope, and
    # the per-table counts this tool reports back are how an operator checks
    # what actually went. A table removed only by cascade is a table the report
    # silently says nothing about.
    (
        "attempt_question_snapshots",
        f"DELETE FROM attempt_question_snapshots WHERE attempt_id IN ({ORG_ATTEMPTS})",
    ),
    ("grade_audit_logs", f"DELETE FROM grade_audit_logs WHERE answer_id IN ({ORG_ANSWERS})"),
    ("answer_drawings", f"DELETE FROM answer_drawings WHERE answer_id IN ({ORG_ANSWERS})"),
    ("answers", f"DELETE FROM answers WHERE attempt_id IN ({ORG_ATTEMPTS})"),
    ("player_attempts", f"DELETE FROM player_attempts WHERE quiz_id IN ({ORG_QUIZZES})"),
    ("access_code_groups", f"DELETE FROM access_code_groups WHERE access_code_id IN ({ORG_CODES})"),
    ("access_codes", f"DELETE FROM access_codes WHERE quiz_id IN ({ORG_QUIZZES})"),
    ("roster_players", f"DELETE FROM roster_players WHERE roster_id IN ({ORG_ROSTERS})"),
    ("rosters", f"DELETE FROM rosters WHERE quiz_id IN ({ORG_QUIZZES})"),
    ("question_regions", f"DELETE FROM question_regions WHERE question_id IN ({ORG_QUESTIONS})"),
    ("question_images", f"DELETE FROM question_images WHERE question_id IN ({ORG_QUESTIONS})"),
    ("question_options", f"DELETE FROM question_options WHERE question_id IN ({ORG_QUESTIONS})"),
    ("questions", f"DELETE FROM questions WHERE quiz_id IN ({ORG_QUIZZES})"),
    ("quizzes", "DELETE FROM quizzes WHERE organization_id = ANY(:ids)"),
    (
        "group_players",
        "DELETE FROM group_players WHERE group_id IN"
        " (SELECT id FROM groups WHERE organization_id = ANY(:ids))",
    ),
    ("groups", "DELETE FROM groups WHERE organization_id = ANY(:ids)"),
    ("document_pages", f"DELETE FROM document_pages WHERE source_document_id IN ({ORG_DOCS})"),
    ("source_documents", "DELETE FROM source_documents WHERE organization_id = ANY(:ids)"),
    ("players", "DELETE FROM players WHERE organization_id = ANY(:ids)"),
    # folders handled separately - parent_folder_id is RESTRICT, so they must
    # be removed deepest-first rather than in one statement.
    ("organization_invites", "DELETE FROM organization_invites WHERE organization_id = ANY(:ids)"),
    ("coaches", "DELETE FROM coaches WHERE organization_id = ANY(:ids)"),
    ("organizations", "DELETE FROM organizations WHERE id = ANY(:ids)"),
]

#: Removes the deepest folder layer each pass. `folders.parent_folder_id` is
#: RESTRICT, so a single DELETE would fail on any nested folder; looping until
#: no rows are affected handles arbitrary depth without assuming a maximum.
LEAF_FOLDERS = (
    "DELETE FROM folders WHERE organization_id = ANY(:ids)"
    " AND id NOT IN (SELECT parent_folder_id FROM folders"
    " WHERE parent_folder_id IS NOT NULL)"
)

WIDTH = 96


def rule(title=""):
    print("=" * WIDTH)
    if title:
        print(title)
        print("=" * WIDTH)


# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------


class Refused(Exception):
    """Raised for any condition that must stop the cleanup. Every message is
    written to be actionable on its own, because it will be read in a shell
    with no other context."""


def preflight(ids):
    """Everything that must be true before a single row is deleted.

    Collects ALL failures rather than raising on the first, so one run tells
    the operator everything that is wrong instead of one thing at a time.
    """
    failures = []
    scalar = lambda s, **p: db.session.execute(sa.text(s), p).scalar()  # noqa: E731

    # -- the two sets must not overlap, however they were edited
    overlap = APPROVED_DELETE_IDS & PROTECTED_ORG_IDS
    if overlap:
        failures.append(f"approved delete set contains protected organization(s) {sorted(overlap)}")

    # -- protected organizations still exist, with the expected names
    for org_id, expected_name in EXPECTED_ORG_NAMES.items():
        actual = scalar("SELECT name FROM organizations WHERE id=:id", id=org_id)
        if actual is None:
            failures.append(f"protected organization {org_id} no longer exists")
        elif actual.strip().lower() != expected_name.strip().lower():
            failures.append(
                f"organization {org_id} is named {actual!r}, expected {expected_name!r}"
            )

    # -- every protected account is where the audit found it
    for email, expected_org in EXPECTED_EMAIL_ORG.items():
        row = db.session.execute(
            sa.text(
                "SELECT organization_id, role, is_platform_owner FROM coaches"
                " WHERE lower(email)=:e"
            ),
            {"e": email},
        ).first()
        if row is None:
            failures.append(f"protected account {email} no longer exists")
            continue
        org_id, role, is_owner = row
        if org_id != expected_org:
            failures.append(
                f"protected account {email} is in organization {org_id}, expected {expected_org}"
            )
        if org_id in APPROVED_DELETE_IDS:
            failures.append(
                f"CRITICAL: protected account {email} is inside an organization "
                f"scheduled for deletion ({org_id})"
            )
        if email == PLATFORM_OWNER_EMAIL:
            if not is_owner:
                failures.append(f"{email} is no longer platform_owner")
            if not str(role).upper().endswith("ADMIN"):
                failures.append(f"{email} role is {role!r}, expected ADMIN")

    # -- no protected email anywhere in the delete set, by any route
    stray = db.session.execute(
        sa.text(
            "SELECT lower(email), organization_id FROM coaches"
            " WHERE organization_id = ANY(:ids) AND lower(email) = ANY(:emails)"
        ),
        {"ids": list(ids), "emails": list(PROTECTED_EMAILS)},
    ).all()
    for email, org_id in stray:
        failures.append(f"CRITICAL: {email} found in organization {org_id}, which is in the plan")

    # -- production still matches what was audited
    present = {
        row[0]
        for row in db.session.execute(
            sa.text("SELECT id FROM organizations WHERE id = ANY(:ids)"), {"ids": list(ids)}
        ).all()
    }
    missing = set(ids) - present
    if missing:
        failures.append(
            f"approved organization(s) {sorted(missing)} no longer exist - production has "
            "changed since the audit, so the plan is stale"
        )

    total = scalar("SELECT count(*) FROM organizations")
    expected_total = len(ids) + len(PROTECTED_ORG_IDS)
    if total != expected_total:
        failures.append(
            f"production holds {total} organizations; the audit covered {expected_total}. "
            "A new organization appeared - re-run the audit and re-approve before cleaning up."
        )

    return failures


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def collect_storage_targets(ids):
    """The EXACT objects owned by the approved organizations.

    Every key is read from a row that belongs to one of those organizations -
    there is no prefix matching and no name guessing, so an object belonging
    to University of Cincinnati or Cincinnati cannot be selected by accident.

    Must run BEFORE the deletion transaction: these keys live in the rows the
    transaction removes.
    """
    rows = lambda s: db.session.execute(sa.text(s), {"ids": list(ids)}).all()  # noqa: E731

    question_images = [
        r[0]
        for r in rows(
            "SELECT qi.image_url FROM question_images qi"
            " JOIN questions qu ON qu.id = qi.question_id"
            " JOIN quizzes q ON q.id = qu.quiz_id"
            " WHERE q.organization_id = ANY(:ids) AND qi.image_url IS NOT NULL"
        )
    ]
    player_photos = [
        r[0]
        for r in rows(
            "SELECT photo_url FROM players"
            " WHERE organization_id = ANY(:ids) AND photo_url IS NOT NULL"
        )
    ]
    document_keys = [
        r[0]
        for r in rows(
            "SELECT storage_key FROM source_documents"
            " WHERE organization_id = ANY(:ids) AND storage_key IS NOT NULL"
        )
    ]
    page_keys = [
        r[0]
        for r in rows(
            "SELECT dp.image_key FROM document_pages dp"
            " JOIN source_documents sd ON sd.id = dp.source_document_id"
            " WHERE sd.organization_id = ANY(:ids) AND dp.image_key IS NOT NULL"
        )
    ] + [
        r[0]
        for r in rows(
            "SELECT dp.thumbnail_key FROM document_pages dp"
            " JOIN source_documents sd ON sd.id = dp.source_document_id"
            " WHERE sd.organization_id = ANY(:ids) AND dp.thumbnail_key IS NOT NULL"
        )
    ]
    return {
        "public_images": question_images + player_photos,
        "private_keys": document_keys + page_keys,
    }


def assert_no_protected_storage_overlap(targets, ids):
    """A protected organization must not own any key we are about to delete.

    Belt and braces: the collection queries are already organization-scoped,
    but a shared or duplicated key would be catastrophic and cheap to rule
    out.
    """
    protected = set()
    for sql in (
        "SELECT qi.image_url FROM question_images qi"
        " JOIN questions qu ON qu.id = qi.question_id"
        " JOIN quizzes q ON q.id = qu.quiz_id"
        " WHERE q.organization_id = ANY(:ids) AND qi.image_url IS NOT NULL",
        "SELECT photo_url FROM players"
        " WHERE organization_id = ANY(:ids) AND photo_url IS NOT NULL",
        "SELECT storage_key FROM source_documents"
        " WHERE organization_id = ANY(:ids) AND storage_key IS NOT NULL",
    ):
        protected |= {
            r[0]
            for r in db.session.execute(
                sa.text(sql), {"ids": list(PROTECTED_ORG_IDS)}
            ).all()
        }

    doomed = set(targets["public_images"]) | set(targets["private_keys"])
    shared = doomed & protected
    if shared:
        raise Refused(
            f"CRITICAL: {len(shared)} storage object(s) are referenced by BOTH a protected "
            f"organization and one scheduled for deletion: {sorted(shared)[:5]}"
        )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def current_counts(ids):
    scalar = lambda s, **p: db.session.execute(sa.text(s), p).scalar() or 0  # noqa: E731
    return {
        label: scalar(sql.replace(":KEEP", "ANY(:ids)"), ids=list(ids))
        for label, sql in {
            "organizations": "SELECT count(*) FROM organizations WHERE id = :KEEP",
            "coaches": "SELECT count(*) FROM coaches WHERE organization_id = :KEEP",
            "players": "SELECT count(*) FROM players WHERE organization_id = :KEEP",
            "quizzes": "SELECT count(*) FROM quizzes WHERE organization_id = :KEEP",
            "groups": "SELECT count(*) FROM groups WHERE organization_id = :KEEP",
            "folders": "SELECT count(*) FROM folders WHERE organization_id = :KEEP",
            "playbooks": "SELECT count(*) FROM source_documents WHERE organization_id = :KEEP",
        }.items()
    }


def platform_totals():
    scalar = lambda s: db.session.execute(sa.text(s)).scalar() or 0  # noqa: E731
    return {
        "organizations": scalar("SELECT count(*) FROM organizations"),
        "coaches": scalar("SELECT count(*) FROM coaches"),
        "active_players": scalar("SELECT count(*) FROM players WHERE is_active = true"),
        "quizzes": scalar("SELECT count(*) FROM quizzes"),
        "graded_attempts": scalar("SELECT count(*) FROM player_attempts WHERE mode='GRADED'"),
        "practice_attempts": scalar("SELECT count(*) FROM player_attempts WHERE mode='PRACTICE'"),
        "playbooks": scalar("SELECT count(*) FROM source_documents"),
        "groups": scalar("SELECT count(*) FROM groups"),
        "folders": scalar("SELECT count(*) FROM folders"),
    }


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_after(ids):
    """Everything the owner listed as a post-condition. Returns problems."""
    problems = []
    scalar = lambda s, **p: db.session.execute(sa.text(s), p).scalar()  # noqa: E731

    remaining = {
        r[0] for r in db.session.execute(sa.text("SELECT id FROM organizations ORDER BY id")).all()
    }
    if remaining != set(PROTECTED_ORG_IDS):
        problems.append(f"organizations remaining are {sorted(remaining)}, expected [2, 11]")

    still_there = sorted(set(ids) & remaining)
    if still_there:
        problems.append(f"approved organizations still present: {still_there}")

    coaches = scalar("SELECT count(*) FROM coaches")
    if coaches != EXPECTED_AFTER["coaches"]:
        problems.append(f"{coaches} coaches remain, expected {EXPECTED_AFTER['coaches']}")

    for email, org_id in EXPECTED_EMAIL_ORG.items():
        found = scalar("SELECT organization_id FROM coaches WHERE lower(email)=:e", e=email)
        if found != org_id:
            problems.append(f"protected account {email} is now in organization {found!r}")

    # Gated on the owner actually being one of the protected accounts, so the
    # same code path is exercised by synthetic fixtures that have no platform
    # owner of their own.
    if PLATFORM_OWNER_EMAIL in EXPECTED_EMAIL_ORG:
        owner_ok = scalar(
            "SELECT is_platform_owner FROM coaches WHERE lower(email)=:e",
            e=PLATFORM_OWNER_EMAIL,
        )
        if not owner_ok:
            problems.append(f"{PLATFORM_OWNER_EMAIL} is no longer platform_owner")

    # No orphan rows anywhere referencing a deleted organization.
    for table in ("coaches", "players", "groups", "folders", "quizzes", "source_documents",
                  "organization_invites"):
        left = scalar(
            f"SELECT count(*) FROM {table} WHERE organization_id = ANY(:ids)",  # noqa: S608
            ids=list(ids),
        )
        if left:
            problems.append(f"{left} row(s) remain in {table} for deleted organizations")

    totals = platform_totals()
    for key, expected in EXPECTED_AFTER.items():
        if totals.get(key) != expected:
            problems.append(f"total {key} is {totals.get(key)}, approved plan expected {expected}")

    return problems, totals


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run(execute: bool, app=None):
    app = app or create_app()
    ids = sorted(APPROVED_DELETE_IDS)

    with app.app_context():
        if not execute:
            # A dry run cannot write, because Postgres will not let it.
            db.session.rollback()
            connection = db.session.connection()
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            mode = connection.exec_driver_sql("SHOW transaction_read_only").scalar()
            if mode != "on":
                raise Refused("could not enter read-only mode for the dry run")

        rule("PEIRA PRODUCTION CLEANUP  -  " + ("EXECUTE" if execute else "DRY RUN (no changes)"))
        print(f"  approved delete set : {ids}")
        print(f"  protected orgs      : {sorted(PROTECTED_ORG_IDS)}")
        print(f"  protected accounts  : {', '.join(sorted(PROTECTED_EMAILS))}")

        print("\nPRE-FLIGHT CHECKS")
        print("-" * WIDTH)
        failures = preflight(ids)
        if failures:
            for f in failures:
                print(f"  REFUSED: {f}")
            raise Refused(
                f"{len(failures)} pre-flight check(s) failed - nothing was changed. "
                "Re-run the audit and re-approve."
            )
        print("  all pre-flight checks passed")

        before = platform_totals()
        doomed = current_counts(ids)
        targets = collect_storage_targets(ids)
        assert_no_protected_storage_overlap(targets, ids)

        print("\nWHAT WOULD BE REMOVED" if not execute else "\nWHAT IS BEING REMOVED")
        print("-" * WIDTH)
        for label, count in doomed.items():
            print(f"  {label:<16} {count}")

        print("\nSTORAGE OBJECTS TARGETED (exact keys, org-scoped)")
        print("-" * WIDTH)
        print(f"  public images (question images + player photos): {len(targets['public_images'])}")
        for url in targets["public_images"]:
            print(f"     {url.rsplit('/', 1)[-1]}")
        print(f"  private keys (playbook files + page renders)   : {len(targets['private_keys'])}")
        for key in targets["private_keys"]:
            print(f"     {key}")

        print("\nPLATFORM TOTALS")
        print("-" * WIDTH)
        print(f"  {'METRIC':<20} {'NOW':>8} {'APPROVED AFTER':>16}")
        for key, expected in EXPECTED_AFTER.items():
            print(f"  {key:<20} {before.get(key, 0):>8} {expected:>16}")

        if not execute:
            print("\n" + "=" * WIDTH)
            print("DRY RUN COMPLETE - nothing was changed.")
            print("To execute:  python tools/production_cleanup.py --execute")
            print("=" * WIDTH)
            db.session.rollback()
            return {"executed": False, "targets": targets, "doomed": doomed}

        # -- destructive from here -------------------------------------------
        print("\nDELETING (one transaction - all of it, or none of it)")
        print("-" * WIDTH)
        deleted = {}
        try:
            for label, statement in DELETION_PLAN:
                if label == "organizations":
                    # Folders must go before the organization row, and they
                    # need their own loop.
                    passes = 0
                    while True:
                        removed = db.session.execute(
                            sa.text(LEAF_FOLDERS), {"ids": ids}
                        ).rowcount
                        deleted["folders"] = deleted.get("folders", 0) + removed
                        passes += 1
                        if removed == 0:
                            break
                        if passes > 50:
                            raise Refused("folder deletion did not converge - aborting")
                    print(f"  {'folders':<22} {deleted.get('folders', 0)}")
                count = db.session.execute(sa.text(statement), {"ids": ids}).rowcount
                deleted[label] = count
                print(f"  {label:<22} {count}")
            db.session.commit()
            print("\n  DATABASE TRANSACTION COMMITTED")
        except Exception as exc:
            db.session.rollback()
            print(f"\n  DATABASE ERROR - transaction rolled back, nothing deleted: {exc}")
            print("  No storage objects were touched.")
            raise

        # -- storage, only after the rows are gone ---------------------------
        print("\nSTORAGE CLEANUP (after commit - see the module docstring)")
        print("-" * WIDTH)
        storage_failures = []
        from app.services.file_storage import get_file_storage
        from app.services.private_storage import get_private_storage

        public = get_file_storage()
        for url in targets["public_images"]:
            try:
                public.delete_image(url)
                print(f"  removed  {url.rsplit('/', 1)[-1]}")
            except Exception as exc:  # noqa: BLE001 - reported, never fatal
                storage_failures.append((url, str(exc)))
        if targets["private_keys"]:
            private = get_private_storage()
            for key in targets["private_keys"]:
                try:
                    private.delete_private(key)
                    print(f"  removed  {key}")
                except Exception as exc:  # noqa: BLE001
                    storage_failures.append((key, str(exc)))
        if storage_failures:
            print("\n  THESE OBJECTS COULD NOT BE REMOVED - delete them by hand:")
            for key, error in storage_failures:
                print(f"    {key}  ({error})")
            print("  The database cleanup is committed and correct; these are orphans only.")

        # -- verification ----------------------------------------------------
        print("\nPOST-CLEANUP VERIFICATION")
        print("-" * WIDTH)
        problems, totals = verify_after(ids)
        for key, value in totals.items():
            flag = "" if value == EXPECTED_AFTER.get(key) else "   <== NOT AS APPROVED"
            print(f"  {key:<20} {value}{flag}")
        if problems:
            print("\n  PROBLEMS:")
            for p in problems:
                print(f"    - {p}")
            raise Refused(f"{len(problems)} post-cleanup check(s) failed - review immediately")
        print("\n  every post-cleanup check passed")

        rule("CLEANUP COMPLETE")
        return {
            "executed": True,
            "deleted": deleted,
            "targets": targets,
            "storage_failures": storage_failures,
            "totals": totals,
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Remove approved test organizations.")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="actually delete. Without this the script only reports.",
    )
    args = parser.parse_args(argv)
    try:
        run(execute=args.execute)
    except Refused as exc:
        print(f"\nREFUSED: {exc}")
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
