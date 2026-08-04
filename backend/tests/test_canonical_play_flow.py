"""The core bug this project exists to fix: two canonical Players who
share a display name must both be able to join, autosave, and submit the
same quiz activation without colliding - and a legacy, name-only entry on
the same roster must keep working exactly as before, untouched."""

import pytest


@pytest.fixture
def quiz_with_question(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Coverage Quiz"}, headers=coach_headers).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this cover 2?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )
    return quiz


def activate_with_group(client, headers, quiz_id, group_id):
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={"group_ids": [group_id]}, headers=headers
    ).get_json()


def make_player(client, headers, first, last, number, position):
    return client.post(
        "/api/players",
        json={"first_name": first, "last_name": last, "jersey_number": number, "position": position},
        headers=headers,
    ).get_json()


def test_two_same_name_players_both_attempt_the_same_activation(client, coach_headers, quiz_with_question):
    chris_wr = make_player(client, coach_headers, "Chris", "Smith", "2", "WR")
    chris_lb = make_player(client, coach_headers, "Chris", "Smith", "42", "LB")

    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [chris_wr["id"], chris_lb["id"]]},
        headers=coach_headers,
    )

    access_code = activate_with_group(client, coach_headers, quiz_with_question["id"], group["id"])

    validated = client.post("/api/play/validate-code", json={"code": access_code["code"]}).get_json()
    v2_ids = {p["player_id"] for p in validated["roster_players_v2"]}
    assert v2_ids == {chris_wr["id"], chris_lb["id"]}

    start_wr = client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Chris Smith", "player_id": chris_wr["id"]},
    )
    assert start_wr.status_code == 201

    start_lb = client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Chris Smith", "player_id": chris_lb["id"]},
    )
    assert start_lb.status_code == 201
    assert start_wr.get_json()["attempt_id"] != start_lb.get_json()["attempt_id"]

    question_id = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["id"]
    quiz_options = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["options"]
    option_true = quiz_options[0]["id"]
    option_false = quiz_options[1]["id"]

    # Deliberately different answers per player - if results ever got
    # commingled between the two same-name Players, this makes it show up
    # as a wrong is_correct value below rather than silently passing.
    per_player_answer = {chris_wr["id"]: option_true, chris_lb["id"]: option_false}
    for player in (chris_wr, chris_lb):
        selected_option_id = per_player_answer[player["id"]]
        save = client.post(
            "/api/play/answers",
            json={
                "access_code_id": access_code["id"],
                "player_name": "Chris Smith",
                "player_id": player["id"],
                "question_id": question_id,
                "selected_option_id": selected_option_id,
            },
        )
        assert save.status_code == 204

        submit = client.post(
            "/api/play/submit",
            json={
                "access_code_id": access_code["id"],
                "player_name": "Chris Smith",
                "player_id": player["id"],
                "answers": [{"question_id": question_id, "selected_option_id": selected_option_id}],
            },
        )
        assert submit.status_code == 201

    # Both attempts exist, distinct, each correctly attributed by player_id.
    responses = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()
    assert len(responses) == 2
    assert {r["player_id"] for r in responses} == {chris_wr["id"], chris_lb["id"]}

    # /play/results must also disambiguate by player_id, not just /start -
    # a name-only lookup can't tell two "Chris Smith"s apart and would
    # silently return whichever attempt the query finds first.
    results_wr = client.post(
        "/api/play/results",
        json={"code": access_code["code"], "player_name": "Chris Smith", "player_id": chris_wr["id"]},
    ).get_json()
    results_lb = client.post(
        "/api/play/results",
        json={"code": access_code["code"], "player_name": "Chris Smith", "player_id": chris_lb["id"]},
    ).get_json()
    assert results_wr["answers"][0]["your_answer"] == "True"
    assert results_wr["answers"][0]["is_correct"] is True
    assert results_lb["answers"][0]["your_answer"] == "False"
    assert results_lb["answers"][0]["is_correct"] is False


def test_roster_players_v2_carries_photo_url_for_same_name_disambiguation(
    client, coach_headers, quiz_with_question
):
    """photo_url rides along on the public player-selection list specifically
    so a player can tell two same-name Players apart at a glance - a legacy,
    name-only slot has no Player to photograph, so it's always null."""
    from tests.conftest import make_image_file

    chris_wr = make_player(client, coach_headers, "Chris", "Smith", "2", "WR")
    chris_lb = make_player(client, coach_headers, "Chris", "Smith", "42", "LB")

    file_obj, filename = make_image_file()
    client.post(
        f"/api/players/{chris_wr['id']}/photo",
        data={"photo": (file_obj, filename)},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [chris_wr["id"], chris_lb["id"]]},
        headers=coach_headers,
    )
    access_code = activate_with_group(client, coach_headers, quiz_with_question["id"], group["id"])

    validated = client.post("/api/play/validate-code", json={"code": access_code["code"]}).get_json()
    by_id = {p["player_id"]: p["photo_url"] for p in validated["roster_players_v2"]}

    assert by_id[chris_wr["id"]] is not None
    assert by_id[chris_wr["id"]].startswith("/uploads/")
    assert by_id[chris_lb["id"]] is None


