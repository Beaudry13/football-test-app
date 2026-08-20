"""Organization merge: conservation proofs and fail-closed behaviour.

The merge moves a whole tenant. The tests that matter are the ones proving
nothing was LOST or SILENTLY REASSIGNED - a merge that "worked" but attached
one player's attempts to another person would look fine and be a disaster.

So the core here is a before/after snapshot of every attempt, answer, drawing,
grade, timestamp and folder edge, asserted byte-identical across the merge.
Everything else is negative: each test breaks one assumption and proves the
merge refuses.
"""

import ast
from pathlib import Path

import pytest
import sqlalchemy as sa

from app.extensions import db
from app.models import Coach, CoachRole, Organization
from app.models.organization_merge import OrganizationMerge
from app.services import organization_merge as merge

SERVICE_PATH = Path(__file__).resolve().parent.parent / "app" / "services" / "organization_merge.py"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


def H(token):
    return {"Authorization": f"Bearer {token}"}


def build_content(client, token, *, title, player_names=("Jordan Smith",), nest=True):
    """A quiz taken to completion, plus roster, group and nested folders - so
    every table the merge touches has rows to move."""
    headers = H(token)
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
    players = []
    for name in player_names:
        first, last = name.split(" ", 1)
        players.append(
            client.post(
                "/api/players", json={"first_name": first, "last_name": last}, headers=headers
            ).get_json()
        )
    client.post(
        f"/api/quizzes/{quiz['id']}/roster/members",
        json={"player_ids": [p["id"] for p in players]},
        headers=headers,
    )
    group = client.post("/api/groups", json={"name": "Linebackers"}, headers=headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [p["id"] for p in players]},
        headers=headers,
    )
    parent = client.post("/api/folders", json={"name": "Season"}, headers=headers).get_json()
    if nest:
        child = client.post(
            "/api/folders",
            json={"name": "Week 1", "parent_folder_id": parent["id"]},
            headers=headers,
        ).get_json()
        client.post(
            "/api/folders",
            json={"name": "Deep", "parent_folder_id": child["id"]},
            headers=headers,
        )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers
    ).get_json()
    detail = client.get(f"/api/quizzes/{quiz['id']}", headers=headers).get_json()
    question = detail["questions"][0]
    client.post(
        "/api/play/start",
        json={"access_code_id": code["id"], "player_name": player_names[0]},
    )
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": player_names[0],
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
def world(client):
    """Destination + source + an unrelated bystander organization."""
    dest = register(
        client, username="destcoach", email="dest@school.test", organization="University of Peira"
    )
    src = register(
        client, username="srccoach", email="src@school.test", organization="Peira Duplicate"
    )
    other = register(
        client, username="bystander", email="other@school.test", organization="Unrelated School"
    )
    build_content(client, dest["access_token"], title="Destination Install")
    # Same quiz title, same group name, same player name - all legal, and all
    # of them must survive as separate records.
    build_content(client, src["access_token"], title="Destination Install")
    build_content(client, other["access_token"], title="Bystander Install", nest=False)
    db.session.commit()

    owner = Coach.query.filter_by(email="dest@school.test").one()
    owner.is_platform_owner = True
    db.session.commit()

    return {
        "destination_id": Coach.query.filter_by(email="dest@school.test").one().organization_id,
        "source_id": Coach.query.filter_by(email="src@school.test").one().organization_id,
        "other_id": Coach.query.filter_by(email="other@school.test").one().organization_id,
        "owner": owner,
        "dest_token": dest["access_token"],
        "src_token": src["access_token"],
        "other_token": other["access_token"],
    }


def snapshot():
    """Everything that must survive a merge completely unchanged."""
    rows = lambda s: [tuple(r) for r in db.session.execute(sa.text(s)).all()]  # noqa: E731
    return {
        "attempts": rows(
            "SELECT id, quiz_id, access_code_id, player_id, player_name, status, mode,"
            " started_at, submitted_at FROM player_attempts ORDER BY id"
        ),
        "answers": rows(
            "SELECT id, attempt_id, question_id, answer_text, selected_option_id, is_correct,"
            " coach_feedback, graded_at, checked_at FROM answers ORDER BY id"
        ),
        "drawings": rows("SELECT id, answer_id, revision FROM answer_drawings ORDER BY id"),
        "questions": rows(
            "SELECT id, quiz_id, question_text, question_type, position, answer_explanation"
            " FROM questions ORDER BY id"
        ),
        "quiz_shape": rows("SELECT id, title, coach_id, folder_id FROM quizzes ORDER BY id"),
        "folder_edges": rows("SELECT id, name, parent_folder_id FROM folders ORDER BY id"),
        "group_members": rows("SELECT id, group_id, player_id FROM group_players ORDER BY id"),
        "roster_members": rows("SELECT id, roster_id, player_id FROM roster_players ORDER BY id"),
        "players": rows("SELECT id, first_name, last_name, is_active FROM players ORDER BY id"),
        "grade_logs": rows("SELECT id, answer_id, coach_id, changed_at FROM grade_audit_logs ORDER BY id"),
    }


