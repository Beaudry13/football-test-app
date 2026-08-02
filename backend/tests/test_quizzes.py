"""Quiz CRUD, duplication, and coach data scoping."""

from pathlib import Path

from flask import current_app

from tests.conftest import make_image_file


def create_quiz(client, headers, title="Week 1 Prep"):
    response = client.post(
        "/api/quizzes",
        json={"title": title, "description": "Cover the base defense", "one_question_at_a_time": False},
        headers=headers,
    )
    assert response.status_code == 201
    return response.get_json()


def test_create_and_list_quizzes(client, coach_headers):
    create_quiz(client, coach_headers, title="Week 1 Prep")

    response = client.get("/api/quizzes", headers=coach_headers)
    assert response.status_code == 200
    quizzes = response.get_json()
    assert len(quizzes) == 1
    assert quizzes[0]["title"] == "Week 1 Prep"


def test_list_quizzes_reports_is_active(client, coach_headers):
    active_quiz = create_quiz(client, coach_headers, title="Active Quiz")
    create_quiz(client, coach_headers, title="Never Activated")

    client.post(
        f"/api/quizzes/{active_quiz['id']}/questions",
        json={
            "question_text": "Is this active?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )
    client.put(
        f"/api/quizzes/{active_quiz['id']}/roster",
        json={"players": ["Jordan Smith"]},
        headers=coach_headers,
    )
    activate_response = client.post(
        f"/api/quizzes/{active_quiz['id']}/access-codes", headers=coach_headers
    )
    assert activate_response.status_code == 201

    quizzes_by_title = {q["title"]: q for q in client.get("/api/quizzes", headers=coach_headers).get_json()}
    assert quizzes_by_title["Active Quiz"]["is_active"] is True
    assert quizzes_by_title["Never Activated"]["is_active"] is False


def test_quiz_endpoints_require_auth(client):
    assert client.get("/api/quizzes").status_code == 401
    assert client.post("/api/quizzes", json={"title": "x"}).status_code == 401


def test_get_update_delete_quiz(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    quiz_id = quiz["id"]

    get_response = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers)
    assert get_response.status_code == 200
    assert get_response.get_json()["questions"] == []

    patch_response = client.patch(
        f"/api/quizzes/{quiz_id}", json={"title": "Week 1 Prep (Updated)"}, headers=coach_headers
    )
    assert patch_response.status_code == 200
    assert patch_response.get_json()["title"] == "Week 1 Prep (Updated)"

    delete_response = client.delete(f"/api/quizzes/{quiz_id}", headers=coach_headers)
    assert delete_response.status_code == 204
    assert client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).status_code == 404


def test_deleting_a_quiz_removes_its_question_images_from_storage(app, client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    file_obj, filename = make_image_file()
    image_url = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=coach_headers,
        content_type="multipart/form-data",
    ).get_json()["image_url"]

    with app.app_context():
        image_path = Path(current_app.config["UPLOAD_FOLDER"]) / image_url.rsplit("/", 1)[-1]
    assert image_path.exists()

    delete_response = client.delete(f"/api/quizzes/{quiz['id']}", headers=coach_headers)
    assert delete_response.status_code == 204
    assert not image_path.exists()


def test_coach_cannot_access_another_coachs_quiz(client, register_coach):
    _, _, coach_a_headers = register_coach(username="coachA", email="a@example.com")
    _, _, coach_b_headers = register_coach(username="coachB", email="b@example.com")

    quiz = create_quiz(client, coach_a_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_b_headers)
    assert response.status_code == 404


def test_duplicate_quiz_copies_questions_and_options(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is the flat defended?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )

    response = client.post(f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers)

    assert response.status_code == 201
    copy = response.get_json()
    assert copy["title"] == f"{quiz['title']} (Copy)"
    assert len(copy["questions"]) == 1
    assert len(copy["questions"][0]["options"]) == 2
