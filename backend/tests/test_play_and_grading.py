"""End-to-end player flow: join with a code, submit answers, coach grades results."""


def build_ready_quiz(client, headers):
    quiz = client.post("/api/quizzes", json={"title": "Week 1 Prep"}, headers=headers).get_json()

    tf_question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this cover 2?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    ).get_json()

    written_question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Describe your assignment.", "question_type": "written", "options": []},
        headers=headers,
    ).get_json()

    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": ["Jordan Smith", "Alex Lee"]},
        headers=headers,
    )
    access_code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=headers).get_json()

    return quiz, tf_question, written_question, access_code


def test_validate_code_returns_quiz_without_correct_answers(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    response = client.post("/api/play/validate-code", json={"code": access_code["code"]})

    assert response.status_code == 200
    body = response.get_json()
    assert body["access_code_id"] == access_code["id"]
    assert "Jordan Smith" in body["roster_players"]

    tf_from_response = next(q for q in body["quiz"]["questions"] if q["id"] == tf_question["id"])
    for option in tf_from_response["options"]:
        assert "is_correct_answer" not in option


def test_validate_invalid_code_returns_404(client):
    response = client.post("/api/play/validate-code", json={"code": "BADCOD"})
    assert response.status_code == 404


def test_submit_quiz_auto_grades_true_false_and_leaves_written_ungraded(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    correct_option_id = next(
        o["id"]
        for o in client.get(
            f"/api/quizzes/{tf_question['quiz_id']}", headers=coach_headers
        ).get_json()["questions"][0]["options"]
        if o["is_correct_answer"]
    )

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [
                {"question_id": tf_question["id"], "selected_option_id": correct_option_id},
                {"question_id": written_question["id"], "answer_text": "I set the edge."},
            ],
        },
    )

    assert response.status_code == 201
    answers = {a["question_id"]: a for a in response.get_json()["answers"]}
    assert answers[tf_question["id"]]["is_correct"] is True
    assert answers[written_question["id"]]["is_correct"] is None


def test_submit_rejects_player_not_on_roster(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Not On Roster",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )

    assert response.status_code == 422


def test_submit_rejects_duplicate_submission(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    payload = {
        "access_code_id": access_code["id"],
        "player_name": "Jordan Smith",
        "answers": [{"question_id": tf_question["id"]}],
    }

    first = client.post("/api/play/submit", json=payload)
    second = client.post("/api/play/submit", json=payload)

    assert first.status_code == 201
    assert second.status_code == 409


def test_coach_can_grade_written_answer_and_leave_feedback(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    submit_response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [
                {"question_id": tf_question["id"]},
                {"question_id": written_question["id"], "answer_text": "I set the edge."},
            ],
        },
    ).get_json()
    written_answer_id = next(
        a["id"] for a in submit_response["answers"] if a["question_id"] == written_question["id"]
    )

    response = client.patch(
        f"/api/answers/{written_answer_id}/grade",
        json={"is_correct": True, "coach_feedback": "Nice job identifying the assignment."},
        headers=coach_headers,
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["is_correct"] is True
    assert body["coach_feedback"] == "Nice job identifying the assignment."
    assert body["graded_at"] is not None


def test_quiz_dashboard_summarizes_responses(client, coach_headers):
    quiz, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [
                {"question_id": tf_question["id"]},
                {"question_id": written_question["id"], "answer_text": "I set the edge."},
            ],
        },
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers)

    assert response.status_code == 200
    body = response.get_json()
    assert body["roster_size"] == 2
    assert body["response_count"] == 1
    assert body["response_rate"] == 0.5
    breakdown_by_id = {q["question_id"]: q for q in body["question_breakdown"]}
    assert breakdown_by_id[written_question["id"]]["ungraded_count"] == 1


def test_player_history_across_quizzes(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )

    response = client.get("/api/players/history?name=Jordan Smith", headers=coach_headers)

    assert response.status_code == 200
    body = response.get_json()
    assert len(body["history"]) == 1
    assert body["history"][0]["quiz_title"] == "Week 1 Prep"
