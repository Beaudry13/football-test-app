"""Access code activation and deactivation."""


def build_activatable_quiz(client, headers):
    quiz = client.post("/api/quizzes", json={"title": "Week 1 Prep"}, headers=headers).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q1", "question_type": "written", "options": []},
        headers=headers,
    )
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=headers)
    return quiz


def test_cannot_activate_quiz_without_questions(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Empty Quiz"}, headers=coach_headers).get_json()
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["A"]}, headers=coach_headers)

    response = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers)
    assert response.status_code == 422


def test_cannot_activate_quiz_without_roster(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "No Roster"}, headers=coach_headers).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q1", "question_type": "written", "options": []},
        headers=coach_headers,
    )

    response = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers)
    assert response.status_code == 422


def test_activate_quiz_generates_24_hour_code(client, coach_headers):
    quiz = build_activatable_quiz(client, coach_headers)

    response = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers)

    assert response.status_code == 201
    body = response.get_json()
    assert len(body["code"]) == 6
    assert body["is_active"] is True
    assert body["is_valid"] is True


def test_reactivating_retires_previous_code(client, coach_headers):
    quiz = build_activatable_quiz(client, coach_headers)

    first = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    second = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()

    codes = client.get(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    codes_by_id = {c["id"]: c for c in codes}

    assert codes_by_id[first["id"]]["is_active"] is False
    assert codes_by_id[second["id"]]["is_active"] is True


def build_quiz_with_questions_but_no_roster(client, headers):
    quiz = client.post("/api/quizzes", json={"title": "Group Only"}, headers=headers).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q1", "question_type": "written", "options": []},
        headers=headers,
    )
    return quiz


def create_group_with_players(client, headers, name="Defense", players=("Jordan Smith",)):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    client.put(f"/api/groups/{group['id']}/players", json={"players": list(players)}, headers=headers)
    return group


def test_can_activate_a_quiz_with_no_roster_if_a_group_is_selected(client, coach_headers):
    quiz = build_quiz_with_questions_but_no_roster(client, coach_headers)
    group = create_group_with_players(client, coach_headers)

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=coach_headers,
    )

    assert response.status_code == 201
    body = response.get_json()
    assert [g["id"] for g in body["groups"]] == [group["id"]]


def test_activation_still_fails_with_no_roster_and_an_empty_group(client, coach_headers):
    quiz = build_quiz_with_questions_but_no_roster(client, coach_headers)
    group = client.post("/api/groups", json={"name": "Empty"}, headers=coach_headers).get_json()

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=coach_headers,
    )

    assert response.status_code == 422


def test_cannot_activate_with_another_coachs_group(client, coach_headers, register_coach):
    quiz = build_activatable_quiz(client, coach_headers)
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_group = create_group_with_players(client, other_headers)

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [other_group["id"]]},
        headers=coach_headers,
    )

    assert response.status_code == 404
