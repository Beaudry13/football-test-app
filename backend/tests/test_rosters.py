"""Roster manual entry and CSV upload."""

import io


def create_quiz(client, headers):
    return client.post("/api/quizzes", json={"title": "Week 1 Prep"}, headers=headers).get_json()


def test_manual_roster_entry(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith", "Alex Lee", "Sam Diaz"]},
        headers=coach_headers,
    )

    assert response.status_code == 200
    players = response.get_json()["players"]
    assert [p["player_name"] for p in players] == ["Jordan Smith", "Alex Lee", "Sam Diaz"]


def test_roster_upsert_replaces_existing_players(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["A", "B"]}, headers=coach_headers)

    response = client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": ["C"]}, headers=coach_headers
    )

    assert response.status_code == 200
    players = response.get_json()["players"]
    assert [p["player_name"] for p in players] == ["C"]


def test_csv_roster_upload_with_header(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    csv_content = b"name,jersey\nJordan Smith,12\nAlex Lee,7\n"

    response = client.post(
        f"/api/quizzes/{quiz['id']}/roster/csv",
        data={"file": (io.BytesIO(csv_content), "roster.csv")},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    players = response.get_json()["players"]
    assert [p["player_name"] for p in players] == ["Jordan Smith", "Alex Lee"]


def test_csv_roster_upload_without_header(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    csv_content = b"Jordan Smith\nAlex Lee\n"

    response = client.post(
        f"/api/quizzes/{quiz['id']}/roster/csv",
        data={"file": (io.BytesIO(csv_content), "roster.csv")},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    players = response.get_json()["players"]
    assert [p["player_name"] for p in players] == ["Jordan Smith", "Alex Lee"]


def test_empty_roster_list_is_rejected(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": []}, headers=coach_headers)

    assert response.status_code == 422


def test_whitespace_only_names_are_dropped(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["  Jordan Smith  ", "   ", "Alex Lee"]},
        headers=coach_headers,
    )

    assert response.status_code == 200
    players = response.get_json()["players"]
    assert [p["player_name"] for p in players] == ["Jordan Smith", "Alex Lee"]


def test_duplicate_names_are_rejected(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith", "jordan smith"]},
        headers=coach_headers,
    )

    assert response.status_code == 422


def test_duplicate_names_are_rejected_from_csv(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    csv_content = b"Jordan Smith\nJordan Smith\n"

    response = client.post(
        f"/api/quizzes/{quiz['id']}/roster/csv",
        data={"file": (io.BytesIO(csv_content), "roster.csv")},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    assert response.status_code == 422
