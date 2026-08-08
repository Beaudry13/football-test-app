"""Coach View vs Admin View: who can see whose quizzes.

This is a security boundary, so the tests drive the real API and check the
*absence* of other coaches' data rather than only the presence of one's own -
a scoping bug shows up as something extra, not as something missing.
"""

import pytest

from app.extensions import db
from app.models import Coach, Quiz


def make_quiz(client, headers, title: str) -> dict:
    response = client.post("/api/quizzes", headers=headers, json={"title": title})
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def titles(payload) -> set[str]:
    return {q["title"] for q in payload}


@pytest.fixture
def org(client, register_coach, invite_teammate):
    """One organization: an admin plus two member coaches, each with a quiz.

    register_coach always creates a NEW organization, so the teammates have to
    come through an invite - that is the only way to get several coaches into
    one organization, which is exactly what these tests are about.
    """
    _, _, admin = register_coach(username="theadmin", email="admin@example.com")
    coach_a, _, headers_a = invite_teammate(
        admin, username="coacha", email="coacha@example.com"
    )
    coach_b, _, headers_b = invite_teammate(
        admin, username="coachb", email="coachb@example.com"
    )

    return {
        "admin_headers": admin,
        "a": {"coach": coach_a, "headers": headers_a, "quiz": make_quiz(client, headers_a, "A Quiz")},
        "b": {"coach": coach_b, "headers": headers_b, "quiz": make_quiz(client, headers_b, "B Quiz")},
        "admin_quiz": make_quiz(client, admin, "Admin Quiz"),
    }


class TestCoachViewLists:
    def test_coach_a_sees_only_their_own(self, client, org):
        body = client.get("/api/quizzes", headers=org["a"]["headers"]).get_json()
        assert titles(body) == {"A Quiz"}

    def test_coach_b_sees_only_their_own(self, client, org):
        body = client.get("/api/quizzes", headers=org["b"]["headers"]).get_json()
        assert titles(body) == {"B Quiz"}

    def test_admin_in_coach_view_sees_only_their_own(self, client, org):
        # THE point of the model: being an admin does not widen the normal
        # list. Admin View is a different endpoint, not a bigger response.
        body = client.get("/api/quizzes", headers=org["admin_headers"]).get_json()
        assert titles(body) == {"Admin Quiz"}

    def test_there_is_no_parameter_that_widens_the_coach_list(self, client, org):
        # A scope/mode parameter would be a way to defeat the boundary from a
        # crafted request, so none exists - these are ignored, not honoured.
        for query in ("?scope=org", "?all=true", "?coach_id=", "?organization=1"):
            body = client.get(f"/api/quizzes{query}", headers=org["a"]["headers"]).get_json()
            assert titles(body) == {"A Quiz"}, query

    def test_counts_follow_the_same_scope(self, client, org):
        body = client.get("/api/quizzes", headers=org["a"]["headers"]).get_json()
        # The dashboard's counts are derived from this list client-side, so
        # scoping the list is what scopes the counts and the search box.
        assert len(body) == 1

    def test_active_status_board_is_scoped(self, client, org):
        client.put(
            f"/api/quizzes/{org['b']['quiz']['id']}/roster",
            headers=org["b"]["headers"],
            json={"players": ["Jordan Smith"]},
        )
        client.post(
            f"/api/quizzes/{org['b']['quiz']['id']}/questions",
            headers=org["b"]["headers"],
            json={"question_text": "?", "question_type": "written", "options": []},
        )
        client.post(f"/api/quizzes/{org['b']['quiz']['id']}/access-codes", headers=org["b"]["headers"])

        # Coach B's live quiz must not appear on Coach A's status board.
        assert client.get("/api/quizzes/active-status", headers=org["a"]["headers"]).get_json() == []
        assert len(client.get("/api/quizzes/active-status", headers=org["b"]["headers"]).get_json()) == 1


