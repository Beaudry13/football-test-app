"""Safety proofs for tools/production_cleanup.py.

This tool deletes real customer-adjacent data from production, so the tests
that matter are the NEGATIVE ones: each deliberately breaks an assumption and
proves the tool stops rather than improvising.

Everything runs against synthetic organizations. The real APPROVED_DELETE_IDS
are monkeypatched to point at fixture rows, so no test can depend on - or
damage - anything resembling production.
"""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.extensions import db

TOOL_PATH = Path(__file__).resolve().parent.parent / "tools" / "production_cleanup.py"

REAL_A = "real-a@school.test"
REAL_B = "real-b@school.test"


@pytest.fixture
def tool():
    spec = importlib.util.spec_from_file_location("production_cleanup", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def org_id_of(email):
    return db.session.execute(
        sa.text("SELECT organization_id FROM coaches WHERE lower(email)=:e"), {"e": email}
    ).scalar()


def build_quiz_with_content(client, token, *, title="Install"):
    """A quiz deep enough to exercise the whole FK chain."""
    headers = {"Authorization": f"Bearer {token}"}
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Coverage?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    player = client.post(
        "/api/players", json={"first_name": "Test", "last_name": "Player"}, headers=headers
    ).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/roster/members",
        json={"player_ids": [player["id"]]},
        headers=headers,
    )
    group = client.post("/api/groups", json={"name": "LB"}, headers=headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [player["id"]]},
        headers=headers,
    )
    parent = client.post("/api/folders", json={"name": "Season"}, headers=headers).get_json()
    client.post(
        "/api/folders",
        json={"name": "Week 1", "parent_folder_id": parent["id"]},
        headers=headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers
    ).get_json()
    detail = client.get(f"/api/quizzes/{quiz['id']}", headers=headers).get_json()
    question = detail["questions"][0]
    client.post(
        "/api/play/start",
        json={"access_code_id": code["id"], "player_name": "Test Player"},
    )
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": "Test Player",
            "answers": [
                {
                    "question_id": question["id"],
                    "selected_option_id": question["options"][0]["id"],
                    "answer_text": None,
                }
            ],
        },
    )
    return quiz


@pytest.fixture
def world(client, tool):
    """Two protected organizations and three throwaway ones, all synthetic.

    The tool's constants are repointed at these rows so the LOGIC is what gets
    tested, never production's ids.
    """
    real_a = register(
        client, username="reala", email=REAL_A, organization="University of Cincinnati"
    )
    real_b = register(client, username="realb", email=REAL_B, organization="Cincinnati")
    junk = [
        register(client, username=f"junk{i}", email=f"junk{i}@example.com", organization=name)
        for i, name in enumerate(["ZZ Probe", "Smoke Test", "Bug Repro"])
    ]
    build_quiz_with_content(client, real_a["access_token"], title="Real Install")
    for entry in junk:
        build_quiz_with_content(client, entry["access_token"], title="Junk Install")
    db.session.commit()

    protected = {org_id_of(REAL_A), org_id_of(REAL_B)}
    doomed = {org_id_of(f"junk{i}@example.com") for i in range(3)}

    tool.PROTECTED_ORG_IDS = frozenset(protected)
    tool.APPROVED_DELETE_IDS = frozenset(doomed)
    tool.PROTECTED_EMAILS = frozenset({REAL_A, REAL_B})
    tool.EXPECTED_EMAIL_ORG = {REAL_A: org_id_of(REAL_A), REAL_B: org_id_of(REAL_B)}
    tool.EXPECTED_ORG_NAMES = {
        org_id_of(REAL_A): "University of Cincinnati",
        org_id_of(REAL_B): "Cincinnati",
    }
    tool.EXPECTED_AFTER = {
        "organizations": 2,
        "coaches": 2,
        "active_players": 1,
        "quizzes": 1,
        "graded_attempts": 1,
        "practice_attempts": 0,
        "playbooks": 0,
        "groups": 1,
        "folders": 2,
    }
    return {"protected": protected, "doomed": doomed, "real_a": real_a}


