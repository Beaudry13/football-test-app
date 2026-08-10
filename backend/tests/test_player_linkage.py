"""Canonical linkage for roster and group membership.

An attempt with `player_id = NULL` is invisible to the player profile and to
the cumulative performance report. These tests pin the rule that stops new
ones being created: a name resolves to exactly one canonical Player, or the
import is refused.
"""

import io

from app.extensions import db
from app.models import GroupPlayer, Player, PlayerAttempt, RosterPlayer
from app.services.player_matching import normalise_name, resolve_names


def make_player(client, headers, first, last):
    response = client.post(
        "/api/players", json={"first_name": first, "last_name": last}, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_quiz(client, headers, title="Install 1"):
    return client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()["id"]


def make_group(client, headers, name="Defense"):
    return client.post("/api/groups", json={"name": name}, headers=headers).get_json()["id"]


def upload_group_csv(client, headers, group_id, text):
    return client.post(
        f"/api/groups/{group_id}/players/csv",
        data={"file": (io.BytesIO(text.encode()), "roster.csv")},
        headers=headers,
        content_type="multipart/form-data",
    )


def upload_roster_csv(client, headers, quiz_id, text):
    return client.post(
        f"/api/quizzes/{quiz_id}/roster/csv",
        data={"file": (io.BytesIO(text.encode()), "roster.csv")},
        headers=headers,
        content_type="multipart/form-data",
    )


class TestNameResolution:
    def test_normalises_case_and_whitespace_only(self):
        assert normalise_name("  Jordan   Smith ") == normalise_name("jordan smith")
        # Nothing clever: a different name stays a different name.
        assert normalise_name("Jon Smith") != normalise_name("John Smith")

    def test_matches_an_existing_player_exactly_once(self, app, client, coach_headers):
        player_id = make_player(client, coach_headers, "Jordan", "Smith")

        with app.app_context():
            org = db.session.get(Player, player_id).organization_id
            resolution = resolve_names(org, ["Jordan Smith"])

        assert resolution.matched["Jordan Smith"].id == player_id
        assert resolution.unmatched == []
        assert not resolution.has_ambiguity

    def test_reports_an_unknown_name_rather_than_guessing(self, app, client, coach_headers):
        player_id = make_player(client, coach_headers, "Jordan", "Smith")

        with app.app_context():
            org = db.session.get(Player, player_id).organization_id
            resolution = resolve_names(org, ["Jon Smith"])

        # No fuzzy matching. A near-miss is a miss.
        assert resolution.unmatched == ["Jon Smith"]
        assert resolution.matched == {}

    def test_reports_ambiguity_instead_of_choosing(self, app, client, coach_headers):
        first = make_player(client, coach_headers, "Jordan", "Smith")
        make_player(client, coach_headers, "Jordan", "Smith")

        with app.app_context():
            org = db.session.get(Player, first).organization_id
            resolution = resolve_names(org, ["Jordan Smith"])

        assert resolution.ambiguous == {"Jordan Smith": 2}
        assert resolution.matched == {}

    def test_never_reaches_into_another_organization(
        self, app, client, coach_headers, register_coach
    ):
        _, _, other_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        make_player(client, other_headers, "Jordan", "Smith")
        mine = make_player(client, coach_headers, "Dre", "Vance")

        with app.app_context():
            org = db.session.get(Player, mine).organization_id
            resolution = resolve_names(org, ["Jordan Smith"])

        assert resolution.unmatched == ["Jordan Smith"]


class TestGroupCsvLinkage:
    def test_links_an_existing_player(self, app, client, coach_headers):
        player_id = make_player(client, coach_headers, "Jordan", "Smith")
        group_id = make_group(client, coach_headers)

        assert upload_group_csv(client, coach_headers, group_id, "Jordan Smith\n").status_code == 200

        with app.app_context():
            rows = GroupPlayer.query.filter_by(group_id=group_id).all()
            assert [row.player_id for row in rows] == [player_id]

    def test_creates_a_canonical_player_for_an_unknown_name(self, app, client, coach_headers):
        # No identity risk: a name nobody has cannot be confused with anybody,
        # and the master roster stays the single source of truth.
        group_id = make_group(client, coach_headers)

        assert upload_group_csv(client, coach_headers, group_id, "Dre Vance\n").status_code == 200

        with app.app_context():
            rows = GroupPlayer.query.filter_by(group_id=group_id).all()
            assert len(rows) == 1
            assert rows[0].player_id is not None
            created = db.session.get(Player, rows[0].player_id)
            assert (created.first_name, created.last_name) == ("Dre", "Vance")

    def test_refuses_the_whole_import_when_a_name_is_ambiguous(self, app, client, coach_headers):
        make_player(client, coach_headers, "Jordan", "Smith")
        make_player(client, coach_headers, "Jordan", "Smith")
        group_id = make_group(client, coach_headers)

        response = upload_group_csv(
            client, coach_headers, group_id, "Dre Vance\nJordan Smith\n"
        )

        assert response.status_code == 422
        assert "Jordan Smith" in response.get_json()["error"]
        # All or nothing: the unambiguous row must not land either, or the
        # coach cannot tell which half of their file was applied.
        with app.app_context():
            assert GroupPlayer.query.filter_by(group_id=group_id).count() == 0

    def test_creates_no_name_only_rows_at_all(self, app, client, coach_headers):
        group_id = make_group(client, coach_headers)
        upload_group_csv(client, coach_headers, group_id, "Dre Vance\nMarcus Hill\n")

        with app.app_context():
            rows = GroupPlayer.query.filter_by(group_id=group_id).all()
            assert rows and all(row.player_id is not None for row in rows)

    def test_is_additive_rather_than_a_replace(self, app, client, coach_headers):
        group_id = make_group(client, coach_headers)
        upload_group_csv(client, coach_headers, group_id, "Dre Vance\n")
        upload_group_csv(client, coach_headers, group_id, "Marcus Hill\n")

        with app.app_context():
            names = {row.player_name for row in GroupPlayer.query.filter_by(group_id=group_id)}
        assert names == {"Dre Vance", "Marcus Hill"}

    def test_re_uploading_the_same_player_does_not_duplicate_them(
        self, app, client, coach_headers
    ):
        group_id = make_group(client, coach_headers)
        upload_group_csv(client, coach_headers, group_id, "Dre Vance\n")
        upload_group_csv(client, coach_headers, group_id, "Dre Vance\n")

        with app.app_context():
            assert GroupPlayer.query.filter_by(group_id=group_id).count() == 1


class TestQuizRosterCsvLinkage:
    def test_links_and_creates_exactly_as_groups_do(self, app, client, coach_headers):
        known = make_player(client, coach_headers, "Jordan", "Smith")
        quiz_id = make_quiz(client, coach_headers)

        assert (
            upload_roster_csv(client, coach_headers, quiz_id, "Jordan Smith\nDre Vance\n").status_code
            == 200
        )

        with app.app_context():
            rows = RosterPlayer.query.join(RosterPlayer.roster).filter_by(quiz_id=quiz_id).all()
            assert all(row.player_id is not None for row in rows)
            assert known in [row.player_id for row in rows]

    def test_refuses_an_ambiguous_name(self, client, coach_headers):
        make_player(client, coach_headers, "Jordan", "Smith")
        make_player(client, coach_headers, "Jordan", "Smith")
        quiz_id = make_quiz(client, coach_headers)

        assert upload_roster_csv(client, coach_headers, quiz_id, "Jordan Smith\n").status_code == 422


class TestAttemptLinkage:
    def test_a_csv_built_group_produces_a_linked_attempt(self, app, client, coach_headers):
        # The whole point: import, assign, play, and the attempt is
        # attributable to a canonical player.
        group_id = make_group(client, coach_headers)
        upload_group_csv(client, coach_headers, group_id, "Dre Vance\n")
        quiz_id = make_quiz(client, coach_headers)
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Q", "question_type": "written", "options": []},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes",
            json={"group_ids": [group_id]},
            headers=coach_headers,
        ).get_json()

        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Dre Vance"},
        )
        assert started.status_code == 201, started.get_json()

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(quiz_id=quiz_id).one()
            # Populated even though the client sent no player_id at all.
            assert attempt.player_id is not None

    def test_the_manual_picker_path_produces_a_linked_attempt(self, app, client, coach_headers):
        # Master Roster -> group (roster picker) -> quiz -> attempt. The
        # workflow a coach is now steered towards, end to end.
        player_id = make_player(client, coach_headers, "Dre", "Vance")
        group_id = make_group(client, coach_headers)
        client.post(
            f"/api/groups/{group_id}/members",
            json={"player_ids": [player_id]},
            headers=coach_headers,
        )
        quiz_id = make_quiz(client, coach_headers)
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Q", "question_type": "written", "options": []},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes",
            json={"group_ids": [group_id]},
            headers=coach_headers,
        ).get_json()

        started = client.post(
            "/api/play/start",
            json={
                "access_code_id": code["id"],
                "player_name": "Dre Vance",
                "player_id": player_id,
            },
        )
        assert started.status_code == 201, started.get_json()

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(quiz_id=quiz_id).one()
            assert attempt.player_id == player_id

    def test_the_safety_net_never_guesses_between_two_same_name_players(
        self, app, client, coach_headers
    ):
        # Two canonical players share a name and both are in the group. The
        # attempt stays unlinked rather than being attributed to a coin flip.
        first = make_player(client, coach_headers, "Jordan", "Smith")
        second = make_player(client, coach_headers, "Jordan", "Smith")
        group_id = make_group(client, coach_headers)
        client.post(
            f"/api/groups/{group_id}/members",
            json={"player_ids": [first, second]},
            headers=coach_headers,
        )
        quiz_id = make_quiz(client, coach_headers)
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Q", "question_type": "written", "options": []},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes",
            json={"group_ids": [group_id]},
            headers=coach_headers,
        ).get_json()

        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Jordan Smith"},
        )
        assert started.status_code == 201

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(quiz_id=quiz_id).one()
            assert attempt.player_id is None