def org_fingerprint(org_id):
    return merge.fingerprint(org_id, org_id)


# ---------------------------------------------------------------------------
# Preview writes nothing
# ---------------------------------------------------------------------------


class TestPreviewIsInert:
    def test_preview_changes_nothing(self, app, client, world):
        with app.app_context():
            before = snapshot()
            orgs_before = db.session.execute(sa.text("SELECT count(*) FROM organizations")).scalar()
            merge.preview(world["source_id"], world["destination_id"])
            assert snapshot() == before
            assert (
                db.session.execute(sa.text("SELECT count(*) FROM organizations")).scalar()
                == orgs_before
            )

    def test_preview_reports_everything_that_moves(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])

        assert plan["source"]["counts"]["quizzes"] == 1
        assert plan["source"]["counts"]["coaches"] == 1
        assert plan["source"]["counts"]["graded_attempts"] == 1
        assert plan["source"]["counts"]["players"] == 1
        assert plan["source"]["counts"]["folders"] == 3
        assert plan["resulting_destination_counts"]["quizzes"] == 2
        assert plan["fingerprint"]

    def test_preview_flags_the_role_change_for_every_source_coach(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])

        coach = plan["coaches"][0]
        # Registering makes you an ADMIN of your own organization, so this is
        # exactly the escalation case.
        assert coach["current_role"] == "ADMIN"
        assert coach["new_role"] == "MEMBER"
        assert coach["requires_decision"] is True
        assert coach["widens_access"] is False

    def test_choosing_admin_is_reported_as_widening_access(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])
            coach_id = plan["coaches"][0]["coach_id"]
            elevated = merge.preview(
                world["source_id"], world["destination_id"], {str(coach_id): "ADMIN"}
            )

        assert elevated["coaches"][0]["new_role"] == "ADMIN"
        assert elevated["coaches"][0]["widens_access"] is True
        assert any("KEEP ADMIN" in w for w in elevated["warnings"])

    def test_it_reports_possible_duplicate_players_without_combining_them(
        self, app, client, world
    ):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])

        assert len(plan["possible_duplicate_players"]) == 1
        duplicate = plan["possible_duplicate_players"][0]
        assert duplicate["normalized_name"] == "jordan smith"
        assert len(duplicate["source_player_ids"]) == 1
        assert len(duplicate["destination_player_ids"]) == 1
        assert plan["requires_acknowledgement"]["duplicate_players"] is True

    def test_it_reports_name_collisions(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])

        kinds = {c["type"] for c in plan["name_collisions"]}
        assert "quizzes" in kinds and "groups" in kinds and "folders" in kinds
        assert plan["requires_acknowledgement"]["collisions"] is True


# ---------------------------------------------------------------------------
# Conservation
# ---------------------------------------------------------------------------


def do_merge(app, world, **overrides):
    with app.app_context():
        plan = merge.preview(world["source_id"], world["destination_id"])
        coach_id = plan["coaches"][0]["coach_id"]
        kwargs = {
            "expected_fingerprint": plan["fingerprint"],
            "performed_by": db.session.get(Coach, world["owner"].id),
            "decisions": {str(coach_id): "MEMBER"},
            "acknowledge_collisions": True,
            "acknowledge_duplicate_players": True,
        }
        kwargs.update(overrides)
        return merge.execute(world["source_id"], world["destination_id"], **kwargs)