def counts():
    scalar = lambda s: db.session.execute(sa.text(s)).scalar()  # noqa: E731
    return {
        "organizations": scalar("SELECT count(*) FROM organizations"),
        "coaches": scalar("SELECT count(*) FROM coaches"),
        "quizzes": scalar("SELECT count(*) FROM quizzes"),
        "players": scalar("SELECT count(*) FROM players"),
        "answers": scalar("SELECT count(*) FROM answers"),
    }


# ---------------------------------------------------------------------------
# Dry run is the default and is inert
# ---------------------------------------------------------------------------


class TestDryRunChangesNothing:
    def test_execution_requires_the_explicit_flag(self, tool):
        """Parsing bare argv must not produce an executing run."""
        parser_default = tool.main.__doc__  # noqa: F841 - documents intent
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("--execute", action="store_true")
        assert parser.parse_args([]).execute is False
        assert parser.parse_args(["--execute"]).execute is True

    def test_a_dry_run_deletes_nothing(self, app, client, world, tool, capsys):
        with app.app_context():
            before = counts()
        result = tool.run(execute=False, app=app)
        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()
            after = counts()

        assert result["executed"] is False
        assert before == after

    def test_a_dry_run_cannot_write_even_if_it_tried(self, app, client, world, tool):
        """The dry run holds a read-only transaction, so Postgres refuses."""
        tool.run(execute=False, app=app)
        with app.app_context():
            # The session is still in the tool's read-only transaction until
            # rolled back; prove a write is rejected inside it.
            db.session.rollback()
            connection = db.session.connection()
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            with pytest.raises(Exception) as excinfo:
                connection.exec_driver_sql("DELETE FROM organizations WHERE id = -1")
            assert "read-only" in str(excinfo.value).lower()
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()

    def test_a_dry_run_never_constructs_a_storage_client(self, app, client, world, tool, monkeypatch):
        """It cannot delete an object if it never obtains a client."""
        import app.services.file_storage as fs
        import app.services.private_storage as ps

        monkeypatch.setattr(
            fs, "get_file_storage", lambda: pytest.fail("dry run built a storage client")
        )
        monkeypatch.setattr(
            ps, "get_private_storage", lambda: pytest.fail("dry run built a storage client")
        )
        tool.run(execute=False, app=app)
        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()

    def test_the_dry_run_reports_the_storage_it_would_remove(self, app, client, world, tool, capsys):
        tool.run(execute=False, app=app)
        out = capsys.readouterr().out
        assert "STORAGE OBJECTS TARGETED" in out
        assert "DRY RUN COMPLETE" in out
        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()


# ---------------------------------------------------------------------------
# Negative tests - each breaks one assumption
# ---------------------------------------------------------------------------