class TestLegacyRemoval:
    """The legacy section is removal-only in the UI, so removal has to work -
    including for the very last entry."""

    def test_the_final_legacy_group_member_can_be_removed(self, app, client, coach_headers):
        group_id = make_group(client, coach_headers)
        client.put(
            f"/api/groups/{group_id}/players",
            json={"players": ["Old Legacy Name"]},
            headers=coach_headers,
        )

        response = client.put(
            f"/api/groups/{group_id}/players", json={"players": []}, headers=coach_headers
        )

        assert response.status_code == 200, response.get_json()
        with app.app_context():
            assert GroupPlayer.query.filter_by(group_id=group_id).count() == 0

    def test_removing_legacy_names_leaves_canonical_members_alone(
        self, app, client, coach_headers
    ):
        player_id = make_player(client, coach_headers, "Dre", "Vance")
        group_id = make_group(client, coach_headers)
        client.post(
            f"/api/groups/{group_id}/members",
            json={"player_ids": [player_id]},
            headers=coach_headers,
        )
        client.put(
            f"/api/groups/{group_id}/players",
            json={"players": ["Old Legacy Name"]},
            headers=coach_headers,
        )

        client.put(
            f"/api/groups/{group_id}/players", json={"players": []}, headers=coach_headers
        )

        with app.app_context():
            rows = GroupPlayer.query.filter_by(group_id=group_id).all()
            assert [row.player_id for row in rows] == [player_id]

    def test_the_final_legacy_quiz_roster_entry_can_be_removed(self, app, client, coach_headers):
        quiz_id = make_quiz(client, coach_headers)
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": ["Old Legacy Name"]},
            headers=coach_headers,
        )

        response = client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": []}, headers=coach_headers
        )

        assert response.status_code == 200, response.get_json()

    def test_an_empty_csv_is_still_rejected(self, client, coach_headers):
        # Removal is an intent; an empty file is a mistake.
        group_id = make_group(client, coach_headers)

        # Rejected by the CSV parser itself (400), before name resolution is
        # ever reached.
        assert upload_group_csv(client, coach_headers, group_id, "\n").status_code == 400
