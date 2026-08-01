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