class TestNothingIsLostOrReassigned:
    def test_every_attempt_answer_and_grade_is_byte_identical(self, app, client, world):
        with app.app_context():
            before = snapshot()

        do_merge(app, world)

        with app.app_context():
            after = snapshot()
        # Not "the same number of" - THE SAME ROWS, including player_id links,
        # modes, grades, feedback and every timestamp.
        assert after["attempts"] == before["attempts"]
        assert after["answers"] == before["answers"]
        assert after["drawings"] == before["drawings"]
        assert after["questions"] == before["questions"]
        assert after["quiz_shape"] == before["quiz_shape"]
        assert after["players"] == before["players"]
        assert after["group_members"] == before["group_members"]
        assert after["roster_members"] == before["roster_members"]
        assert after["grade_logs"] == before["grade_logs"]

    def test_the_folder_hierarchy_arrives_intact(self, app, client, world):
        with app.app_context():
            before = snapshot()["folder_edges"]

        do_merge(app, world)

        with app.app_context():
            after = snapshot()["folder_edges"]
        # Same ids, same names, same parents - nothing flattened or reparented.
        assert after == before

    def test_source_records_become_destination_owned(self, app, client, world):
        source_id, destination_id = world["source_id"], world["destination_id"]
        with app.app_context():
            was_source = {
                table: {
                    r[0]
                    for r in db.session.execute(
                        sa.text(f"SELECT id FROM {table} WHERE organization_id=:o"),  # noqa: S608
                        {"o": source_id},
                    ).all()
                }
                for table in merge.ORG_OWNED_TABLES
            }

        do_merge(app, world)

        with app.app_context():
            for table, ids in was_source.items():
                if not ids:
                    continue
                now = {
                    r[0]
                    for r in db.session.execute(
                        sa.text(f"SELECT id FROM {table} WHERE organization_id=:o"),  # noqa: S608
                        {"o": destination_id},
                    ).all()
                }
                assert ids <= now, f"{table} rows did not arrive at the destination"

    def test_pre_existing_destination_records_are_untouched(self, app, client, world):
        destination_id = world["destination_id"]
        with app.app_context():
            before = {
                r[0]
                for r in db.session.execute(
                    sa.text("SELECT id FROM quizzes WHERE organization_id=:o"),
                    {"o": destination_id},
                ).all()
            }

        do_merge(app, world)

        with app.app_context():
            after = {
                r[0]
                for r in db.session.execute(
                    sa.text("SELECT id FROM quizzes WHERE organization_id=:o"),
                    {"o": destination_id},
                ).all()
            }
        assert before <= after

    def test_an_unrelated_organization_is_byte_identical(self, app, client, world):
        with app.app_context():
            before = org_fingerprint(world["other_id"])

        do_merge(app, world)

        with app.app_context():
            assert org_fingerprint(world["other_id"]) == before

    def test_the_source_organization_is_gone(self, app, client, world):
        do_merge(app, world)
        with app.app_context():
            assert db.session.get(Organization, world["source_id"]) is None

    def test_platform_owner_status_is_unchanged(self, app, client, world):
        do_merge(app, world)
        with app.app_context():
            owner = Coach.query.filter_by(email="dest@school.test").one()
            assert owner.is_platform_owner is True

    def test_coach_view_ownership_is_unchanged(self, app, client, world):
        """Each coach still sees only the quizzes they created - a merge
        changes tenancy, never authorship."""
        do_merge(app, world)

        listed = client.get("/api/quizzes", headers=H(world["src_token"])).get_json()
        rows = listed["quizzes"] if isinstance(listed, dict) else listed
        assert len(rows) == 1

    def test_source_admin_is_demoted_by_default(self, app, client, world):
        do_merge(app, world)
        with app.app_context():
            moved = Coach.query.filter_by(email="src@school.test").one()
            assert moved.role == CoachRole.MEMBER
            assert moved.organization_id == world["destination_id"]

    def test_admin_is_preserved_only_when_explicitly_chosen(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])
            coach_id = plan["coaches"][0]["coach_id"]

        do_merge(app, world, decisions={str(coach_id): "ADMIN"})

        with app.app_context():
            assert Coach.query.filter_by(email="src@school.test").one().role == CoachRole.ADMIN

    def test_source_invitations_are_revoked_not_moved(self, app, client, world):
        # Written straight into the table rather than through the endpoint:
        # coaches cannot mint invitations themselves during Early Access (see
        # invites.may_issue_invites_directly), and what this test is about is
        # what a MERGE does to an invitation that already exists - not how it
        # came to exist.
        with app.app_context():
            from app.models import OrganizationInvite
            from app.services.invites import INVITE_TTL_DAYS, generate_invite_code

            db.session.add(
                OrganizationInvite(
                    organization_id=world["source_id"],
                    code=generate_invite_code(),
                    created_at=OrganizationInvite.default_expiry(0),
                    expires_at=OrganizationInvite.default_expiry(INVITE_TTL_DAYS),
                )
            )
            db.session.commit()

        with app.app_context():
            assert (
                db.session.execute(
                    sa.text("SELECT count(*) FROM organization_invites WHERE organization_id=:o"),
                    {"o": world["source_id"]},
                ).scalar()
                == 1
            )

        result = do_merge(app, world)

        assert result["invitations_revoked"] == 1
        with app.app_context():
            assert db.session.execute(sa.text("SELECT count(*) FROM organization_invites")).scalar() == 0

    def test_both_same_named_objects_survive(self, app, client, world):
        do_merge(app, world)
        with app.app_context():
            same_title = db.session.execute(
                sa.text(
                    "SELECT count(*) FROM quizzes WHERE organization_id=:o AND title=:t"
                ),
                {"o": world["destination_id"], "t": "Destination Install"},
            ).scalar()
        assert same_title == 2, "a same-named quiz was overwritten or deduplicated"

    def test_duplicate_players_both_survive_with_their_own_history(self, app, client, world):
        """Two Jordan Smiths - one from each merged organization - must remain
        two people. The bystander organization has a third, which must not be
        drawn in."""
        jordans = lambda org: db.session.execute(  # noqa: E731
            sa.text(
                "SELECT count(*) FROM players WHERE lower(first_name)='jordan'"
                " AND organization_id=:o"
            ),
            {"o": org},
        ).scalar()
        with app.app_context():
            total_before = db.session.execute(
                sa.text("SELECT count(*) FROM players WHERE lower(first_name)='jordan'")
            ).scalar()
            assert jordans(world["destination_id"]) == 1
            assert jordans(world["source_id"]) == 1

        do_merge(app, world)

        with app.app_context():
            assert jordans(world["destination_id"]) == 2, "duplicate players were combined"
            assert jordans(world["other_id"]) == 1, "an unrelated player was touched"
            total_after = db.session.execute(
                sa.text("SELECT count(*) FROM players WHERE lower(first_name)='jordan'")
            ).scalar()
        assert total_after == total_before, "a player row was created or destroyed"


