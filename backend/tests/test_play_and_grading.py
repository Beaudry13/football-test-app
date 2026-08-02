"""End-to-end player flow: join with a code, submit answers, coach grades results."""

import threading
from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models import AccessCode


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


def start_attempt(client, access_code_id, player_name):
    return client.post(
        "/api/play/start", json={"access_code_id": access_code_id, "player_name": player_name}
    )


def start_and_submit(client, access_code_id, player_name, answers):
    """Most tests just want an existing, submitted attempt - start one and
    submit it, since /submit now requires /start to have happened first."""
    start_attempt(client, access_code_id, player_name)
    return client.post(
        "/api/play/submit",
        json={"access_code_id": access_code_id, "player_name": player_name, "answers": answers},
    )


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


def _activate_with_group(client, headers, quiz, group_players):
    group = client.post("/api/groups", json={"name": "Defense"}, headers=headers).get_json()
    client.put(
        f"/api/groups/{group['id']}/players", json={"players": group_players}, headers=headers
    )
    return client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=headers,
    ).get_json()


def test_group_linked_access_code_replaces_the_quizs_own_roster_at_join_time(client, coach_headers):
    # build_ready_quiz's roster is ["Jordan Smith", "Alex Lee"] - a group
    # linked to a *new* activation must completely override that, not add to it.
    quiz, _, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(client, coach_headers, quiz, ["Sam Rivera"])

    response = client.post("/api/play/validate-code", json={"code": access_code["code"]})

    assert response.status_code == 200
    assert response.get_json()["roster_players"] == ["Sam Rivera"]


def test_start_rejects_a_quiz_roster_name_that_is_not_in_the_linked_group(client, coach_headers):
    quiz, _, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(client, coach_headers, quiz, ["Sam Rivera"])

    # "Jordan Smith" is on the quiz's own roster but not in the linked group -
    # the group must win even though the name would be valid without it.
    # This is now rejected at name-selection (/start), not just at submit -
    # an invalid name never gets to create an attempt at all.
    response = start_attempt(client, access_code["id"], "Jordan Smith")
    assert response.status_code == 422


def test_submit_succeeds_for_a_name_that_is_in_the_linked_group(client, coach_headers):
    quiz, tf_question, written_question, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(client, coach_headers, quiz, ["Sam Rivera"])

    response = start_and_submit(
        client,
        access_code["id"],
        "Sam Rivera",
        [
            {"question_id": tf_question["id"]},
            {"question_id": written_question["id"], "answer_text": "x"},
        ],
    )
    assert response.status_code == 201


def test_expired_code_is_rejected_at_validate_and_submit(app, client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    with app.app_context():
        code_row = db.session.get(AccessCode, access_code["id"])
        code_row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

    validate_response = client.post("/api/play/validate-code", json={"code": access_code["code"]})
    assert validate_response.status_code == 404

    submit_response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )
    assert submit_response.status_code == 404


def test_deactivated_code_is_rejected_even_before_expiry(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    quiz_id = access_code["quiz_id"]

    client.post(
        f"/api/quizzes/{quiz_id}/access-codes/{access_code['id']}/deactivate", headers=coach_headers
    )

    validate_response = client.post("/api/play/validate-code", json={"code": access_code["code"]})
    assert validate_response.status_code == 404

    submit_response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )
    assert submit_response.status_code == 404


def test_submit_quiz_auto_grades_true_false_and_leaves_written_ungraded(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    correct_option_id = next(
        o["id"]
        for o in client.get(
            f"/api/quizzes/{tf_question['quiz_id']}", headers=coach_headers
        ).get_json()["questions"][0]["options"]
        if o["is_correct_answer"]
    )

    response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"], "selected_option_id": correct_option_id},
            {"question_id": written_question["id"], "answer_text": "I set the edge."},
        ],
    )

    assert response.status_code == 201
    answers = {a["question_id"]: a for a in response.get_json()["answers"]}
    assert answers[tf_question["id"]]["is_correct"] is True
    assert answers[written_question["id"]]["is_correct"] is None


def test_start_rejects_player_not_on_roster(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)

    response = start_attempt(client, access_code["id"], "Not On Roster")

    assert response.status_code == 422