class TestSingleQuizReads:
    def test_a_member_cannot_fetch_another_coachs_quiz_by_id(self, client, org):
        response = client.get(
            f"/api/quizzes/{org['b']['quiz']['id']}", headers=org["a"]["headers"]
        )
        # 404, not 403: a member must not learn that the id exists.
        assert response.status_code == 404

    def test_a_member_cannot_reach_any_sub_resource_of_it(self, client, org):
        quiz_id = org["b"]["quiz"]["id"]
        headers = org["a"]["headers"]
        for path in (
            f"/api/quizzes/{quiz_id}",
            f"/api/quizzes/{quiz_id}/roster",
            f"/api/quizzes/{quiz_id}/access-codes",
            f"/api/quizzes/{quiz_id}/responses",
            f"/api/quizzes/{quiz_id}/dashboard",
            f"/api/quizzes/{quiz_id}/export.csv",
            f"/api/quizzes/{quiz_id}/export.pdf",
        ):
            assert client.get(path, headers=headers).status_code == 404, path

    def test_a_member_cannot_edit_or_delete_it(self, client, org):
        quiz_id = org["b"]["quiz"]["id"]
        headers = org["a"]["headers"]
        assert client.patch(f"/api/quizzes/{quiz_id}", headers=headers, json={"title": "x"}).status_code == 404
        assert client.delete(f"/api/quizzes/{quiz_id}", headers=headers).status_code == 404

    def test_a_member_cannot_duplicate_it(self, client, org):
        response = client.post(
            f"/api/quizzes/{org['b']['quiz']['id']}/duplicate", headers=org["a"]["headers"]
        )
        assert response.status_code == 404

    def test_an_admin_can_open_any_quiz_in_their_organization(self, client, org):
        # This is what makes Admin View clickable. The split is at lists, not
        # at single reads - see utils/auth.get_visible_quiz.
        response = client.get(
            f"/api/quizzes/{org['b']['quiz']['id']}", headers=org["admin_headers"]
        )
        assert response.status_code == 200
        assert response.get_json()["title"] == "B Quiz"


class TestAdminView:
    def test_sees_every_quiz_in_the_organization(self, client, org):
        body = client.get("/api/organizations/quizzes", headers=org["admin_headers"]).get_json()
        assert titles(body) == {"A Quiz", "B Quiz", "Admin Quiz"}

    def test_shows_the_owner_of_every_quiz(self, client, org):
        body = client.get("/api/organizations/quizzes", headers=org["admin_headers"]).get_json()
        owners = {q["title"]: q["owner"]["username"] for q in body}
        assert owners == {"A Quiz": "coacha", "B Quiz": "coachb", "Admin Quiz": "theadmin"}

    def test_a_member_is_refused(self, client, org):
        assert client.get("/api/organizations/quizzes", headers=org["a"]["headers"]).status_code == 403

    def test_never_sees_another_organization(self, client, org, register_coach):
        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        make_quiz(client, outsider, "Rival Quiz")

        body = client.get("/api/organizations/quizzes", headers=org["admin_headers"]).get_json()
        assert "Rival Quiz" not in titles(body)
        # And their admin cannot see ours.
        theirs = client.get("/api/organizations/quizzes", headers=outsider).get_json()
        assert titles(theirs) == {"Rival Quiz"}

    def test_filters_by_coach(self, client, org):
        coach_a_id = org["a"]["coach"]["id"]
        body = client.get(
            f"/api/organizations/quizzes?coach_id={coach_a_id}", headers=org["admin_headers"]
        ).get_json()
        assert titles(body) == {"A Quiz"}

    def test_searches_across_all_quizzes(self, client, org):
        body = client.get(
            "/api/organizations/quizzes?q=b qu", headers=org["admin_headers"]
        ).get_json()
        assert titles(body) == {"B Quiz"}

    def test_search_is_still_organization_bound(self, client, org, register_coach):
        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        make_quiz(client, outsider, "B Quiz")  # same title, other org
        body = client.get(
            "/api/organizations/quizzes?q=B Quiz", headers=org["admin_headers"]
        ).get_json()
        assert len(body) == 1
        assert body[0]["owner"]["username"] == "coachb"

    def test_rejects_a_nonsense_coach_filter(self, client, org):
        response = client.get(
            "/api/organizations/quizzes?coach_id=abc", headers=org["admin_headers"]
        )
        assert response.status_code == 422


