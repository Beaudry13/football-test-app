"""Question CRUD, option validation, reordering, and image annotation."""

from tests.conftest import make_image_file


def create_quiz(client, headers):
    response = client.post("/api/quizzes", json={"title": "Week 1 Prep"}, headers=headers)
    return response.get_json()


def test_create_true_false_question(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.post(
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

    assert response.status_code == 201
    body = response.get_json()
    assert body["question_type"] == "true_false"
    assert len(body["options"]) == 2


def test_true_false_question_requires_exactly_two_options(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this cover 2?",
            "question_type": "true_false",
            "options": [{"option_text": "True", "is_correct_answer": True}],
        },
        headers=coach_headers,
    )

    assert response.status_code == 422


def test_question_requires_exactly_one_correct_option(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Which gap does the DE fill?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "A gap", "is_correct_answer": True},
                {"option_text": "B gap", "is_correct_answer": True},
                {"option_text": "C gap", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )

    assert response.status_code == 422


def test_written_question_needs_no_options(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Describe the coverage.", "question_type": "written", "options": []},
        headers=coach_headers,
    )

    assert response.status_code == 201
    assert response.get_json()["options"] == []


def test_reorder_questions(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    ids = []
    for text in ("Q1", "Q2", "Q3"):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": text, "question_type": "written", "options": []},
            headers=coach_headers,
        )
        ids.append(response.get_json()["id"])

    reversed_ids = list(reversed(ids))
    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions/reorder",
        json={"question_ids": reversed_ids},
        headers=coach_headers,
    )

    assert response.status_code == 200
    ordered = response.get_json()
    assert [q["id"] for q in ordered] == reversed_ids


def test_reorder_rejects_duplicate_question_ids(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    ids = []
    for text in ("Q1", "Q2"):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": text, "question_type": "written", "options": []},
            headers=coach_headers,
        )
        ids.append(response.get_json()["id"])

    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions/reorder",
        json={"question_ids": [ids[0], ids[0]]},
        headers=coach_headers,
    )

    assert response.status_code == 422


def test_upload_and_delete_question_image(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    file_obj, filename = make_image_file()
    upload_response = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=coach_headers,
        content_type="multipart/form-data",
    )
    assert upload_response.status_code == 201
    image = upload_response.get_json()
    assert image["image_url"].startswith("/uploads/")

    annotations = [{"type": "circle", "x": 10, "y": 20, "radius": 5, "color": "#ff0000"}]
    annotate_response = client.put(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
        json={"annotations": annotations},
        headers=coach_headers,
    )
    assert annotate_response.status_code == 200
    assert annotate_response.get_json()["annotations"] == annotations

    delete_response = client.delete(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image", headers=coach_headers
    )
    assert delete_response.status_code == 204
