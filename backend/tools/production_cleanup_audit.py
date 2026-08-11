"""READ-ONLY production audit: which organizations are ours, and what would
deleting them actually remove.

    python tools/production_cleanup_audit.py

READ-ONLY IS ENFORCED, NOT PROMISED
------------------------------------
The first thing this script does is put the database session into
`TRANSACTION READ ONLY`. Postgres then refuses any INSERT/UPDATE/DELETE/DDL
from this connection - so a careless edit to this file later cannot quietly
become a destructive script. A comment saying "read-only" is a promise; this
is a guarantee the server enforces.

tests/test_production_cleanup_audit.py backs that up two ways: it proves a
write actually raises under the guard, and it hashes every table before and
after a full run to prove nothing changed.

WHAT IT NEVER PRINTS
--------------------
Quiz titles, question text, answers, explanations, coach feedback, drawings,
playbook filenames, document content, player names, grades, password hashes
or invite codes. Coach EMAILS are printed deliberately: deciding which
accounts are ours is the entire purpose, and an id cannot do that.

WHAT IT DOES NOT DO
-------------------
Delete, classify, mark, or change anything. It produces evidence. Cleanup is
a separate, explicitly approved act.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

#: Organizations confirmed by the owner as real customers. Matched
#: case-insensitively on the organization's own registered name.
PROTECTED_ORGS = {"university of cincinnati", "cincinnati"}

#: Coach accounts confirmed by the owner as real people. ANY organization
#: containing one of these is blocked from the delete list outright, even if
#: its name looks like a probe - deleting the organization would delete the
#: coach account with it.
PROTECTED_EMAILS = {
    "brockc35@gmail.com",
    "mjbeaudry13@gmail.com",
    "will.hoge3@gmail.com",
    "sapashe@gmail.com",
}

#: Every record class that belongs to an organization, with the single join
#: path that reaches it. Written out per table rather than derived, because
#: this list doubles as the answer to "what would deleting this remove".
PER_ORG_COUNTS = {
    "coaches": "SELECT count(*) FROM coaches WHERE organization_id=:o",
    "players": "SELECT count(*) FROM players WHERE organization_id=:o",
    "active_players": (
        "SELECT count(*) FROM players WHERE organization_id=:o AND is_active=true"
    ),
    "groups": "SELECT count(*) FROM groups WHERE organization_id=:o",
    "group_players": (
        "SELECT count(*) FROM group_players gp JOIN groups g ON g.id=gp.group_id"
        " WHERE g.organization_id=:o"
    ),
    "folders": "SELECT count(*) FROM folders WHERE organization_id=:o",
    "quizzes": "SELECT count(*) FROM quizzes WHERE organization_id=:o",
    "questions": (
        "SELECT count(*) FROM questions qu JOIN quizzes q ON q.id=qu.quiz_id"
        " WHERE q.organization_id=:o"
    ),
    "question_options": (
        "SELECT count(*) FROM question_options qo JOIN questions qu ON qu.id=qo.question_id"
        " JOIN quizzes q ON q.id=qu.quiz_id WHERE q.organization_id=:o"
    ),
    "question_images": (
        "SELECT count(*) FROM question_images qi JOIN questions qu ON qu.id=qi.question_id"
        " JOIN quizzes q ON q.id=qu.quiz_id WHERE q.organization_id=:o"
    ),
    "question_regions": (
        "SELECT count(*) FROM question_regions qr JOIN questions qu ON qu.id=qr.question_id"
        " JOIN quizzes q ON q.id=qu.quiz_id WHERE q.organization_id=:o"
    ),
    "rosters": (
        "SELECT count(*) FROM rosters r JOIN quizzes q ON q.id=r.quiz_id"
        " WHERE q.organization_id=:o"
    ),
    "roster_players": (
        "SELECT count(*) FROM roster_players rp JOIN rosters r ON r.id=rp.roster_id"
        " JOIN quizzes q ON q.id=r.quiz_id WHERE q.organization_id=:o"
    ),
    "access_codes": (
        "SELECT count(*) FROM access_codes ac JOIN quizzes q ON q.id=ac.quiz_id"
        " WHERE q.organization_id=:o"
    ),
    "access_code_groups": (
        "SELECT count(*) FROM access_code_groups acg"
        " JOIN access_codes ac ON ac.id=acg.access_code_id"
        " JOIN quizzes q ON q.id=ac.quiz_id WHERE q.organization_id=:o"
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
    "grade_audit_logs": (
        "SELECT count(*) FROM grade_audit_logs gal JOIN answers a ON a.id=gal.answer_id"
        " JOIN player_attempts pa ON pa.id=a.attempt_id"
        " JOIN quizzes q ON q.id=pa.quiz_id WHERE q.organization_id=:o"
    ),
    "playbooks": "SELECT count(*) FROM source_documents WHERE organization_id=:o",
    "document_pages": (
        "SELECT count(*) FROM document_pages dp"
        " JOIN source_documents sd ON sd.id=dp.source_document_id"
        " WHERE sd.organization_id=:o"
    ),
    "invites": "SELECT count(*) FROM organization_invites WHERE organization_id=:o",
}

#: The order a deletion would have to run in. There is NO cascade from
#: `organizations` - seven tables reference it with NO ACTION NOT NULL - so a
#: plain DELETE FROM organizations fails outright. Printed as evidence, not
#: executed.
DELETION_ORDER = [
    "grade_audit_logs", "answer_drawings", "answers", "player_attempts",
    "access_code_groups", "access_codes", "roster_players", "rosters",
    "question_regions", "question_images", "question_options", "questions",
    "quizzes", "group_players", "groups", "document_pages", "source_documents",
    "players", "folders (deepest first - parent_folder_id is RESTRICT)",
    "organization_invites", "coaches", "organizations",
]

WIDTH = 100


def enforce_read_only():
    """Pin the whole audit to ONE read-only transaction.

    Not `SET SESSION CHARACTERISTICS` plus a commit: committing hands the
    connection back to SQLAlchemy's pool, so the very next query can run on a
    DIFFERENT connection that never received the setting. The guard would
    then be silently absent for the rest of the run - the exact failure this
    function exists to prevent.

    Holding one transaction open instead means Postgres refuses every write
    for the duration, and as a bonus every number in the report comes from a
    single consistent snapshot rather than drifting under concurrent traffic.
    """
    db.session.rollback()
    connection = db.session.connection()
    connection.exec_driver_sql("SET TRANSACTION READ ONLY")
    mode = connection.exec_driver_sql("SHOW transaction_read_only").scalar()
    if mode != "on":
        raise SystemExit(
            f"Refusing to run: could not enter read-only mode (got {mode!r})."
        )
    return mode


def build_report():
    scalar = lambda s, **p: db.session.execute(sa.text(s), p).scalar() or 0  # noqa: E731

    organizations = db.session.execute(
        sa.text("SELECT id, name, created_at FROM organizations ORDER BY id")
    ).all()

    report, keep_ids, delete_ids = [], [], []
    for org_id, name, created_at in organizations:
        emails = sorted(
            e
            for (e,) in db.session.execute(
                sa.text("SELECT lower(email) FROM coaches WHERE organization_id=:o"), {"o": org_id}
            ).all()
        )
        counts = {key: scalar(sql, o=org_id) for key, sql in PER_ORG_COUNTS.items()}
        hits = sorted(set(emails) & PROTECTED_EMAILS)

        if name.strip().lower() in PROTECTED_ORGS:
            verdict, reason = "KEEP (protected org)", "named by the owner as a real organization"
        elif hits:
            # Deliberately outranks any name-based signal: deleting this
            # organization would delete a real person's coach account.
            verdict, reason = "BLOCKED", "contains protected email(s): " + ", ".join(hits)
        else:
            verdict, reason = "DELETE CANDIDATE", "no protected org name and no protected email"

        (delete_ids if verdict == "DELETE CANDIDATE" else keep_ids).append(org_id)
        report.append(
            {
                "id": org_id,
                "name": name,
                "created_at": created_at.isoformat(),
                "coach_emails": emails,
                "verdict": verdict,
                "reason": reason,
                "protected_email_hits": hits,
                **counts,
            }
        )
    return report, keep_ids, delete_ids


def main(app=None):
    """Run the audit. `app` is injectable so the test suite can point this at
    a scratch database and prove the run changes nothing; production simply
    calls it with no argument."""
    app = app or create_app()
    with app.app_context():
        mode = enforce_read_only()
        scalar = lambda s, **p: db.session.execute(sa.text(s), p).scalar() or 0  # noqa: E731

        report, keep_ids, delete_ids = build_report()

        print("=" * WIDTH)
        print("PEIRA PRODUCTION CLEANUP AUDIT")
        print(f"READ-ONLY ENFORCED BY POSTGRES (transaction_read_only={mode}) - nothing can change")
        print("=" * WIDTH)

        # -- 6. The Beaudry question, answered first because it gates cleanup
        print("\nWHICH ORGANIZATION HOLDS mjbeaudry13@gmail.com?")
        print("-" * WIDTH)
        rows = db.session.execute(
            sa.text(
                "SELECT c.id, c.username, c.role, c.is_platform_owner,"
                " o.id, o.name FROM coaches c JOIN organizations o"
                " ON o.id=c.organization_id WHERE lower(c.email)='mjbeaudry13@gmail.com'"
            )
        ).all()
        if not rows:
            print("  NOT FOUND in production.")
        for coach_id, username, role, is_owner, org_id, org_name in rows:
            print(f"  coach #{coach_id} '{username}'  role={role}  platform_owner={is_owner}")
            print(f"  lives in organization [{org_id}] {org_name!r}")
            print(
                "  => Deleting that organization WOULD DELETE THIS COACH ACCOUNT."
                if org_name.strip().lower() not in PROTECTED_ORGS
                else "  => That organization is on the protected list."
            )

        # -- 1. Per-organization inventory
        print("\n" + "=" * WIDTH)
        print("EVERY ORGANIZATION")
        print("=" * WIDTH)
        for r in report:
            print(f"\n[{r['id']:>3}] {r['name']}")
            print(f"      verdict : {r['verdict']}  ({r['reason']})")
            print(f"      created : {r['created_at'][:19]}")
            print(f"      coaches : {', '.join(r['coach_emails']) or '(none)'}")
            non_zero = {k: r[k] for k in PER_ORG_COUNTS if r[k]}
            print(
                "      records : "
                + ("  ".join(f"{k}={v}" for k, v in non_zero.items()) or "(completely empty)")
            )

        # -- 2. Protected email sweep
        print("\n" + "=" * WIDTH)
        print("PROTECTED EMAIL SWEEP")
        print("=" * WIDTH)
        for email in sorted(PROTECTED_EMAILS):
            found = db.session.execute(
                sa.text(
                    "SELECT c.organization_id, o.name FROM coaches c"
                    " JOIN organizations o ON o.id=c.organization_id"
                    " WHERE lower(c.email)=:e"
                ),
                {"e": email},
            ).all()
            where = ", ".join(f"[{i}] {n}" for i, n in found) or "NOT PRESENT IN PRODUCTION"
            print(f"  {email:<28} -> {where}")

        # -- 4. The two lists
        print("\n" + "=" * WIDTH)
        print("A. SAFE TEST/PROBE ORGANIZATIONS TO DELETE")
        print("=" * WIDTH)
        if not delete_ids:
            print("  (none)")
        for r in report:
            if r["verdict"] == "DELETE CANDIDATE":
                total = sum(r[k] for k in PER_ORG_COUNTS)
                print(
                    f"  [{r['id']:>3}] {r['name'][:40]:<40} {total:>5} records  "
                    f"coaches={r['coaches']} quizzes={r['quizzes']} "
                    f"attempts={r['graded_attempts'] + r['practice_attempts']} "
                    f"playbooks={r['playbooks']}"
                )
        print("\nB. BLOCKED / NEEDS REVIEW")
        for r in report:
            if r["verdict"] != "DELETE CANDIDATE":
                print(f"  [{r['id']:>3}] {r['name'][:40]:<40} {r['verdict']} - {r['reason']}")

        # -- 5. Totals now vs after
        keep = tuple(keep_ids) or (-1,)
        keep_sql = str(keep) if len(keep) > 1 else f"({keep[0]})"
        scoped = lambda s: scalar(s.replace(":KEEP", keep_sql))  # noqa: E731

        before = {
            "organizations": scalar("SELECT count(*) FROM organizations"),
            "coaches": scalar("SELECT count(*) FROM coaches"),
            "active_players": scalar("SELECT count(*) FROM players WHERE is_active=true"),
            "quizzes": scalar("SELECT count(*) FROM quizzes"),
            "graded_attempts": scalar("SELECT count(*) FROM player_attempts WHERE mode='GRADED'"),
            "practice_attempts": scalar(
                "SELECT count(*) FROM player_attempts WHERE mode='PRACTICE'"
            ),
            "playbooks": scalar("SELECT count(*) FROM source_documents"),
            "groups": scalar("SELECT count(*) FROM groups"),
            "folders": scalar("SELECT count(*) FROM folders"),
        }
        after = {
            "organizations": scoped("SELECT count(*) FROM organizations WHERE id IN :KEEP"),
            "coaches": scoped("SELECT count(*) FROM coaches WHERE organization_id IN :KEEP"),
            "active_players": scoped(
                "SELECT count(*) FROM players WHERE organization_id IN :KEEP AND is_active=true"
            ),
            "quizzes": scoped("SELECT count(*) FROM quizzes WHERE organization_id IN :KEEP"),
            "graded_attempts": scoped(
                "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
                " WHERE q.organization_id IN :KEEP AND pa.mode='GRADED'"
            ),
            "practice_attempts": scoped(
                "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
                " WHERE q.organization_id IN :KEEP AND pa.mode='PRACTICE'"
            ),
            "playbooks": scoped(
                "SELECT count(*) FROM source_documents WHERE organization_id IN :KEEP"
            ),
            "groups": scoped("SELECT count(*) FROM groups WHERE organization_id IN :KEEP"),
            "folders": scoped("SELECT count(*) FROM folders WHERE organization_id IN :KEEP"),
        }

        print("\n" + "=" * WIDTH)
        print("TOTALS: NOW vs AFTER THE PROPOSED CLEANUP")
        print("=" * WIDTH)
        print(f"  {'METRIC':<20} {'NOW':>8} {'AFTER':>8} {'REMOVED':>9}")
        for key in before:
            print(f"  {key:<20} {before[key]:>8} {after[key]:>8} {before[key] - after[key]:>9}")

        print("\n  ROLLING WINDOWS AFTER CLEANUP")
        windows = {}
        for days in (7, 30):
            windows[days] = {
                "new_organizations": scoped(
                    "SELECT count(*) FROM organizations WHERE id IN :KEEP"
                    f" AND created_at >= now() - interval '{days} days'"
                ),
                "new_coaches": scoped(
                    "SELECT count(*) FROM coaches WHERE organization_id IN :KEEP"
                    f" AND created_at >= now() - interval '{days} days'"
                ),
                "new_quizzes": scoped(
                    "SELECT count(*) FROM quizzes WHERE organization_id IN :KEEP"
                    f" AND created_at >= now() - interval '{days} days'"
                ),
                "playbooks_uploaded": scoped(
                    "SELECT count(*) FROM source_documents WHERE organization_id IN :KEEP"
                    f" AND created_at >= now() - interval '{days} days'"
                ),
                "graded_submitted": scoped(
                    "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
                    " WHERE q.organization_id IN :KEEP AND pa.mode='GRADED'"
                    f" AND pa.submitted_at >= now() - interval '{days} days'"
                ),
                "practice_submitted": scoped(
                    "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
                    " WHERE q.organization_id IN :KEEP AND pa.mode='PRACTICE'"
                    f" AND pa.submitted_at >= now() - interval '{days} days'"
                ),
            }
            print(
                f"    last {days:>2} days: "
                + "  ".join(f"{k}={v}" for k, v in windows[days].items())
            )

        print("\n  FEATURE ADOPTION AFTER CLEANUP (organizations that have ever used)")
        adoption_sql = {
            "Practice Mode": (
                "SELECT count(DISTINCT o) FROM ("
                " SELECT q.organization_id o FROM access_codes ac JOIN quizzes q"
                " ON q.id=ac.quiz_id WHERE ac.mode='PRACTICE' AND q.organization_id IN :KEEP"
                " UNION SELECT q.organization_id FROM player_attempts pa JOIN quizzes q"
                " ON q.id=pa.quiz_id WHERE pa.mode='PRACTICE' AND q.organization_id IN :KEEP) t"
            ),
            "Playbook Quiz": (
                "SELECT count(DISTINCT organization_id) FROM source_documents"
                " WHERE organization_id IN :KEEP"
            ),
            "Draw Response": (
                "SELECT count(DISTINCT q.organization_id) FROM questions qu"
                " JOIN quizzes q ON q.id=qu.quiz_id"
                " WHERE qu.question_type='DRAW_RESPONSE' AND q.organization_id IN :KEEP"
            ),
            "Groups": (
                "SELECT count(DISTINCT organization_id) FROM groups WHERE organization_id IN :KEEP"
            ),
            "Nested Folders": (
                "SELECT count(DISTINCT organization_id) FROM folders"
                " WHERE parent_folder_id IS NOT NULL AND organization_id IN :KEEP"
            ),
        }
        adoption = {label: scoped(sql) for label, sql in adoption_sql.items()}
        for label, value in adoption.items():
            print(f"    {label:<16} {value}")

        # -- Storage that SQL cannot reach
        print("\n" + "=" * WIDTH)
        print("STORAGE OBJECTS SQL WILL NOT REMOVE (Cloudflare R2 / local disk)")
        print("=" * WIDTH)
        storage, any_storage = {}, False
        for org_id in delete_ids:
            images = scalar(PER_ORG_COUNTS["question_images"], o=org_id)
            pages = scalar(PER_ORG_COUNTS["document_pages"], o=org_id)
            photos = scalar(
                "SELECT count(*) FROM players WHERE organization_id=:o AND photo_url IS NOT NULL",
                o=org_id,
            )
            storage[org_id] = {
                "question_images": images,
                "document_pages": pages,
                "player_photos": photos,
            }
            if images or pages or photos:
                any_storage = True
                name = next(r["name"] for r in report if r["id"] == org_id)
                print(
                    f"  [{org_id:>3}] {name[:36]:<36} question_images={images}"
                    f" document_pages={pages} player_photos={photos}"
                )
        if not any_storage:
            print("  None - no candidate organization owns an uploaded object.")

        # -- Cascade evidence
        print("\n" + "=" * WIDTH)
        print("CASCADE REALITY (why removing an organization row directly FAILS)")
        print("=" * WIDTH)
        blockers = db.session.execute(
            sa.text(
                "SELECT tc.table_name, kcu.column_name, rc.delete_rule, c.is_nullable"
                " FROM information_schema.table_constraints tc"
                " JOIN information_schema.key_column_usage kcu"
                "   ON tc.constraint_name = kcu.constraint_name"
                " JOIN information_schema.constraint_column_usage ccu"
                "   ON ccu.constraint_name = tc.constraint_name"
                " JOIN information_schema.referential_constraints rc"
                "   ON rc.constraint_name = tc.constraint_name"
                " JOIN information_schema.columns c"
                "   ON c.table_name = tc.table_name AND c.column_name = kcu.column_name"
                " WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='organizations'"
                " ORDER BY tc.table_name"
            )
        ).all()
        for table, column, rule, nullable in blockers:
            note = "  <== BLOCKS" if rule in ("NO ACTION", "RESTRICT") and nullable == "NO" else ""
            print(f"  {table:<24} {column:<18} ON DELETE {rule:<12} NULLABLE={nullable}{note}")
        print("\n  Required deletion order (children first):")
        for i, table in enumerate(DELETION_ORDER, 1):
            print(f"    {i:>2}. {table}")

        print("\n" + "=" * WIDTH)
        print("JSON (paste this back)")
        print("=" * WIDTH)
        print(
            json.dumps(
                {
                    "report": report,
                    "keep_ids": keep_ids,
                    "delete_ids": delete_ids,
                    "before": before,
                    "after": after,
                    "windows_after": windows,
                    "adoption_after": adoption,
                    "storage_remaining": storage,
                },
                indent=1,
            )
        )


if __name__ == "__main__":
    main()