class TestUnassignedQuizzes:
    def _orphan(self, app, quiz_id):
        with app.app_context():
            db.session.get(Quiz, quiz_id).coach_id = None
            db.session.commit()

    def test_an_unassigned_quiz_is_in_nobodys_coach_view(self, client, org, app):
        self._orphan(app, org["b"]["quiz"]["id"])
        for who in ("admin_headers",):
            assert "B Quiz" not in titles(client.get("/api/quizzes", headers=org[who]).get_json())
        assert "B Quiz" not in titles(client.get("/api/quizzes", headers=org["a"]["headers"]).get_json())
        assert "B Quiz" not in titles(client.get("/api/quizzes", headers=org["b"]["headers"]).get_json())

    def test_but_it_is_visible_and_flagged_in_admin_view(self, client, org, app):
        # The whole reason an ownerless quiz is recoverable rather than lost.
        self._orphan(app, org["b"]["quiz"]["id"])
        body = client.get("/api/organizations/quizzes", headers=org["admin_headers"]).get_json()
        orphan = next(q for q in body if q["title"] == "B Quiz")
        assert orphan["owner"] is None
        assert orphan["is_unassigned"] is True

    def test_can_be_filtered_for_directly(self, client, org, app):
        self._orphan(app, org["b"]["quiz"]["id"])
        body = client.get(
            "/api/organizations/quizzes?coach_id=unassigned", headers=org["admin_headers"]
        ).get_json()
        assert titles(body) == {"B Quiz"}


class TestOwnershipTransfer:
    def test_an_admin_can_reassign_a_quiz(self, client, org):
        quiz_id = org["b"]["quiz"]["id"]
        response = client.patch(
            f"/api/organizations/quizzes/{quiz_id}/owner",
            headers=org["admin_headers"],
            json={"coach_id": org["a"]["coach"]["id"]},
        )
        assert response.status_code == 200
        assert response.get_json()["owner"]["username"] == "coacha"

        # And it moves between Coach Views, which is the observable effect.
        assert "B Quiz" in titles(client.get("/api/quizzes", headers=org["a"]["headers"]).get_json())
        assert "B Quiz" not in titles(client.get("/api/quizzes", headers=org["b"]["headers"]).get_json())

    def test_recovers_an_unassigned_quiz(self, client, org, app):
        quiz_id = org["b"]["quiz"]["id"]
        with app.app_context():
            db.session.get(Quiz, quiz_id).coach_id = None
            db.session.commit()

        client.patch(
            f"/api/organizations/quizzes/{quiz_id}/owner",
            headers=org["admin_headers"],
            json={"coach_id": org["a"]["coach"]["id"]},
        )
        assert "B Quiz" in titles(client.get("/api/quizzes", headers=org["a"]["headers"]).get_json())

    def test_a_member_cannot_transfer_ownership(self, client, org):
        response = client.patch(
            f"/api/organizations/quizzes/{org['b']['quiz']['id']}/owner",
            headers=org["a"]["headers"],
            json={"coach_id": org["a"]["coach"]["id"]},
        )
        assert response.status_code == 403

    def test_cannot_transfer_to_a_coach_in_another_organization(
        self, client, org, register_coach
    ):
        outsider_coach, _, _ = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        response = client.patch(
            f"/api/organizations/quizzes/{org['b']['quiz']['id']}/owner",
            headers=org["admin_headers"],
            json={"coach_id": outsider_coach["id"]},
        )
        assert response.status_code == 404

    def test_cannot_transfer_a_quiz_from_another_organization(
        self, client, org, register_coach
    ):
        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        rival_quiz = make_quiz(client, outsider, "Rival Quiz")
        response = client.patch(
            f"/api/organizations/quizzes/{rival_quiz['id']}/owner",
            headers=org["admin_headers"],
            json={"coach_id": org["a"]["coach"]["id"]},
        )
        assert response.status_code == 404

    def test_editing_a_quiz_never_changes_its_owner(self, client, org, app):
        # Ownership decides visibility, so a silent change would make quizzes
        # appear and disappear from dashboards for invisible reasons.
        quiz_id = org["b"]["quiz"]["id"]
        client.patch(f"/api/quizzes/{quiz_id}", headers=org["admin_headers"], json={"title": "Edited"})
        with app.app_context():
            assert db.session.get(Quiz, quiz_id).coach_id == org["b"]["coach"]["id"]