# ---------------------------------------------------------------------------
# The audit trail
# ---------------------------------------------------------------------------


class TestAuditTrail:
    def test_it_records_the_merge_with_source_identity_snapshotted(self, app, client, world):
        result = do_merge(app, world)

        with app.app_context():
            row = db.session.get(OrganizationMerge, result["audit_id"])
            assert row.source_organization_id == world["source_id"]
            # The source organization row is gone, so the NAME must have been
            # copied or this record would be unreadable.
            assert row.source_organization_name == "Peira Duplicate"
            assert row.destination_organization_name == "University of Peira"
            assert row.performed_by_email == "dest@school.test"
            assert row.outcome == "SUCCESS"
            assert row.counts_moved["coaches"] == 1
            assert row.invitations_revoked == 0
            assert row.coach_role_decisions[0]["previous_role"] == "ADMIN"
            assert row.coach_role_decisions[0]["new_role"] == "MEMBER"
            assert row.duplicate_player_warnings

    def test_no_audit_row_survives_a_rolled_back_merge(self, app, client, world, monkeypatch):
        """The audit is written inside the transaction, so a failure must not
        leave a record of a merge that never happened."""
        with app.app_context():
            before = db.session.execute(
                sa.text("SELECT count(*) FROM organization_merges")
            ).scalar()

        original = merge.ORG_OWNED_TABLES
        monkeypatch.setattr(merge, "ORG_OWNED_TABLES", original + ("no_such_table",))
        with pytest.raises(Exception):
            do_merge(app, world)

        with app.app_context():
            after = db.session.execute(
                sa.text("SELECT count(*) FROM organization_merges")
            ).scalar()
        assert after == before


# ---------------------------------------------------------------------------
# Negative: it refuses
# ---------------------------------------------------------------------------


