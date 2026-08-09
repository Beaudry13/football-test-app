"""The First Success checklist.

The rules under test are the ones that would be invisible if they broke:
completion is DERIVED (so it un-ticks when the data goes away, and is
retroactively right for accounts older than the feature), scope decides what
an invited coach sees, and onboarding never waits on a player.
"""

from datetime import datetime, timezone

import pytest

from app.extensions import db
from app.models import AttemptStatus, Coach, PlayerAttempt


def get_progress(client, headers):
    response = client.get("/api/onboarding", headers=headers)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def step(progress, step_id):
    return next(s for s in progress["steps"] if s["id"] == step_id)


def make_quiz(client, headers, title="Install 1"):
    response = client.post("/api/quizzes", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_question(client, headers, quiz_id, text="Name the coverage"):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": text, "question_type": "written", "options": []},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_player(client, headers, first="Sam", last="Reed"):
    response = client.post(
        "/api/players", json={"first_name": first, "last_name": last}, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_group(client, headers, name="Linebackers"):
    response = client.post("/api/groups", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def add_to_group(client, headers, group_id, player_ids):
    response = client.post(
        f"/api/groups/{group_id}/members",
        json={"player_ids": player_ids},
        headers=headers,
    )
    assert response.status_code in (200, 201), response.get_json()


def activate(client, headers, quiz_id, group_ids=None):
    response = client.post(
        f"/api/quizzes/{quiz_id}/access-codes",
        json={"group_ids": group_ids or []},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def set_quiz_roster(client, headers, quiz_id, names=("Sam Reed",)):
    response = client.put(
        f"/api/quizzes/{quiz_id}/roster", json={"players": list(names)}, headers=headers
    )
    assert response.status_code in (200, 201), response.get_json()


def complete_onboarding(client, headers):
    """Drive a coach all the way through the checklist.

    Returns (quiz_id, access_code) so callers that need an attempt can reuse
    the code this made rather than activating a second time.
    """
    quiz_id = make_quiz(client, headers)
    make_question(client, headers, quiz_id)
    player_id = make_player(client, headers)
    group_id = make_group(client, headers)
    add_to_group(client, headers, group_id, [player_id])
    code = activate(client, headers, quiz_id, group_ids=[group_id])
    return quiz_id, code


class TestFreshCoach:
    def test_every_step_starts_incomplete(self, client, coach_headers):
        progress = get_progress(client, coach_headers)

        assert progress["completed_count"] == 0
        assert progress["complete"] is False
        assert all(s["complete"] is False for s in progress["steps"])
        assert progress["next_step_id"] == "create_quiz"

    def test_the_checklist_is_the_seven_agreed_steps_in_order(self, client, coach_headers):
        # Pinned deliberately. The list is a product decision, and a step
        # appearing or vanishing should be a decision someone made, not a
        # side effect of editing the registry.
        progress = get_progress(client, coach_headers)

        assert [s["id"] for s in progress["steps"]] == [
            "create_quiz",
            "add_question",
            "build_roster",
            "create_group",
            "add_players_to_group",
            "activate_quiz",
            "assign_to_group",
        ]

    def test_no_step_waits_on_a_player(self, client, coach_headers):
        # The rule that keeps the checklist finishable at a desk: nothing in
        # it may depend on somebody else picking up a phone.
        progress = get_progress(client, coach_headers)

        assert not any("player complete" in s["title"].lower() for s in progress["steps"])

    def test_requires_authentication(self, client):
        assert client.get("/api/onboarding").status_code == 401


class TestProgression:
    def test_each_action_ticks_its_own_step(self, client, coach_headers):
        quiz_id = make_quiz(client, coach_headers)
        progress = get_progress(client, coach_headers)
        assert step(progress, "create_quiz")["complete"] is True
        assert step(progress, "add_question")["complete"] is False
        assert progress["next_step_id"] == "add_question"

        make_question(client, coach_headers, quiz_id)
        assert step(get_progress(client, coach_headers), "add_question")["complete"] is True

        player_id = make_player(client, coach_headers)
        assert step(get_progress(client, coach_headers), "build_roster")["complete"] is True

        group_id = make_group(client, coach_headers)
        progress = get_progress(client, coach_headers)
        assert step(progress, "create_group")["complete"] is True
        assert step(progress, "add_players_to_group")["complete"] is False

        add_to_group(client, coach_headers, group_id, [player_id])
        assert step(get_progress(client, coach_headers), "add_players_to_group")["complete"] is True

    def test_activating_without_a_group_leaves_the_assign_step_open(
        self, client, coach_headers
    ):
        # These are genuinely two different things a coach learns: making a
        # code at all, and restricting it to a unit. An access code with no
        # groups falls back to the quiz's own roster, so it must not tick
        # the assign step.
        quiz_id = make_quiz(client, coach_headers)
        make_question(client, coach_headers, quiz_id)
        # A code with no groups needs the quiz's own roster to fall back on -
        # activation refuses to create one nobody can use.
        set_quiz_roster(client, coach_headers, quiz_id)
        activate(client, coach_headers, quiz_id)

        progress = get_progress(client, coach_headers)
        assert step(progress, "activate_quiz")["complete"] is True
        assert step(progress, "assign_to_group")["complete"] is False

    def test_finishing_everything_completes_onboarding(self, client, coach_headers):
        complete_onboarding(client, coach_headers)

        progress = get_progress(client, coach_headers)
        assert progress["complete"] is True
        assert progress["completed_count"] == progress["total_count"] == 7
        assert progress["next_step_id"] is None


class TestDerivedNotStored:
    def test_a_step_un_ticks_when_its_data_goes_away(self, client, coach_headers):
        player_id = make_player(client, coach_headers)
        assert step(get_progress(client, coach_headers), "build_roster")["complete"] is True

        assert client.delete(f"/api/players/{player_id}", headers=coach_headers).status_code in (
            200,
            204,
        )

        # A stored flag would still be claiming a roster exists. This is the
        # whole reason completion is computed rather than recorded.
        assert step(get_progress(client, coach_headers), "build_roster")["complete"] is False

    def test_completion_is_right_for_an_account_that_predates_the_feature(
        self, client, coach_headers
    ):
        # There is no migration that backfills progress, so the proof is that
        # data created with no knowledge of onboarding still reads correctly.
        complete_onboarding(client, coach_headers)
        assert get_progress(client, coach_headers)["complete"] is True


class TestScope:
    def test_an_invited_coach_inherits_the_organisation_steps(
        self, client, coach_headers, invite_teammate
    ):
        # THE case the scope field exists for. The admin builds the shared
        # infrastructure; the teammate who joins afterwards should never be
        # told to build a roster that is already there.
        player_id = make_player(client, coach_headers)
        group_id = make_group(client, coach_headers)
        add_to_group(client, coach_headers, group_id, [player_id])

        _, _, teammate_headers = invite_teammate(coach_headers)
        progress = get_progress(client, teammate_headers)

        assert step(progress, "build_roster")["complete"] is True
        assert step(progress, "create_group")["complete"] is True
        assert step(progress, "add_players_to_group")["complete"] is True
        # ...and still has their own work to do.
        assert step(progress, "create_quiz")["complete"] is False
        assert progress["next_step_id"] == "create_quiz"

    def test_a_teammates_quiz_is_not_your_first_quiz(
        self, client, coach_headers, invite_teammate
    ):
        # Coach View is own-only (services/quiz_scope). Ticking this step off
        # somebody else's quiz would send a coach to a checklist that says
        # they are set up when they have never made anything.
        quiz_id = make_quiz(client, coach_headers)
        make_question(client, coach_headers, quiz_id)

        _, _, teammate_headers = invite_teammate(coach_headers)
        progress = get_progress(client, teammate_headers)

        assert step(progress, "create_quiz")["complete"] is False
        assert step(progress, "add_question")["complete"] is False

    def test_an_admin_gets_no_wider_scope_than_a_member(
        self, client, coach_headers, invite_teammate
    ):
        # Admin View is a separate surface. The checklist is about *your*
        # setup, so being an admin must not tick steps off a member's work.
        _, _, teammate_headers = invite_teammate(coach_headers)
        quiz_id = make_quiz(client, teammate_headers)
        make_question(client, teammate_headers, quiz_id)

        progress = get_progress(client, coach_headers)
        assert step(progress, "create_quiz")["complete"] is False


class TestActionRoutes:
    def test_every_route_points_at_a_real_page(self, client, coach_headers):
        # This backend knows a handful of frontend paths (the action buttons).
        # Pinning them means renaming a React Router path fails here instead
        # of shipping a button that lands on a 404.
        progress = get_progress(client, coach_headers)
        routes = {s["id"]: s["route"] for s in progress["steps"]}

        assert routes == {
            "create_quiz": "/dashboard",
            "add_question": "/dashboard",
            "build_roster": "/roster",
            "create_group": "/groups",
            "add_players_to_group": "/groups",
            "activate_quiz": "/dashboard",
            "assign_to_group": "/dashboard",
        }

    def test_the_roster_step_offers_both_ways_in(self, client, coach_headers):
        # A coach with a spreadsheet and a coach with three names need
        # different first clicks, and neither should have to hunt for theirs.
        progress = get_progress(client, coach_headers)
        roster = step(progress, "build_roster")

        assert roster["secondary_action"] == {
            "label": "Upload a roster",
            "route": "/roster?import=1",
        }

    def test_only_the_roster_step_has_a_second_action(self, client, coach_headers):
        progress = get_progress(client, coach_headers)
        with_secondary = [s["id"] for s in progress["steps"] if s["secondary_action"]]

        assert with_secondary == ["build_roster"]

    def test_adding_players_to_a_group_links_to_the_group_itself(
        self, client, coach_headers
    ):
        # The groups list has no way to add a player, so landing there is a
        # dead end - the useful destination is the group that was just made.
        group_id = make_group(client, coach_headers)

        progress = get_progress(client, coach_headers)
        assert step(progress, "add_players_to_group")["route"] == f"/groups/{group_id}"

    def test_quiz_steps_deep_link_to_the_quiz_once_one_exists(self, client, coach_headers):
        quiz_id = make_quiz(client, coach_headers)
        progress = get_progress(client, coach_headers)

        # "Add your first question" should open the quiz they just made, not
        # the quiz list - that is the difference between one click and three.
        assert step(progress, "add_question")["route"] == f"/quizzes/{quiz_id}?tab=questions"
        assert step(progress, "activate_quiz")["route"] == f"/quizzes/{quiz_id}?tab=activate"

    def test_the_newest_quiz_is_the_one_linked(self, client, coach_headers):
        make_quiz(client, coach_headers, title="Old")
        newest = make_quiz(client, coach_headers, title="New")

        progress = get_progress(client, coach_headers)
        assert step(progress, "add_question")["route"] == f"/quizzes/{newest}?tab=questions"


class TestMilestone:
    def test_hidden_until_onboarding_is_complete(self, client, coach_headers):
        assert get_progress(client, coach_headers)["milestone"] is None

    def test_offered_once_onboarding_is_complete_and_cannot_hold_it_open(
        self, client, coach_headers
    ):
        complete_onboarding(client, coach_headers)
        progress = get_progress(client, coach_headers)

        # Onboarding is finished even though no player has ever touched the
        # quiz. The milestone is a suggestion, not a requirement.
        assert progress["complete"] is True
        assert progress["milestone"]["id"] == "first_player_completion"
        assert progress["milestone"]["complete"] is False

    def test_completes_when_a_player_submits(self, app, client, coach_headers):
        quiz_id, code = complete_onboarding(client, coach_headers)

        # Written straight to the table rather than driven through /play: the
        # play flow has its own tests, and what is under test here is only
        # that the milestone counts SUBMITTED attempts.
        with app.app_context():
            db.session.add(
                PlayerAttempt(
                    quiz_id=quiz_id,
                    access_code_id=code["id"],
                    player_name="Sam Reed",
                    status=AttemptStatus.SUBMITTED,
                    submitted_at=datetime.now(timezone.utc),
                )
            )
            db.session.commit()

        assert get_progress(client, coach_headers)["milestone"]["complete"] is True

    def test_an_unfinished_attempt_does_not_count(self, app, client, coach_headers):
        quiz_id, code = complete_onboarding(client, coach_headers)

        with app.app_context():
            db.session.add(
                PlayerAttempt(
                    quiz_id=quiz_id,
                    access_code_id=code["id"],
                    player_name="Sam Reed",
                    status=AttemptStatus.IN_PROGRESS,
                )
            )
            db.session.commit()

        # A player who opened the quiz and wandered off has not completed it.
        assert get_progress(client, coach_headers)["milestone"]["complete"] is False


class TestDismissal:
    def test_dismiss_then_restore(self, client, coach_headers):
        assert get_progress(client, coach_headers)["dismissed"] is False

        dismissed = client.post("/api/onboarding/dismiss", headers=coach_headers)
        assert dismissed.status_code == 200
        assert dismissed.get_json()["dismissed"] is True
        assert dismissed.get_json()["dismissed_at"] is not None
        assert get_progress(client, coach_headers)["dismissed"] is True

        restored = client.delete("/api/onboarding/dismiss", headers=coach_headers)
        assert restored.status_code == 200
        assert restored.get_json()["dismissed"] is False
        assert get_progress(client, coach_headers)["dismissed_at"] is None

    def test_dismissing_twice_keeps_the_first_timestamp(self, client, coach_headers):
        first = client.post("/api/onboarding/dismiss", headers=coach_headers).get_json()
        second = client.post("/api/onboarding/dismiss", headers=coach_headers).get_json()

        assert first["dismissed_at"] == second["dismissed_at"]

    def test_dismissing_does_not_fake_progress(self, client, coach_headers):
        # Hiding the checklist is not finishing it. If these were ever
        # conflated, a coach who dismissed on day one would be treated as
        # set up forever.
        client.post("/api/onboarding/dismiss", headers=coach_headers)
        progress = get_progress(client, coach_headers)

        assert progress["dismissed"] is True
        assert progress["complete"] is False
        assert progress["completed_count"] == 0

    def test_dismissal_is_per_coach(self, client, coach_headers, invite_teammate):
        _, _, teammate_headers = invite_teammate(coach_headers)
        client.post("/api/onboarding/dismiss", headers=coach_headers)

        assert get_progress(client, teammate_headers)["dismissed"] is False

    def test_dismissal_is_the_only_stored_onboarding_state(self, app):
        # Guards the architecture rather than a behaviour: if a second
        # onboarding column ever appears on Coach, that is a decision worth
        # making on purpose, because everything else is meant to be derived.
        with app.app_context():
            onboarding_columns = [
                column.name
                for column in Coach.__table__.columns
                if "onboarding" in column.name
            ]
        assert onboarding_columns == ["onboarding_dismissed_at"]


@pytest.mark.parametrize("scope", ["coach", "organization"])
def test_every_step_declares_a_known_scope(client, coach_headers, scope):
    progress = get_progress(client, coach_headers)
    scopes = {s["scope"] for s in progress["steps"]}

    assert scopes <= {"coach", "organization"}
    assert scope in scopes
