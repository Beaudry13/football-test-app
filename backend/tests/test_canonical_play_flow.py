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
    option_true = client.get(
        f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
    ).get_json()["questions"][0]["options"][0]["id"]

    for player in (chris_wr, chris_lb):
        save = client.post(
            "/api/play/answers",
            json={
                "access_code_id": access_code["id"],
                "player_name": "Chris Smith",
                "player_id": player["id"],
                "question_id": question_id,
                "selected_option_id": option_true,
            },
        )
        assert save.status_code == 204

        submit = client.post(
            "/api/play/submit",
            json={
                "access_code_id": access_code["id"],
                "player_name": "Chris Smith",
                "player_id": player["id"],
                "answers": [{"question_id": question_id, "selected_option_id": option_true}],
            },
        )
        assert submit.status_code == 201

    # Both attempts exist, distinct, each correctly attributed by player_id.
    responses = client.get(
        f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
    ).get_json()
    assert len(responses) == 2
    assert {r["player_id"] for r in responses} == {chris_wr["id"], chris_lb["id"]}


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
    assert history["assigned_count"] == 1
    assert history["completed_count"] == 1
    assert history["completion_percent"] == 100.0
    assert history["average_score_percent"] == 100.0
    assert {g["name"] for g in history["current_groups"]} == {"Safeties", "Special Teams"}
    assert history["recent_results"][0]["quiz_title"] == "Coverage Quiz"


def test_player_history_is_organization_scoped(client, coach_headers, register_coach):
    player = make_player(client, coach_headers, "Mine", "Player", None, None)
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get(f"/api/players/{player['id']}/history", headers=other_headers)
    assert response.status_code == 404