def test_legacy_name_only_attempt_still_works_unaffected(client, coach_headers, quiz_with_question):
    """No Player records involved at all - the original, pre-master-roster
    flow, which must keep working exactly as before."""
    client.put(
        f"/api/quizzes/{quiz_with_question['id']}/roster",
        json={"players": ["Jordan Legacy"]},
        headers=coach_headers,
    )
    access_code = client.post(
        f"/api/quizzes/{quiz_with_question['id']}/access-codes", headers=coach_headers
    ).get_json()

    start = client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Legacy"},
    )
    assert start.status_code == 201

    question_id = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["id"]
    option_true = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["options"][0]["id"]

    submit = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Legacy",
            "answers": [{"question_id": question_id, "selected_option_id": option_true}],
        },
    )
    assert submit.status_code == 201
    assert submit.get_json()["player_id"] is None
    assert submit.get_json()["player_name"] == "Jordan Legacy"


def test_client_supplied_player_id_is_rejected_if_not_actually_on_the_roster(
    client, coach_headers, quiz_with_question
):
    """A player_id the client sends must be validated server-side, not
    trusted as proof of eligibility - a Player that exists in this
    organization but isn't part of this activation's effective roster must
    not be able to start an attempt just by naming its id."""
    unrelated_player = make_player(client, coach_headers, "Not", "OnRoster", "9", "K")
    client.put(
        f"/api/quizzes/{quiz_with_question['id']}/roster",
        json={"players": ["Someone Else"]},
        headers=coach_headers,
    )
    access_code = client.post(
        f"/api/quizzes/{quiz_with_question['id']}/access-codes", headers=coach_headers
    ).get_json()

    response = client.post(
        "/api/play/start",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Not OnRoster",
            "player_id": unrelated_player["id"],
        },
    )
    assert response.status_code == 422


def test_cross_organization_player_id_cannot_be_used_to_start_an_attempt(
    client, coach_headers, register_coach, quiz_with_question
):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_org_player = make_player(client, other_headers, "Other", "Org", "1", "QB")

    client.put(
        f"/api/quizzes/{quiz_with_question['id']}/roster",
        json={"players": ["Other Org"]},
        headers=coach_headers,
    )
    access_code = client.post(
        f"/api/quizzes/{quiz_with_question['id']}/access-codes", headers=coach_headers
    ).get_json()

    response = client.post(
        "/api/play/start",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Other Org",
            "player_id": other_org_player["id"],
        },
    )
    assert response.status_code == 422


def test_player_history_unifies_activity_from_multiple_groups(client, coach_headers, quiz_with_question):
    player = make_player(client, coach_headers, "Jordan", "Multi", "10", "WR")
    group_a = client.post("/api/groups", json={"name": "Safeties"}, headers=coach_headers).get_json()
    group_b = client.post("/api/groups", json={"name": "Special Teams"}, headers=coach_headers).get_json()
    for group in (group_a, group_b):
        client.post(
            f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers
        )

    access_code = activate_with_group(client, coach_headers, quiz_with_question["id"], group_a["id"])
    question_id = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["id"]
    option_true = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["options"][0]["id"]

    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Multi", "player_id": player["id"]},
    )
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Multi",
            "player_id": player["id"],
            "answers": [{"question_id": question_id, "selected_option_id": option_true}],
        },
    )

    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    assert history["summary"]["assigned_count"] == 1
    assert history["summary"]["completed_count"] == 1
    assert history["summary"]["completion_percent"] == 100.0
    assert history["summary"]["average_score_percent"] == 100.0
    assert {g["name"] for g in history["summary"]["current_groups"]} == {"Safeties", "Special Teams"}
    assert history["history"][0]["quiz_title"] == "Coverage Quiz"


def test_player_history_is_organization_scoped(client, coach_headers, register_coach):
    player = make_player(client, coach_headers, "Mine", "Player", None, None)
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get(f"/api/players/{player['id']}/history", headers=other_headers)
    assert response.status_code == 404