class TestDuplicationOwnership:
    def test_the_duplicator_owns_the_copy(self, client, org):
        copy = client.post(
            f"/api/quizzes/{org['a']['quiz']['id']}/duplicate", headers=org["a"]["headers"]
        ).get_json()
        body = client.get("/api/quizzes", headers=org["a"]["headers"]).get_json()
        assert copy["title"] in titles(body)

    def test_an_admin_duplicating_a_teammates_quiz_owns_the_copy(self, client, org):
        # Otherwise the admin would immediately lose the copy they just made.
        copy = client.post(
            f"/api/quizzes/{org['b']['quiz']['id']}/duplicate", headers=org["admin_headers"]
        ).get_json()
        assert copy["title"] in titles(
            client.get("/api/quizzes", headers=org["admin_headers"]).get_json()
        )
        # And the original stays with its owner.
        assert "B Quiz" in titles(client.get("/api/quizzes", headers=org["b"]["headers"]).get_json())


class TestCoachRemovalCannotStrandQuizzes:
    def test_removal_is_refused_while_the_coach_owns_quizzes(self, client, org):
        response = client.delete(
            f"/api/organizations/members/{org['b']['coach']['id']}", headers=org["admin_headers"]
        )
        assert response.status_code == 409
        body = response.get_json()
        assert body["reason"] == "owns_quizzes"
        # Actionable: it names what is in the way.
        assert body["details"]["quiz_count"] == 1
        assert body["details"]["quizzes"][0]["title"] == "B Quiz"

    def test_the_coach_is_still_there_after_a_refused_removal(self, client, org, app):
        client.delete(
            f"/api/organizations/members/{org['b']['coach']['id']}", headers=org["admin_headers"]
        )
        with app.app_context():
            assert db.session.get(Coach, org["b"]["coach"]["id"]) is not None

    def test_removal_succeeds_once_the_quizzes_are_reassigned(self, client, org, app):
        client.patch(
            f"/api/organizations/quizzes/{org['b']['quiz']['id']}/owner",
            headers=org["admin_headers"],
            json={"coach_id": org["a"]["coach"]["id"]},
        )
        response = client.delete(
            f"/api/organizations/members/{org['b']['coach']['id']}", headers=org["admin_headers"]
        )
        assert response.status_code == 204
        # The quiz survives, with its new owner.
        assert "B Quiz" in titles(client.get("/api/quizzes", headers=org["a"]["headers"]).get_json())

    def test_removal_can_reassign_and_remove_in_one_step(self, client, org, app):
        response = client.delete(
            f"/api/organizations/members/{org['b']['coach']['id']}",
            headers=org["admin_headers"],
            json={"reassign_quizzes_to": org["a"]["coach"]["id"]},
        )
        assert response.status_code == 204
        with app.app_context():
            assert db.session.get(Quiz, org["b"]["quiz"]["id"]).coach_id == org["a"]["coach"]["id"]

    def test_a_coach_with_no_quizzes_can_still_be_removed(self, client, org, invite_teammate):
        _, _, _ = invite_teammate(
            org["admin_headers"], username="newbie", email="newbie@example.com"
        )
        members = client.get("/api/organizations", headers=org["admin_headers"]).get_json()[
            "members"
        ]
        newbie = next(m for m in members if m["username"] == "newbie")
        assert (
            client.delete(
                f"/api/organizations/members/{newbie['id']}", headers=org["admin_headers"]
            ).status_code
            == 204
        )