class TestItRefuses:
    def test_same_source_and_destination(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="different"):
                merge.preview(world["source_id"], world["source_id"])

    def test_nonexistent_source(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="source"):
                merge.preview(999_999, world["destination_id"])

    def test_nonexistent_destination(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="destination"):
                merge.preview(world["source_id"], 999_999)

    def test_a_stale_fingerprint(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="changed since the preview"):
                merge.execute(
                    world["source_id"],
                    world["destination_id"],
                    expected_fingerprint="0" * 64,
                    performed_by=db.session.get(Coach, world["owner"].id),
                    decisions={},
                    acknowledge_collisions=True,
                    acknowledge_duplicate_players=True,
                )

    def test_the_source_changing_after_preview(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])
            coach_id = plan["coaches"][0]["coach_id"]
        # A new quiz in the source between preview and execute.
        build_content(client, world["src_token"], title="Sneaky Addition", nest=False)

        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="changed since the preview"):
                merge.execute(
                    world["source_id"],
                    world["destination_id"],
                    expected_fingerprint=plan["fingerprint"],
                    performed_by=db.session.get(Coach, world["owner"].id),
                    decisions={str(coach_id): "MEMBER"},
                    acknowledge_collisions=True,
                    acknowledge_duplicate_players=True,
                )

    def test_the_destination_changing_after_preview(self, app, client, world):
        with app.app_context():
            plan = merge.preview(world["source_id"], world["destination_id"])
            coach_id = plan["coaches"][0]["coach_id"]
        build_content(client, world["dest_token"], title="Destination Addition", nest=False)

        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="changed since the preview"):
                merge.execute(
                    world["source_id"],
                    world["destination_id"],
                    expected_fingerprint=plan["fingerprint"],
                    performed_by=db.session.get(Coach, world["owner"].id),
                    decisions={str(coach_id): "MEMBER"},
                    acknowledge_collisions=True,
                    acknowledge_duplicate_players=True,
                )

    def test_a_missing_admin_role_decision(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="role decision"):
                do_merge(app, world, decisions={})

    def test_unacknowledged_collisions(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="[Cc]ollision"):
                do_merge(app, world, acknowledge_collisions=False)

    def test_unacknowledged_duplicate_players(self, app, client, world):
        with app.app_context():
            with pytest.raises(merge.MergeRefused, match="duplicate"):
                do_merge(app, world, acknowledge_duplicate_players=False)


# ---------------------------------------------------------------------------
# Negative: injected failures roll back completely
# ---------------------------------------------------------------------------


class TestFailClosed:
    def _assert_unchanged(self, app, world, inject):
        with app.app_context():
            before = snapshot()
            orgs_before = db.session.execute(
                sa.text("SELECT id, name FROM organizations ORDER BY id")
            ).all()

        with pytest.raises(Exception):
            inject()

        with app.app_context():
            assert snapshot() == before
            assert (
                db.session.execute(sa.text("SELECT id, name FROM organizations ORDER BY id")).all()
                == orgs_before
            )

    def test_failure_midway_through_the_updates(self, app, client, world, monkeypatch):
        original = merge.ORG_OWNED_TABLES
        monkeypatch.setattr(
            merge, "ORG_OWNED_TABLES", ("coaches", "players", "table_that_does_not_exist")
        )
        self._assert_unchanged(app, world, lambda: do_merge(app, world))

    def test_failure_just_before_the_source_delete(self, app, client, world, monkeypatch):
        """The most dangerous moment: everything has moved, and the source row
        is about to go. A failure here must put every row back."""
        real_add = db.session.add

        def explode(instance):
            if isinstance(instance, OrganizationMerge):
                raise RuntimeError("injected failure before the source delete")
            return real_add(instance)

        monkeypatch.setattr(db.session, "add", explode)
        self._assert_unchanged(app, world, lambda: do_merge(app, world))

    def test_failure_writing_the_audit_row(self, app, client, world, monkeypatch):
        def explode(*args, **kwargs):
            raise RuntimeError("injected audit failure")

        monkeypatch.setattr(db.session, "flush", explode)
        self._assert_unchanged(app, world, lambda: do_merge(app, world))

    def test_a_leftover_dependency_aborts_rather_than_forcing_the_delete(
        self, app, client, world, monkeypatch
    ):
        """If a table were missed, the source organization would not delete.
        The FK refusing is the real safety net - prove we roll back rather
        than working around it."""
        monkeypatch.setattr(
            merge, "ORG_OWNED_TABLES", tuple(t for t in merge.ORG_OWNED_TABLES if t != "players")
        )
        self._assert_unchanged(app, world, lambda: do_merge(app, world))


# ---------------------------------------------------------------------------
# Static guarantees
# ---------------------------------------------------------------------------