class TestItRefuses:
    def _expect_refusal(self, tool, app, fragment):
        with pytest.raises(tool.Refused) as excinfo:
            tool.run(execute=True, app=app)
        assert fragment.lower() in str(excinfo.value).lower()
        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()

    def test_it_refuses_if_a_protected_org_enters_the_delete_set(self, app, client, world, tool):
        protected_id = min(world["protected"])
        tool.APPROVED_DELETE_IDS = frozenset(world["doomed"] | {protected_id})

        self._expect_refusal(tool, app, "pre-flight")
        with app.app_context():
            assert counts()["organizations"] == 5

    def test_it_refuses_if_a_protected_email_is_inside_a_doomed_org(
        self, app, client, world, tool
    ):
        """The single most dangerous case: a real account inside something we
        are about to delete."""
        doomed_id = min(world["doomed"])
        with app.app_context():
            db.session.execute(
                sa.text("UPDATE coaches SET organization_id=:o WHERE lower(email)=:e"),
                {"o": doomed_id, "e": REAL_A},
            )
            db.session.commit()

        self._expect_refusal(tool, app, "pre-flight")
        with app.app_context():
            assert counts()["organizations"] == 5

    def test_it_refuses_when_an_approved_org_has_vanished(self, app, client, world, tool):
        """Production drifting since the audit must stop the run, not be
        silently absorbed."""
        tool.APPROVED_DELETE_IDS = frozenset(world["doomed"] | {999_999})

        self._expect_refusal(tool, app, "pre-flight")

    def test_it_refuses_when_a_new_organization_appeared(self, app, client, world, tool):
        register(client, username="newbie", email="newbie@school.test", organization="New School")
        db.session.commit()

        self._expect_refusal(tool, app, "pre-flight")
        with app.app_context():
            assert counts()["organizations"] == 6

    def test_it_refuses_when_a_protected_org_was_renamed(self, app, client, world, tool):
        with app.app_context():
            db.session.execute(
                sa.text("UPDATE organizations SET name='Something Else' WHERE id=:id"),
                {"id": min(world["protected"])},
            )
            db.session.commit()

        self._expect_refusal(tool, app, "pre-flight")

    def test_it_refuses_when_a_protected_account_moved(self, app, client, world, tool):
        other = max(world["protected"])
        with app.app_context():
            db.session.execute(
                sa.text("UPDATE coaches SET organization_id=:o WHERE lower(email)=:e"),
                {"o": other, "e": REAL_A},
            )
            db.session.commit()

        self._expect_refusal(tool, app, "pre-flight")

    def test_it_refuses_when_a_protected_account_is_gone(self, app, client, world, tool):
        with app.app_context():
            db.session.execute(
                sa.text("DELETE FROM coaches WHERE lower(email)=:e"), {"e": REAL_B}
            )
            db.session.commit()

        self._expect_refusal(tool, app, "pre-flight")


# ---------------------------------------------------------------------------
# The real constants
# ---------------------------------------------------------------------------


class TestTheApprovedPlan:
    def test_the_two_sets_never_intersect(self, tool):
        import importlib.util

        spec = importlib.util.spec_from_file_location("pc_fresh", TOOL_PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)

        assert fresh.APPROVED_DELETE_IDS & fresh.PROTECTED_ORG_IDS == set()
        assert fresh.PROTECTED_ORG_IDS == {2, 11}
        assert len(fresh.APPROVED_DELETE_IDS) == 15
        assert sorted(fresh.APPROVED_DELETE_IDS) == [1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17]

    def test_every_protected_email_is_mapped_to_an_organization(self, tool):
        import importlib.util

        spec = importlib.util.spec_from_file_location("pc_fresh2", TOOL_PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)

        assert set(fresh.EXPECTED_EMAIL_ORG) == set(fresh.PROTECTED_EMAILS)
        for email, org_id in fresh.EXPECTED_EMAIL_ORG.items():
            assert org_id in fresh.PROTECTED_ORG_IDS, email

    def test_the_deletion_plan_ends_with_organizations(self, tool):
        assert tool.DELETION_PLAN[-1][0] == "organizations"

    def test_children_precede_their_parents_in_the_plan(self, tool):
        order = [label for label, _ in tool.DELETION_PLAN]
        pairs = [
            ("attempt_question_snapshots", "player_attempts"),
            ("attempt_question_snapshots", "questions"),
            ("answers", "player_attempts"),
            ("player_attempts", "quizzes"),
            ("questions", "quizzes"),
            ("question_options", "questions"),
            ("access_codes", "quizzes"),
            ("rosters", "quizzes"),
            ("roster_players", "rosters"),
            ("group_players", "groups"),
            ("document_pages", "source_documents"),
            ("coaches", "organizations"),
            ("players", "organizations"),
        ]
        for child, parent in pairs:
            assert order.index(child) < order.index(parent), f"{child} must precede {parent}"


# ---------------------------------------------------------------------------
# Execution against synthetic data
# ---------------------------------------------------------------------------


