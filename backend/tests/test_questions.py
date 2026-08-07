"""Question CRUD, option validation, reordering, and image annotation."""

import io

from tests.conftest import make_image_file
from tests.test_play_and_grading import build_ready_quiz, start_and_submit


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


def test_annotation_update_persists_canvas_width(client, coach_headers):
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
    image = upload_response.get_json()
    assert image["canvas_width"] is None

    annotate_response = client.put(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
        json={"annotations": [], "canvas_width": 1400},
        headers=coach_headers,
    )
    assert annotate_response.status_code == 200
    assert annotate_response.get_json()["canvas_width"] == 1400

    # Omitting canvas_width on a later save (an older frontend bundle, or a
    # request that only touches annotations) must not wipe out a width
    # that's already pinned.
    second_response = client.put(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
        json={"annotations": []},
        headers=coach_headers,
    )
    assert second_response.status_code == 200
    assert second_response.get_json()["canvas_width"] == 1400


def test_oversized_image_upload_is_rejected_with_friendly_message(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    oversized_file = io.BytesIO(b"0" * (11 * 1024 * 1024))
    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (oversized_file, "huge.png")},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    assert response.status_code == 413
    assert "too large" in response.get_json()["error"].lower()


def test_wrong_file_extension_is_rejected(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    fake_executable = io.BytesIO(b"not actually an image")
    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (fake_executable, "payload.exe")},
        headers=coach_headers,
        content_type="multipart/form-data",
    )

    assert response.status_code == 400


def test_cannot_change_options_on_a_question_players_have_already_answered(client, coach_headers):
    """Answer.question_id/selected_option_id cascade (DELETE/SET NULL) so an
    edit never crashes - but that same cascade would silently detach an
    already-graded answer from its option with no audit trail. Once a real
    answer exists, this must be a loud 422, not a quiet data loss."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"], "selected_option_id": tf_question["options"][0]["id"]}]
    )

    response = client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}",
        json={
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ]
        },
        headers=coach_headers,
    )

    assert response.status_code == 422
    assert "already answered" in response.get_json()["error"].lower()


def test_can_still_edit_question_text_after_players_have_answered(client, coach_headers):
    """The guard is specifically about options (which are what player
    answers reference) - editing wording (e.g. fixing a typo) must keep
    working even after some players have already answered."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"], "selected_option_id": tf_question["options"][0]["id"]}]
    )

    response = client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}",
        json={"question_text": "Is this actually cover 2?"},
        headers=coach_headers,
    )

    assert response.status_code == 200
    assert response.get_json()["question_text"] == "Is this actually cover 2?"


def test_cannot_delete_a_question_players_have_already_answered(client, coach_headers):
    """Deleting a question cascades and permanently destroys every player's
    recorded (and possibly already-graded) answer for it with no audit
    trail - block it once real answers exist rather than silently losing
    graded data."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"], "selected_option_id": tf_question["options"][0]["id"]}]
    )

    response = client.delete(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}", headers=coach_headers
    )

    assert response.status_code == 422
    assert "already answered" in response.get_json()["error"].lower()


def test_can_still_delete_a_question_nobody_has_answered_yet(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    response = client.delete(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}", headers=coach_headers
    )

    assert response.status_code == 204


# --- Draw Response ------------------------------------------------------
#
# Drawing is a question TYPE, not a flag on another type. See
# docs/DESIGN-draw-response-phase-3.md for why that reversed, and migration
# d2b5f8a41c32 for how existing flagged questions were converted.


def _draw_question(client, headers, quiz, text="Draw your run fit"):
    return client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": text, "question_type": "draw_response", "options": []},
        headers=headers,
    )


def _upload_image(client, headers, quiz, question):
    file_obj, filename = make_image_file()
    return client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=headers,
        content_type="multipart/form-data",
    )


def test_can_create_a_draw_response_question_without_an_image(client, coach_headers):
    """The image cannot be required at creation - the upload targets an
    existing question, so demanding one up front makes the type impossible to
    create. It is required at activation instead."""
    quiz = create_quiz(client, coach_headers)

    response = _draw_question(client, coach_headers, quiz)

    assert response.status_code == 201
    body = response.get_json()
    assert body["question_type"] == "draw_response"
    assert body["needs_image"] is True


def test_draw_response_question_reports_ready_once_it_has_an_image(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = _draw_question(client, coach_headers, quiz).get_json()
    assert _upload_image(client, coach_headers, quiz, question).status_code == 201

    quiz_after = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
    stored = next(q for q in quiz_after["questions"] if q["id"] == question["id"])
    assert stored["needs_image"] is False


def test_draw_response_question_needs_no_options(client, coach_headers):
    quiz = create_quiz(client, coach_headers)

    response = _draw_question(client, coach_headers, quiz)

    assert response.status_code == 201
    assert response.get_json()["options"] == []


def test_cannot_activate_a_quiz_whose_draw_question_has_no_image(client, coach_headers):
    """The check that actually protects a roster: a player must never meet a
    Draw Response question with nothing to draw on."""
    quiz = create_quiz(client, coach_headers)
    _draw_question(client, coach_headers, quiz)
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith"]},
        headers=coach_headers,
    )

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )

    assert response.status_code == 422
    body = response.get_json()
    assert "image" in body["error"].lower()
    assert body["details"]["questions_needing_images"] == [1]


def test_can_activate_once_every_draw_question_has_an_image(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    question = _draw_question(client, coach_headers, quiz).get_json()
    _upload_image(client, coach_headers, quiz, question)
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith"]},
        headers=coach_headers,
    )

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )

    assert response.status_code == 201


def test_removing_the_image_blocks_activation_again(client, coach_headers):
    """An image deleted after authoring puts the quiz back into the invalid
    state without the coach touching the question, so the guard has to be
    evaluated at activation rather than remembered from creation."""
    quiz = create_quiz(client, coach_headers)
    question = _draw_question(client, coach_headers, quiz).get_json()
    _upload_image(client, coach_headers, quiz, question)
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith"]},
        headers=coach_headers,
    )
    assert (
        client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers).status_code
        == 201
    )

    client.delete(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image", headers=coach_headers
    )

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert response.status_code == 422


def test_a_quiz_with_no_draw_questions_activates_unchanged(client, coach_headers):
    """The guard must not disturb every quiz that predates the feature."""
    quiz = create_quiz(client, coach_headers)
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Cover 2?", "question_type": "written", "options": []},
        headers=coach_headers,
    )
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith"]},
        headers=coach_headers,
    )

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert response.status_code == 201