class TestMergeCoverageMatchesTheSchema:
    """THE BUILD-TIME GUARD.

    ORG_OWNED_TABLES is a hand-maintained list. If a future migration adds a
    table carrying organization_id and nobody updates it, the merge silently
    leaves those rows behind - and the failure only surfaces when the source
    DELETE hits a foreign key DURING A PRODUCTION MERGE. That fails closed,
    which is right, but it fails at the worst possible moment.

    So the coverage is checked against the REAL schema instead. Adding such a
    table breaks this test immediately.

    EXACT SET EQUALITY, deliberately - a subset assertion would only catch one
    of the two ways this can rot:
      * a new organization_id table missing from the merge, and
      * a table in the list that no longer exists or no longer carries the
        column, which would make the merge fail on a table that isn't there.
    """

    def organization_id_tables(self):
        return {
            row[0]
            for row in db.session.execute(
                sa.text(
                    "SELECT table_name FROM information_schema.columns"
                    " WHERE column_name='organization_id' AND table_schema='public'"
                )
            ).all()
        }

    def test_the_schema_has_organization_id_tables_at_all(self, app):
        with app.app_context():
            assert self.organization_id_tables(), "no organization_id columns found"

    def test_merge_coverage_is_exactly_the_schema(self, app):
        with app.app_context():
            actual = self.organization_id_tables()

        # organization_invites is listed SEPARATELY because it is deliberately
        # revoked rather than moved - it is covered by the merge, just not by
        # an UPDATE. Keeping it out of ORG_OWNED_TABLES is what stops someone
        # "fixing" the merge by re-pointing invitations into an organization
        # nobody agreed to join.
        covered = set(merge.ORG_OWNED_TABLES) | {merge.INVITES_TABLE}

        missing = actual - covered
        stale = covered - actual
        assert not missing, (
            f"table(s) {sorted(missing)} carry organization_id but the merge does not handle "
            "them. Add them to ORG_OWNED_TABLES (to move) or handle them explicitly."
        )
        assert not stale, (
            f"the merge lists {sorted(stale)}, which no longer carries organization_id. "
            "Remove it, or the merge will fail against a table that is not there."
        )
        assert actual == covered

    def test_invitations_are_not_in_the_moved_list(self, app):
        """Pinned separately: moving an invitation would drop somebody into an
        organization they never chose."""
        assert merge.INVITES_TABLE not in merge.ORG_OWNED_TABLES


class TestStaticGuarantees:
    def test_the_merge_never_touches_storage(self):
        """Storage keys carry no organization, so files follow their rows. A
        storage call here would be a bug, not an omission."""
        source = SERVICE_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
            elif isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}

        assert not any("storage" in module for module in imported), imported
        for forbidden in ("delete_image", "delete_private", "get_file_storage", "get_private_storage"):
            assert forbidden not in source, f"the merge references {forbidden}"

    def test_it_never_deduplicates_players(self):
        """No UPDATE may rewrite player_id - that is how attempts would be
        reassigned to the wrong person."""
        source = SERVICE_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        statements = [
            node.value.strip()
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and node.value.strip().upper().startswith(("UPDATE", "DELETE"))
        ]
        for statement in statements:
            assert "player_id" not in statement.lower(), statement

    def test_only_organization_id_is_rewritten(self):
        """Reconstructs f-strings before checking.

        The UPDATEs interpolate a table name, so the AST stores them as
        JoinedStr with the SQL split across several Constant nodes. Scanning
        raw Constants finds a bare "UPDATE " and proves nothing - the
        statement has to be reassembled first.
        """
        tree = ast.parse(SERVICE_PATH.read_text(encoding="utf-8"))

        # ast.walk descends INTO a JoinedStr, so its fragments would also be
        # collected as bare Constants - yielding a meaningless "UPDATE " that
        # can never contain the rest of the statement. Skip the pieces once
        # the whole has been reassembled.
        inner = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                inner |= {id(part) for part in node.values}

        statements = []
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                text = "".join(
                    part.value if isinstance(part, ast.Constant) else "{}"
                    for part in node.values
                )
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in inner
            ):
                text = node.value
            else:
                continue
            if text.strip().upper().startswith("UPDATE"):
                statements.append(text.strip())

        assert statements, "no UPDATE found - has the service been restructured?"
        for statement in statements:
            assert "SET organization_id=" in statement, statement
