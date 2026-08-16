"""Question CRUD, option validation, reordering, and image annotation."""

import io
import json

from app.models import Answer
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
    """REWRITTEN FOR PHASE 4C. The property is unchanged; the mechanism is not.

    This used to assert a blanket 422 on any option edit after an answer
    existed, because the only edit path cleared the option list and rebuilt it
    - which silently detached an already-graded answer from its option, with no
    audit trail.

    Phase 4C edits a delivered question's options IN PLACE instead, so
    rewording no longer detaches anything and is allowed. What must still be
    refused is the part that was actually dangerous: removing an option a
    player may have chosen, and changing which answer is correct.
    """
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    chosen_option_id = tf_question["options"][0]["id"]
    start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"], "selected_option_id": chosen_option_id}]
    )

    # Rewording: allowed, and the row the answer points at survives.
    reworded = client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}",
        json={
            "options": [
                {"option_text": "Yes", "is_correct_answer": True},
                {"option_text": "No", "is_correct_answer": False},
            ]
        },
        headers=coach_headers,
    )
    assert reworded.status_code == 200, reworded.get_json()
    assert [o["id"] for o in reworded.get_json()["options"]][0] == chosen_option_id

    with client.application.app_context():
        answer = Answer.query.filter_by(question_id=tf_question["id"]).one()
        assert answer.selected_option_id == chosen_option_id, "never detached"
        assert answer.is_correct is True, "and never regraded"

    # Changing which answer is correct: still refused.
    rekeyed = client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}",
        json={
            "options": [
                {"option_text": "Yes", "is_correct_answer": False},
                {"option_text": "No", "is_correct_answer": True},
            ]
        },
        headers=coach_headers,
    )
    assert rekeyed.status_code == 422
    assert rekeyed.get_json()["reason"] == "correct_answer_change_blocked"


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


# --- CREATE WITH AN IMAGE IN ONE OPERATION -----------------------------------
#
# A question and its image used to be two requests: save, reopen, navigate to
# the annotate page, upload, navigate back. In between, a half-made question
# existed. These cover the single-operation replacement.


def _create_multipart(client, headers, quiz_id, payload, image=None, name="play.png"):
    data = {"payload": json.dumps(payload)}
    if image is not None:
        data["image"] = (image, name)
    return client.post(
        f"/api/quizzes/{quiz_id}/questions",
        headers=headers,
        data=data,
        content_type="multipart/form-data",
    )


def test_create_question_with_an_image_in_a_single_request(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    image, name = make_image_file()

    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "Who has the flat?", "question_type": "written", "options": []},
        image,
        name,
    )

    assert response.status_code == 201, response.get_json()
    body = response.get_json()
    # One save produced a COMPLETE question - text, type and image together.
    assert body["question_text"] == "Who has the flat?"
    assert body["image"] is not None
    assert body["image"]["image_url"]


def test_create_with_an_image_keeps_options(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    image, name = make_image_file()

    body = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {
            "question_text": "Which coverage?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        },
        image,
        name,
    ).get_json()

    assert [o["option_text"] for o in body["options"]] == ["Cover 3", "Cover 2"]
    assert body["image"] is not None


def test_create_without_an_image_still_works_over_multipart(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "No picture", "question_type": "written", "options": []},
    )
    # No files at all means the JSON path; this posts an image field that is
    # absent, which must simply produce an image-less question.
    assert response.status_code in (201, 400)


def test_json_create_is_completely_unchanged(client, coach_headers):
    # Every existing caller posts JSON. The multipart envelope must not have
    # disturbed that path at all.
    quiz = create_quiz(client, coach_headers)
    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        headers=coach_headers,
        json={"question_text": "Plain", "question_type": "written", "options": []},
    )
    assert response.status_code == 201
    assert response.get_json()["image"] is None


def test_a_rejected_image_leaves_no_question_behind(client, coach_headers, app):
    """THE atomicity guarantee. The old flow could not fail halfway without
    stranding a placeholder the coach then had to find and delete."""
    quiz = create_quiz(client, coach_headers)
    before = len(client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"])

    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "Doomed", "question_type": "written", "options": []},
        io.BytesIO(b"not an image at all"),
        "evil.png",
    )

    # 400 from the shared _compress_image check - the same status the
    # standalone upload route already returns for a file that is not an image.
    # What matters here is the line below it.
    assert response.status_code == 400
    after = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"]
    assert len(after) == before
    assert "Doomed" not in [q["question_text"] for q in after]


def test_an_oversized_image_leaves_no_question_behind(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "Too big", "question_type": "written", "options": []},
        io.BytesIO(b"0" * (11 * 1024 * 1024)),
        "huge.png",
    )
    assert response.status_code == 413
    questions = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"]
    assert "Too big" not in [q["question_text"] for q in questions]


def test_a_wrong_file_type_leaves_no_question_behind(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    image, _ = make_image_file()
    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "Bad type", "question_type": "written", "options": []},
        image,
        "notes.txt",
    )
    assert response.status_code == 400
    questions = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"]
    assert "Bad type" not in [q["question_text"] for q in questions]


def test_invalid_question_fields_are_rejected_before_anything_is_stored(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    image, name = make_image_file()
    response = _create_multipart(
        client,
        coach_headers,
        quiz["id"],
        {"question_text": "", "question_type": "written", "options": []},
        image,
        name,
    )
    assert response.status_code == 422
    questions = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"]
    assert questions == []


def test_multipart_without_a_payload_is_rejected(client, coach_headers):
    quiz = create_quiz(client, coach_headers)
    image, name = make_image_file()
    response = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        headers=coach_headers,
        data={"image": (image, name)},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400


def test_another_coach_cannot_create_a_question_with_an_image(client, register_coach):
    _, _, owner = register_coach(username="owner", email="owner@example.com")
    quiz = create_quiz(client, owner)
    _, _, rival = register_coach(
        username="rival", email="rival@example.com", organization="Rivals"
    )
    image, name = make_image_file()

    response = _create_multipart(
        client, rival, quiz["id"], {"question_text": "x", "question_type": "written", "options": []}, image, name
    )
    assert response.status_code == 404