def _complete_quiz_as(client, access_code, quiz_id, coach_headers, player_name, player_id, correct=True):
    question = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()["questions"][0]
    option_id = question["options"][0 if correct else 1]["id"]
    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": player_name, "player_id": player_id},
    )
    return client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": player_name,
            "player_id": player_id,
            "answers": [{"question_id": question["id"], "selected_option_id": option_id}],
        },
    )


def test_results_display_name_reflects_a_canonical_players_current_name(
    client, coach_headers, quiz_with_question
):
    """The core of this fix: renaming a Player after they've completed a
    quiz must update what the coach Results tab shows for that attempt,
    without touching the attempt's identity or the historical snapshot."""
    player = make_player(client, coach_headers, "Chris", "Smith", "2", "WR")
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers
    )
    access_code = activate_with_group(client, coach_headers, quiz_with_question["id"], group["id"])

    submit = _complete_quiz_as(
        client, access_code, quiz_with_question["id"], coach_headers, "Chris Smith", player["id"]
    )
    assert submit.status_code == 201
    attempt_id = submit.get_json()["id"]

    # Before the rename: display_name and the historical snapshot agree.
    before = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()[0]
    assert before["player_name"] == "Chris Smith"
    assert before["display_name"] == "Chris Smith"
    assert before["player_id"] == player["id"]

    client.patch(
        f"/api/players/{player['id']}",
        json={"first_name": "Christopher", "last_name": "Smith-Jones", "jersey_number": "2", "position": "WR"},
        headers=coach_headers,
    )

    after_list = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()[0]
    assert after_list["display_name"] == "Christopher Smith-Jones"
    # The historical snapshot never changes, and the attempt is still the
    # exact same row (same id, same player_id) - only the *display* moved.
    assert after_list["player_name"] == "Chris Smith"
    assert after_list["id"] == attempt_id
    assert after_list["player_id"] == player["id"]

    after_single = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses/{attempt_id}", headers=coach_headers
    ).get_json()
    assert after_single["display_name"] == "Christopher Smith-Jones"

    # Grading/scores are untouched by the rename.
    assert after_single["answers"][0]["is_correct"] is True

    csv_text = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/export.csv", headers=coach_headers
    ).get_data(as_text=True)
    assert "Christopher Smith-Jones" in csv_text
    assert "Chris Smith" not in csv_text.split("\n", 1)[1]  # not in the data rows (header aside)


def test_legacy_name_only_attempt_displays_correctly_in_results(client, coach_headers, quiz_with_question):
    client.put(
        f"/api/quizzes/{quiz_with_question['id']}/roster",
        json={"players": ["Jordan Legacy"]},
        headers=coach_headers,
    )
    access_code = client.post(
        f"/api/quizzes/{quiz_with_question['id']}/access-codes", headers=coach_headers
    ).get_json()
    submit = _complete_quiz_as(
        client, access_code, quiz_with_question["id"], coach_headers, "Jordan Legacy", None
    )
    assert submit.status_code == 201

    response = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()[0]
    assert response["player_id"] is None
    assert response["player_name"] == "Jordan Legacy"
    assert response["display_name"] == "Jordan Legacy"


def test_same_name_players_remain_separately_displayed_after_a_rename(
    client, coach_headers, quiz_with_question
):
    chris_wr = make_player(client, coach_headers, "Chris", "Smith", "2", "WR")
    chris_lb = make_player(client, coach_headers, "Chris", "Smith", "42", "LB")
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [chris_wr["id"], chris_lb["id"]]},
        headers=coach_headers,
    )
    access_code = activate_with_group(client, coach_headers, quiz_with_question["id"], group["id"])

    _complete_quiz_as(
        client, access_code, quiz_with_question["id"], coach_headers, "Chris Smith", chris_wr["id"], correct=True
    )
    _complete_quiz_as(
        client, access_code, quiz_with_question["id"], coach_headers, "Chris Smith", chris_lb["id"], correct=False
    )

    # Rename only the WR - the LB must be completely unaffected.
    client.patch(
        f"/api/players/{chris_wr['id']}",
        json={"first_name": "Christopher", "last_name": "Smith", "jersey_number": "2", "position": "WR"},
        headers=coach_headers,
    )

    responses = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()
    by_player_id = {r["player_id"]: r for r in responses}
    assert by_player_id[chris_wr["id"]]["display_name"] == "Christopher Smith"
    assert by_player_id[chris_lb["id"]]["display_name"] == "Chris Smith"
    # Scores stayed attached to the right player throughout.
    assert by_player_id[chris_wr["id"]]["answers"][0]["is_correct"] is True
    assert by_player_id[chris_lb["id"]]["answers"][0]["is_correct"] is False