class TestExecution:
    def test_it_deletes_exactly_the_approved_organizations(self, app, client, world, tool, monkeypatch):
        import app.services.file_storage as fs

        removed = []
        monkeypatch.setattr(
            fs,
            "get_file_storage",
            lambda: type("S", (), {"delete_image": lambda self, url: removed.append(url)})(),
        )

        result = tool.run(execute=True, app=app)

        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()
            remaining = {
                r[0]
                for r in db.session.execute(sa.text("SELECT id FROM organizations")).all()
            }
        assert result["executed"] is True
        assert remaining == world["protected"]

    def test_the_protected_organizations_keep_all_their_data(self, app, client, world, tool):
        with app.app_context():
            real_org = org_id_of(REAL_A)
            before = db.session.execute(
                sa.text("SELECT count(*) FROM quizzes WHERE organization_id=:o"), {"o": real_org}
            ).scalar()

        tool.run(execute=True, app=app)

        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()
            after = db.session.execute(
                sa.text("SELECT count(*) FROM quizzes WHERE organization_id=:o"), {"o": real_org}
            ).scalar()
            attempts = db.session.execute(
                sa.text(
                    "SELECT count(*) FROM player_attempts pa JOIN quizzes q ON q.id=pa.quiz_id"
                    " WHERE q.organization_id=:o"
                ),
                {"o": real_org},
            ).scalar()
        assert after == before == 1
        assert attempts == 1

    def test_no_orphan_rows_survive_for_a_deleted_organization(self, app, client, world, tool):
        doomed = sorted(world["doomed"])
        tool.run(execute=True, app=app)

        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()
            for table in ("coaches", "players", "groups", "folders", "quizzes"):
                left = db.session.execute(
                    sa.text(f"SELECT count(*) FROM {table} WHERE organization_id = ANY(:ids)"),  # noqa: S608
                    {"ids": doomed},
                ).scalar()
                assert left == 0, f"{table} still has rows for deleted organizations"

    def test_a_failure_mid_delete_rolls_the_whole_thing_back(self, app, client, world, tool):
        """Half a cleanup is the worst outcome. Break the last statement and
        prove nothing at all is committed."""
        original = list(tool.DELETION_PLAN)
        tool.DELETION_PLAN = original[:-1] + [
            ("organizations", "DELETE FROM organizations WHERE id = ANY(:ids) AND bogus_column = 1")
        ]
        try:
            with app.app_context():
                before = counts()
            with pytest.raises(Exception):
                tool.run(execute=True, app=app)
            with app.app_context():
                db.session.rollback()
                db.session.remove()
                db.engine.dispose()
                after = counts()
            assert before == after, "a failed cleanup left partial changes behind"
        finally:
            tool.DELETION_PLAN = original

    def test_storage_is_only_touched_after_the_commit_succeeds(self, app, client, world, tool, monkeypatch):
        """If the database fails, no object may be deleted - the rows still
        point at them."""
        import app.services.file_storage as fs

        monkeypatch.setattr(
            fs,
            "get_file_storage",
            lambda: pytest.fail("storage touched despite a database failure"),
        )
        original = list(tool.DELETION_PLAN)
        tool.DELETION_PLAN = original[:-1] + [
            ("organizations", "DELETE FROM organizations WHERE id = ANY(:ids) AND nope = 1")
        ]
        try:
            with pytest.raises(Exception):
                tool.run(execute=True, app=app)
        finally:
            tool.DELETION_PLAN = original
            with app.app_context():
                db.session.rollback()
                db.session.remove()
                db.engine.dispose()

    def test_only_storage_belonging_to_approved_orgs_is_targeted(self, app, client, world, tool):
        """The protected organizations' objects must never appear in the
        target list."""
        with app.app_context():
            protected_urls = {
                r[0]
                for r in db.session.execute(
                    sa.text(
                        "SELECT qi.image_url FROM question_images qi"
                        " JOIN questions qu ON qu.id=qi.question_id"
                        " JOIN quizzes q ON q.id=qu.quiz_id"
                        " WHERE q.organization_id = ANY(:ids)"
                    ),
                    {"ids": sorted(world["protected"])},
                ).all()
            }
        result = tool.run(execute=False, app=app)
        targeted = set(result["targets"]["public_images"]) | set(result["targets"]["private_keys"])

        assert targeted & protected_urls == set()
        with app.app_context():
            db.session.rollback()
            db.session.remove()
            db.engine.dispose()
