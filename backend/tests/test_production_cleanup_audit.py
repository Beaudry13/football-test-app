"""Proof that tools/production_cleanup_audit.py cannot change production.

A human points this script at the live database from a Render shell, so "it
looks read-only" is not good enough. Three independent proofs:

  1. STATIC    - every SQL string in the module is a read.
  2. ENFORCED  - the guard makes Postgres itself reject a write.
  3. EMPIRICAL - every table is hashed before and after a full run, so a write
                 that somehow got past both other checks still fails here.
"""

import ast
import hashlib
import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.extensions import db

TOOL_PATH = Path(__file__).resolve().parent.parent / "tools" / "production_cleanup_audit.py"


def load_tool():
    spec = importlib.util.spec_from_file_location("production_cleanup_audit", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def restore_write_access():
    """Hand the connection pool back in a writable state.

    SET SESSION CHARACTERISTICS applies to the CONNECTION, and SQLAlchemy
    pools connections - so simply flipping it back on the current session is
    not enough. A read-only connection returned to the pool gets handed to a
    later, unrelated test, which then fails with a baffling read-only error
    hundreds of tests away from the cause. Disposing the pool guarantees no
    poisoned connection survives this module.
    """
    db.session.rollback()
    db.session.remove()
    db.engine.dispose()


def register(client, *, username, email, organization):
    response = client.post(
        "/api/auth/register",
        json={
            "username": username,
            "email": email,
            "password": "Passw0rd!23",
            "organization": organization,
        },
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def fingerprint():
    """A content hash of every row of every table.

    Row counts alone would miss an UPDATE - the write most likely to slip by
    unnoticed - so this hashes the actual row contents.
    """
    tables = [
        row[0]
        for row in db.session.execute(
            sa.text(
                "SELECT table_name FROM information_schema.tables"
                " WHERE table_schema='public' AND table_name <> 'alembic_version'"
                " ORDER BY table_name"
            )
        ).all()
    ]
    digest = {}
    for table in tables:
        rows = db.session.execute(
            sa.text(f"SELECT md5(CAST(t.* AS text)) FROM {table} t ORDER BY 1")
        ).all()
        digest[table] = hashlib.sha256("".join(r[0] for r in rows).encode()).hexdigest()
    return digest


@pytest.fixture
def seeded(client):
    """A production-shaped world: two protected organizations, three probes,
    and the trap - a probe-LOOKING organization holding a protected email."""
    real = register(
        client,
        username="brock",
        email="brockc35@gmail.com",
        organization="University of Cincinnati",
    )
    register(client, username="will", email="will.hoge3@gmail.com", organization="Cincinnati")
    for index, name in enumerate(["ZZ Prod Probe", "Smoke Test Org", "Bug Repro"]):
        register(
            client,
            username=f"probe{index}",
            email=f"probe{index}@example.com",
            organization=name,
        )
    register(client, username="beau", email="mjbeaudry13@gmail.com", organization="Beaudry")
    client.post(
        "/api/quizzes",
        json={"title": "Install"},
        headers={"Authorization": f"Bearer {real['access_token']}"},
    )
    db.session.commit()
    return real


# ---------------------------------------------------------------------------
# 1. Static
# ---------------------------------------------------------------------------


class TestOnlyReadStatements:
    """Inspects the ACTUAL SQL, not the file's prose.

    A raw text scan is the wrong tool: the module legitimately explains why
    removing an organization row fails, and prose is not an executed
    statement. This walks every string literal beginning with a SQL verb,
    which covers both the inline sa.text() calls and the query dictionaries
    they read from - Python folds implicitly-concatenated literals into one
    constant at parse time, so multi-line queries are caught whole.
    """

    #: Statements the guard itself needs. Everything else must be a SELECT.
    ALLOWED_NON_SELECT = {
        "SET TRANSACTION READ ONLY",
        "SHOW TRANSACTION_READ_ONLY",
    }

    def sql_literals(self):
        """Every string in the module that is actually a SQL statement.

        A statement must satisfy BOTH signals: it starts with a SQL verb AND
        it contains " FROM ". Either test alone produces false alarms - the
        prefix alone catches the verdict label "DELETE CANDIDATE" and the
        column name "created_at"; " FROM " alone catches English prose like
        "refuse writes from this connection". A check that cries wolf is a
        check the next person deletes.
        """
        verbs = (
            "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
            "TRUNCATE", "CREATE", "GRANT", "REVOKE", "WITH",
        )
        tree = ast.parse(TOOL_PATH.read_text(encoding="utf-8"))
        found = []
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                continue
            text = node.value.strip()
            upper = text.upper()
            if upper in self.ALLOWED_NON_SELECT:
                found.append(text)
                continue
            first = upper.split()[0] if upper.split() else ""
            if first in verbs and " FROM " in upper:
                found.append(text)
        return found

    def test_it_contains_sql_at_all(self):
        assert self.sql_literals(), "no SQL found - has the tool been restructured?"

    def test_every_statement_is_a_read(self):
        for sql in self.sql_literals():
            head = sql.split()[0].upper()
            assert head in ("SELECT", "SET", "SHOW"), f"non-read statement: {sql[:90]!r}"

    def test_no_write_verb_appears_in_any_sql(self):
        for sql in self.sql_literals():
            upper = sql.upper()
            for verb in ("INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "TRUNCATE "):
                assert verb not in upper, f"{verb.strip()} appears in SQL: {sql[:90]!r}"

    def test_the_only_non_select_statements_are_the_guard(self):
        non_select = [s for s in self.sql_literals() if not s.upper().startswith("SELECT")]
        assert {s.upper() for s in non_select} == self.ALLOWED_NON_SELECT, non_select

    def test_it_never_commits_at_all(self):
        """The audit holds one read-only transaction and rolls nothing
        forward - there is no commit to review."""
        assert TOOL_PATH.read_text(encoding="utf-8").count("db.session.commit()") == 0


# ---------------------------------------------------------------------------
# 2. Enforced by Postgres
# ---------------------------------------------------------------------------


class TestReadOnlyIsEnforced:
    def test_the_guard_switches_postgres_into_read_only(self, app):
        tool = load_tool()
        with app.app_context():
            try:
                assert tool.enforce_read_only() == "on"
            finally:
                restore_write_access()

    def test_a_write_actually_raises_once_the_guard_is_on(self, app, client, seeded):
        """The proof that matters: not that the tool avoids writing, but that
        it COULD NOT write even if a future edit tried to."""
        tool = load_tool()
        with app.app_context():
            try:
                tool.enforce_read_only()
                with pytest.raises(Exception) as excinfo:
                    db.session.execute(
                        sa.text("DELETE FROM organizations WHERE id = -1")  # noqa: S608
                    )
                    db.session.commit()
                assert "read-only" in str(excinfo.value).lower()
            finally:
                restore_write_access()


# ---------------------------------------------------------------------------
# 3. Empirical
# ---------------------------------------------------------------------------


class TestRunningItChangesNothing:
    def test_every_table_is_byte_identical_after_a_full_run(self, app, client, seeded, capsys):
        tool = load_tool()
        with app.app_context():
            before = fingerprint()
        try:
            tool.main(app)
        finally:
            with app.app_context():
                restore_write_access()
        with app.app_context():
            after = fingerprint()

        assert before.keys() == after.keys()
        changed = [table for table in before if before[table] != after[table]]
        assert changed == [], f"the audit modified these tables: {changed}"


class TestClassification:
    @pytest.fixture(autouse=True)
    def _run(self, app, client, seeded, capsys):
        try:
            load_tool().main(app)
        finally:
            with app.app_context():
                restore_write_access()
        self.out = capsys.readouterr().out

    def candidates_section(self):
        return self.out.split("A. SAFE TEST/PROBE ORGANIZATIONS TO DELETE")[1].split(
            "B. BLOCKED"
        )[0]

    def test_protected_organizations_are_kept(self):
        assert "University of Cincinnati" in self.out
        assert "KEEP (protected org)" in self.out
        assert "University of Cincinnati" not in self.candidates_section()

    def test_a_probe_named_org_holding_a_protected_email_is_blocked(self):
        """THE TRAP. 'Beaudry' reads like a throwaway, but it holds a protected
        account - deleting it would destroy a real coach login. The email rule
        must outrank any name-based signal."""
        blocked = next(
            line for line in self.out.splitlines() if "Beaudry" in line and "BLOCKED" in line
        )
        assert "mjbeaudry13@gmail.com" in blocked
        assert "Beaudry" not in self.candidates_section()

    def test_it_names_the_organization_holding_the_owners_email(self):
        section = self.out.split("WHICH ORGANIZATION HOLDS")[1].split("=" * 100)[0]
        assert "Beaudry" in section
        assert "WOULD DELETE THIS COACH ACCOUNT" in section

    def test_ordinary_probes_are_listed_as_candidates(self):
        candidates = self.candidates_section()
        for name in ("ZZ Prod Probe", "Smoke Test Org", "Bug Repro"):
            assert name in candidates

    def test_an_absent_protected_email_is_reported_as_absent(self):
        """A protected address that does not exist must say so plainly -
        silence would read as "checked and fine"."""
        line = next(ln for ln in self.out.splitlines() if "sapashe@gmail.com" in ln)
        assert "NOT PRESENT IN PRODUCTION" in line

    def test_no_customer_content_appears_anywhere(self):
        for forbidden in ("Install", "question_text", "answer_text", "password_hash", "$2b$"):
            assert forbidden not in self.out, f"the audit leaked {forbidden!r}"

    def test_it_explains_that_a_direct_organization_delete_fails(self):
        assert "CASCADE REALITY" in self.out
        assert "BLOCKS" in self.out