def test_submit_rejects_duplicate_submission(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    answers = [{"question_id": tf_question["id"]}]

    first = start_and_submit(client, access_code["id"], "Jordan Smith", answers)
    second = client.post(
        "/api/play/submit",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Smith", "answers": answers},
    )

    assert first.status_code == 201
    assert second.status_code == 409


def test_start_rejects_starting_again_after_already_submitted(client, coach_headers):
    """Requirement 4's other half: no new attempt under the same name once
    one has already been submitted for this activation."""
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    response = start_attempt(client, access_code["id"], "Jordan Smith")

    assert response.status_code == 409


def test_autosave_rejects_once_the_attempt_is_submitted(client, coach_headers):
    """The hard lock: once submitted, no further edits via autosave either."""
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    response = client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": tf_question["id"],
            "selected_option_id": None,
            "answer_text": None,
        },
    )

    assert response.status_code == 409


def test_submit_rejects_truly_concurrent_duplicate_submissions(app, coach_headers):
    """Two requests that both pass the status check before either commits (a
    real race, not just two sequential calls) must still only produce one
    locked attempt - the conditional UPDATE is the real guard, not the
    status check alone."""
    with app.test_client() as setup_client:
        _, tf_question, _, access_code = build_ready_quiz(setup_client, coach_headers)
        start_attempt(setup_client, access_code["id"], "Jordan Smith")

    payload = {
        "access_code_id": access_code["id"],
        "player_name": "Jordan Smith",
        "answers": [{"question_id": tf_question["id"]}],
    }

    barrier = threading.Barrier(2)
    results = []

    def submit():
        barrier.wait()
        with app.test_client() as thread_client:
            response = thread_client.post("/api/play/submit", json=payload)
            results.append(response.status_code)

    threads = [threading.Thread(target=submit) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(results) == [201, 409]

    with app.test_client() as verify_client:
        responses = verify_client.get(
            f"/api/quizzes/{access_code['quiz_id']}/responses", headers=coach_headers
        ).get_json()
    assert len(responses) == 1


def test_submit_rejects_duplicate_question_id_within_one_submission(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"]},
            {"question_id": tf_question["id"]},
        ],
    )

    assert response.status_code == 422


def test_submit_rejects_answer_for_question_deleted_after_player_loaded_quiz(client, coach_headers):
    """A player can have the quiz open (from validate-code) while the coach is
    still editing it. If the coach deletes a question in that window, the
    player's eventual submission for it must be rejected cleanly, not crash."""
    quiz, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)

    client.delete(f"/api/quizzes/{quiz['id']}/questions/{written_question['id']}", headers=coach_headers)

    response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"]},
            {"question_id": written_question["id"], "answer_text": "still typing when it vanished"},
        ],
    )

    assert response.status_code == 422


def test_submit_rejects_after_entire_quiz_deleted_mid_flow(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    client.delete(f"/api/quizzes/{quiz['id']}", headers=coach_headers)

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )

    assert response.status_code == 404


def test_submit_rejects_option_id_from_before_coach_edited_question(client, coach_headers):
    """The player's client holds option ids from when they loaded the quiz. If
    the coach edits the question's options in the meantime (replacing them
    with new rows/ids), a stale option id must be rejected, not silently
    misgraded against whatever option happens to now hold that id."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    stale_option_id = tf_question["options"][0]["id"]

    client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf_question['id']}",
        json={
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ]
        },
        headers=coach_headers,
    )

    response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [{"question_id": tf_question["id"], "selected_option_id": stale_option_id}],
    )

    assert response.status_code == 422


def test_coach_can_grade_written_answer_and_leave_feedback(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"]},
            {"question_id": written_question["id"], "answer_text": "I set the edge."},
        ],
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
    start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"]},
            {"question_id": written_question["id"], "answer_text": "I set the edge."},
        ],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers)

    assert response.status_code == 200
    body = response.get_json()
    assert body["roster_size"] == 2
    assert body["response_count"] == 1
    assert body["response_rate"] == 0.5
    assert body["missing_players"] == ["Alex Lee"]
    breakdown_by_id = {q["question_id"]: q for q in body["question_breakdown"]}
    assert breakdown_by_id[written_question["id"]]["ungraded_count"] == 1


def test_quiz_dashboard_excludes_an_in_progress_attempt(client, coach_headers):
    """A player who has only started (not submitted) must not be counted as
    a response - not in response_count/response_rate, and not removed from
    missing_players."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Alex Lee")
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Alex Lee",
            "question_id": tf_question["id"],
            "selected_option_id": None,
            "answer_text": None,
        },
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers)

    assert response.status_code == 200
    body = response.get_json()
    assert body["response_count"] == 0
    assert body["missing_players"] == ["Jordan Smith", "Alex Lee"]

    responses = client.get(f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers).get_json()
    assert responses == []


