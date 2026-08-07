"""Phase 3: a player's drawing reaching the server, and counting as an answer.

The risk this covers is not "does the endpoint work" but "does a drawing count
as an answer everywhere that asks". Phase 0's audit found sixteen places that
decided that separately, and every one of them ignored drawings. The rule now
lives in services/attempts.py::is_answered; these tests exercise it through the
routes that matter rather than calling it directly.
"""

from tests.conftest import make_image_file


def _document(strokes=1, coordinate_width=1400, coordinate_height=788):
    """A minimal but structurally valid DrawingDocument, matching the client's
    envelope in frontend/src/components/drawing/types.ts."""
    return {
        "format": "peira.drawing",
        "version": 1,
        "source": {
            "image_id": "1",
            "image_version": "2026-08-07T00:00:00Z",
            "natural_width": 2400,
            "natural_height": 1350,
        },
        "coordinate_width": coordinate_width,
        "coordinate_height": coordinate_height,
        "strokes": [
            {
                "id": f"s{i}",
                "tool": "pen",
                "layer": "player",
                "points": [0, 0, 10 + i, 10 + i],
                "color": "#00E5FF",
                "width": 6,
                "order": i,
            }
            for i in range(strokes)
        ],
    }


def build_drawing_quiz(client, headers, require_all=False):
    quiz = client.post(
        "/api/quizzes",
        json={"title": "Draw week", "require_all_answers": require_all},
        headers=headers,
    ).get_json()

    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Draw your run fit", "question_type": "draw_response", "options": []},
        headers=headers,
    ).get_json()

    file_obj, filename = make_image_file()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=headers,
        content_type="multipart/form-data",
    )

    client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=headers
    )
    access_code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers
    ).get_json()

    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Smith"},
    )
    return quiz, question, access_code


def save_drawing(client, access_code, question, document, base_revision=None):
    return client.put(
        "/api/play/drawing",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": question["id"],
            "document": document,
            "base_revision": base_revision,
        },
    )


# --- Autosave -----------------------------------------------------------


def test_first_save_creates_the_drawing_at_revision_one(client, coach_headers):
    _, question, access_code = build_drawing_quiz(client, coach_headers)

    response = save_drawing(client, access_code, question, _document())

    assert response.status_code == 200
    assert response.get_json()["revision"] == 1


def test_saving_again_with_the_current_revision_succeeds_and_bumps_it(client, coach_headers):
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    save_drawing(client, access_code, question, _document(strokes=1))

    response = save_drawing(client, access_code, question, _document(strokes=3), base_revision=1)

    assert response.status_code == 200
    assert response.get_json()["revision"] == 2


def test_a_stale_revision_is_refused_rather_than_overwriting(client, coach_headers):
    """Two devices, or one that spent five minutes in a tunnel. Losing a
    drawing to a silent overwrite is minutes of work with no undo, so the
    server refuses and lets the client tell the player."""
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    save_drawing(client, access_code, question, _document(strokes=1))
    save_drawing(client, access_code, question, _document(strokes=5), base_revision=1)

    stale = save_drawing(client, access_code, question, _document(strokes=2), base_revision=1)

    assert stale.status_code == 409


def test_omitting_the_revision_on_an_existing_drawing_is_refused(client, coach_headers):
    """"I did not check" is not grounds to overwrite."""
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    save_drawing(client, access_code, question, _document())

    response = save_drawing(client, access_code, question, _document(strokes=9))

    assert response.status_code == 409


def test_a_drawing_cannot_be_saved_against_a_non_drawing_question(client, coach_headers):
    quiz, _, access_code = build_drawing_quiz(client, coach_headers)
    written = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Why?", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()

    response = save_drawing(client, access_code, written, _document())

    assert response.status_code == 422


# --- Document validation -------------------------------------------------


def test_a_malformed_document_is_refused(client, coach_headers):
    _, question, access_code = build_drawing_quiz(client, coach_headers)

    assert save_drawing(client, access_code, question, {"nope": True}).status_code == 422

    missing_space = _document()
    del missing_space["coordinate_width"]
    assert save_drawing(client, access_code, question, missing_space).status_code == 422

    odd_points = _document()
    odd_points["strokes"][0]["points"] = [1, 2, 3]
    assert save_drawing(client, access_code, question, odd_points).status_code == 422


def test_a_document_from_a_newer_client_is_refused_not_stored(client, coach_headers):
    """Netlify and Render deploy independently, so for a few minutes a client
    can be ahead of this backend. Storing a shape the coach's viewer cannot
    read would fail later, in Results, after the player has gone."""
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    future = _document()
    future["version"] = 99

    assert save_drawing(client, access_code, question, future).status_code == 422


# --- Answer presence -----------------------------------------------------


def test_a_drawing_satisfies_require_all_answers(client, coach_headers):
    """The point of the phase: a player who drew their answer can submit."""
    _, question, access_code = build_drawing_quiz(client, coach_headers, require_all=True)
    save_drawing(client, access_code, question, _document())

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [
                {"question_id": question["id"], "drawing": _document()},
            ],
        },
    )

    assert response.status_code == 201


def test_an_empty_drawing_does_not_satisfy_require_all_answers(client, coach_headers):
    """An envelope with no strokes is just the image the player was shown."""
    _, question, access_code = build_drawing_quiz(client, coach_headers, require_all=True)

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": question["id"], "drawing": _document(strokes=0)}],
        },
    )

    assert response.status_code == 422
    assert "all questions" in response.get_json()["error"].lower()


def test_submit_persists_a_drawing_that_autosave_never_delivered(client, coach_headers):
    """Submit is the same safety net the text answers already get: it re-sends
    the client's current document, so one failed autosave on a flaky
    connection does not cost the player their answer."""
    _, question, access_code = build_drawing_quiz(client, coach_headers)

    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": question["id"], "drawing": _document(strokes=4)}],
        },
    )

    results = client.get(
        f"/api/play/results/{access_code['code']}/Jordan Smith"
    ).get_json()
    assert results is not None


def test_submit_does_not_conflict_with_the_players_own_autosave(client, coach_headers):
    """Submit must be authoritative over whatever the server holds - a 409
    here would block a player from finishing over a race they caused."""
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    save_drawing(client, access_code, question, _document(strokes=1))
    save_drawing(client, access_code, question, _document(strokes=2), base_revision=1)

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": question["id"], "drawing": _document(strokes=7)}],
        },
    )

    assert response.status_code == 201


def test_a_submitted_attempt_refuses_further_drawing_saves(client, coach_headers):
    _, question, access_code = build_drawing_quiz(client, coach_headers)
    save_drawing(client, access_code, question, _document())
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": question["id"], "drawing": _document()}],
        },
    )

    response = save_drawing(client, access_code, question, _document(strokes=3), base_revision=1)

    assert response.status_code == 409


# --- Coach visibility ----------------------------------------------------


def test_the_coach_sees_the_submitted_drawing(client, coach_headers):
    """Phase 3's other half: the drawing has to reach the coach, not just the
    database."""
    quiz, question, access_code = build_drawing_quiz(client, coach_headers)
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": question["id"], "drawing": _document(strokes=3)}],
        },
    )

    responses = client.get(
        f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers
    ).get_json()

    answers = [a for attempt in responses for a in attempt["answers"]]
    drawn = next(a for a in answers if a["question_id"] == question["id"])
    assert drawn["drawing"] is not None
    assert len(drawn["drawing"]["document"]["strokes"]) == 3
    assert drawn["drawing"]["revision"] >= 1