class TestFolderScoping:
    def _folder(self, client, headers, name, parent=None):
        response = client.post(
            "/api/folders",
            headers=headers,
            json={"name": name, "parent_folder_id": parent},
        )
        assert response.status_code == 201, response.get_json()
        return response.get_json()

    def test_a_coach_does_not_see_another_coachs_folder(self, client, org):
        self._folder(client, org["b"]["headers"], "B Only")
        names = {f["name"] for f in client.get("/api/folders", headers=org["a"]["headers"]).get_json()}
        assert "B Only" not in names

    def test_a_coach_sees_a_folder_they_created(self, client, org):
        self._folder(client, org["a"]["headers"], "A Folder")
        names = {f["name"] for f in client.get("/api/folders", headers=org["a"]["headers"]).get_json()}
        assert "A Folder" in names

    def test_ancestors_are_preserved_so_navigation_still_works(self, client, org):
        """THE folder rule that is easy to get wrong.

        Coach B builds the tree; Coach A's quiz lives in the SUBFOLDER. If only
        folders directly holding A's quizzes were returned, A would receive the
        subfolder without its parent - present in the data, absent from the
        tree the dashboard renders from, and impossible to click to.
        """
        parent = self._folder(client, org["b"]["headers"], "Fall Camp")
        child = self._folder(client, org["b"]["headers"], "Install Quiz", parent=parent["id"])

        client.patch(
            f"/api/quizzes/{org['a']['quiz']['id']}",
            headers=org["a"]["headers"],
            json={"folder_id": child["id"]},
        )

        names = {f["name"] for f in client.get("/api/folders", headers=org["a"]["headers"]).get_json()}
        assert "Install Quiz" in names, "the folder holding A's quiz must be visible"
        assert "Fall Camp" in names, "its parent must come with it or the subfolder is unreachable"

    def test_the_other_coach_still_sees_their_own_tree(self, client, org):
        parent = self._folder(client, org["b"]["headers"], "Fall Camp")
        self._folder(client, org["b"]["headers"], "Install Quiz", parent=parent["id"])
        names = {f["name"] for f in client.get("/api/folders", headers=org["b"]["headers"]).get_json()}
        assert {"Fall Camp", "Install Quiz"} <= names


class TestAnalyticsScope:
    def _submit(self, client, headers, quiz, player="Jordan Smith"):
        """Give a quiz one question, publish it, and have a player submit."""
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            headers=headers,
            json={"question_text": "Assignment?", "question_type": "written", "options": []},
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", headers=headers, json={"players": [player]}
        )
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=headers).get_json()
        client.post(
            "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
        )
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": player,
                "answers": [{"question_id": question["id"], "answer_text": "I set the edge."}],
            },
        )

    def test_coach_view_analytics_show_only_the_coachs_own_quizzes(self, client, org):
        self._submit(client, org["a"]["headers"], org["a"]["quiz"])
        self._submit(client, org["b"]["headers"], org["b"]["quiz"])

        body = client.get(
            "/api/players/history?name=Jordan Smith", headers=org["a"]["headers"]
        ).get_json()
        seen = {row["quiz_title"] for row in body["history"]}
        # Coach A must not learn the title or the scores of Coach B's quiz
        # from the player page - the same leak the quiz list was closed to.
        assert seen == {"A Quiz"}

    def test_admin_coach_view_analytics_are_also_own_only(self, client, org):
        self._submit(client, org["a"]["headers"], org["a"]["quiz"])
        self._submit(client, org["b"]["headers"], org["b"]["quiz"])

        body = client.get(
            "/api/players/history?name=Jordan Smith", headers=org["admin_headers"]
        ).get_json()
        # The admin owns neither quiz, and Coach View does not widen for them.
        assert body["history"] == []

    def test_admin_view_analytics_are_organization_wide(self, client, org):
        self._submit(client, org["a"]["headers"], org["a"]["quiz"])
        self._submit(client, org["b"]["headers"], org["b"]["quiz"])

        body = client.get(
            "/api/organizations/players/history?name=Jordan Smith",
            headers=org["admin_headers"],
        ).get_json()
        # The whole-program view was preserved, not deleted - it moved here.
        assert {row["quiz_title"] for row in body["history"]} == {"A Quiz", "B Quiz"}

    def test_a_member_cannot_reach_the_organization_wide_analytics(self, client, org):
        response = client.get(
            "/api/organizations/players/history?name=Jordan Smith", headers=org["a"]["headers"]
        )
        assert response.status_code == 403

    def test_organization_wide_analytics_never_cross_organizations(
        self, client, org, register_coach
    ):
        self._submit(client, org["a"]["headers"], org["a"]["quiz"])

        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        rival_quiz = make_quiz(client, outsider, "Rival Quiz")
        self._submit(client, outsider, rival_quiz)

        body = client.get(
            "/api/organizations/players/history?name=Jordan Smith",
            headers=org["admin_headers"],
        ).get_json()
        assert "Rival Quiz" not in {row["quiz_title"] for row in body["history"]}