def test_quiz_dashboard_missing_players_empty_once_everyone_has_submitted(client, coach_headers):
    quiz, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    for player_name in ("Jordan Smith", "Alex Lee"):
        start_and_submit(
            client,
            access_code["id"],
            player_name,
            [
                {"question_id": tf_question["id"]},
                {"question_id": written_question["id"], "answer_text": "I set the edge."},
            ],
        )

    response = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_json()["missing_players"] == []


def test_player_history_across_quizzes(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    response = client.get("/api/players/history?name=Jordan Smith", headers=coach_headers)

    assert response.status_code == 200
    body = response.get_json()
    assert len(body["history"]) == 1
    assert body["history"][0]["quiz_title"] == "Week 1 Prep"


def test_player_history_excludes_an_in_progress_attempt(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")

    response = client.get("/api/players/history?name=Jordan Smith", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_json()["history"] == []


def test_player_can_view_their_own_results_after_submitting(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    correct_option_id = next(
        o["id"]
        for o in client.get(f"/api/quizzes/{tf_question['quiz_id']}", headers=coach_headers).get_json()[
            "questions"
        ][0]["options"]
        if o["is_correct_answer"]
    )
    start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"], "selected_option_id": correct_option_id},
            {"question_id": written_question["id"], "answer_text": "I set the edge."},
        ],
    )

    response = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Jordan Smith"}
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["quiz_title"] == "Week 1 Prep"
    assert body["player_name"] == "Jordan Smith"
    by_id = {a["question_id"]: a for a in body["answers"]}
    assert by_id[tf_question["id"]]["your_answer"] == "True"
    assert by_id[tf_question["id"]]["correct_answer"] == "True"
    assert by_id[tf_question["id"]]["is_correct"] is True
    assert by_id[written_question["id"]]["your_answer"] == "I set the edge."
    assert by_id[written_question["id"]]["correct_answer"] is None
    assert by_id[written_question["id"]]["is_correct"] is None


def test_player_results_name_match_is_case_insensitive(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    response = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "jordan smith"}
    )

    assert response.status_code == 200


def test_player_results_404_for_unknown_code(client):
    response = client.post("/api/play/results", json={"code": "ZZZZZZ", "player_name": "Jordan Smith"})
    assert response.status_code == 404


def test_player_results_404_for_a_name_that_never_submitted(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)

    response = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Alex Lee"}
    )

    assert response.status_code == 404


def test_player_results_404_for_a_name_that_only_started(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Alex Lee")

    response = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Alex Lee"}
    )

    assert response.status_code == 404


def test_player_results_still_works_after_the_access_code_has_expired(app, client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    with app.app_context():
        code_row = db.session.get(AccessCode, access_code["id"])
        code_row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

    # The join/submit gate should still reject the now-expired code...
    validate_response = client.post("/api/play/validate-code", json={"code": access_code["code"]})
    assert validate_response.status_code == 404

    # ...but an already-submitted player's results should still be reviewable.
    results_response = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Jordan Smith"}
    )
    assert results_response.status_code == 200


def test_player_results_reflect_grading_done_after_submission(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client,
        access_code["id"],
        "Jordan Smith",
        [
            {"question_id": tf_question["id"]},
            {"question_id": written_question["id"], "answer_text": "I set the edge."},
        ],
    ).get_json()
    written_answer_id = next(
        a["id"] for a in submit_response["answers"] if a["question_id"] == written_question["id"]
    )

    before = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Jordan Smith"}
    ).get_json()
    before_written = next(a for a in before["answers"] if a["question_id"] == written_question["id"])
    assert before_written["graded_at"] is None

    client.patch(
        f"/api/answers/{written_answer_id}/grade",
        json={"is_correct": True, "coach_feedback": "Nice job identifying the assignment."},
        headers=coach_headers,
    )

    after = client.post(
        "/api/play/results", json={"code": access_code["code"], "player_name": "Jordan Smith"}
    ).get_json()
    after_written = next(a for a in after["answers"] if a["question_id"] == written_question["id"])
    assert after_written["is_correct"] is True
    assert after_written["coach_feedback"] == "Nice job identifying the assignment."
    assert after_written["graded_at"] is not None
