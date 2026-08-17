"""Attempt lifecycle: start/resume, autosave, and the coach-side manual reset -
the parts of the player flow not already covered by test_play_and_grading.py's
submit/results/dashboard tests."""

import threading
from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models import AccessCode
from tests.test_play_and_grading import build_ready_quiz, start_and_submit, start_attempt


def test_start_creates_an_in_progress_attempt_with_no_answers(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)

    response = start_attempt(client, access_code["id"], "Jordan Smith")

    assert response.status_code == 201
    body = response.get_json()
    assert body["status"] == "in_progress"
    assert body["answers"] == []
    assert isinstance(body["attempt_id"], int)


def test_start_resumes_an_existing_in_progress_attempt_with_its_saved_answers(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": tf_question["id"],
            "selected_option_id": tf_question["options"][0]["id"],
            "answer_text": None,
        },
    )

    response = start_attempt(client, access_code["id"], "Jordan Smith")

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "in_progress"
    assert body["answers"] == [
        {
            "question_id": tf_question["id"],
            "selected_option_id": tf_question["options"][0]["id"],
            "answer_text": None,
            # Practice's per-question lock. Always false on a graded attempt:
            # nothing is revealed there, so nothing locks.
            "checked": False,
            # Added by Draw Response Phase B. None for every non-drawing
            # answer, and asserted here rather than loosened to `in` checks -
            # this test exists to pin the EXACT resume shape, so a new key
            # should have to be acknowledged deliberately.
            "drawing": None,
        }
    ]


def test_resumed_answers_never_include_is_correct(client, coach_headers):
    """A player must not learn which answers are correct before they submit,
    even though is_correct is now computed at autosave time."""
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": tf_question["id"],
            "selected_option_id": tf_question["options"][0]["id"],
            "answer_text": None,
        },
    )

    response = start_attempt(client, access_code["id"], "Jordan Smith")

    assert "is_correct" not in response.get_json()["answers"][0]


def test_start_converges_under_a_concurrent_double_start_race(app, coach_headers):
    """A fast double-tap on a name shouldn't error - both requests should
    converge to the same attempt, not conflict."""
    with app.test_client() as setup_client:
        _, _, _, access_code = build_ready_quiz(setup_client, coach_headers)

    barrier = threading.Barrier(2)
    results = []

    def start():
        barrier.wait()
        with app.test_client() as thread_client:
            response = thread_client.post(
                "/api/play/start",
                json={"access_code_id": access_code["id"], "player_name": "Jordan Smith"},
            )
            results.append(response.status_code)

    threads = [threading.Thread(target=start) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Neither request should error - one creates (201), the other resumes (200).
    assert sorted(results) == [200, 201]


def test_autosave_persists_and_is_retrievable_on_resume(client, coach_headers):
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")

    client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": written_question["id"],
            "selected_option_id": None,
            "answer_text": "I set the edge.",
        },
    )

    resumed = start_attempt(client, access_code["id"], "Jordan Smith").get_json()
    assert resumed["answers"] == [
        {
            "question_id": written_question["id"],
            "selected_option_id": None,
            "answer_text": "I set the edge.",
            "checked": False,
            # Phase B, as above: a text answer carries no drawing.
            "drawing": None,
        }
    ]


def test_autosave_overwrites_a_previous_answer_to_the_same_question(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")
    option_ids = [o["id"] for o in tf_question["options"]]

    for option_id in option_ids:
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": access_code["id"],
                "player_name": "Jordan Smith",
                "question_id": tf_question["id"],
                "selected_option_id": option_id,
                "answer_text": None,
            },
        )

    resumed = start_attempt(client, access_code["id"], "Jordan Smith").get_json()
    assert len(resumed["answers"]) == 1
    assert resumed["answers"][0]["selected_option_id"] == option_ids[-1]


def test_autosave_rejects_a_question_that_does_not_belong_to_the_quiz(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")

    response = client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": 999999,
            "selected_option_id": None,
            "answer_text": "x",
        },
    )

    assert response.status_code == 422


def test_autosave_without_a_prior_start_is_rejected(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

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

    assert response.status_code == 404


def test_autosave_rejects_once_the_access_code_has_expired(app, client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")

    with app.app_context():
        code_row = db.session.get(AccessCode, access_code["id"])
        code_row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

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

    assert response.status_code == 404


def test_concurrent_autosaves_for_the_same_question_do_not_error(app, coach_headers):
    """A debounce timer firing alongside a fresh option click (or a browser
    retry) can race two saves for the same question - the upsert must
    resolve cleanly, not 500 on the unique constraint."""
    with app.test_client() as setup_client:
        _, tf_question, _, access_code = build_ready_quiz(setup_client, coach_headers)
        start_attempt(setup_client, access_code["id"], "Jordan Smith")

    option_ids = [o["id"] for o in tf_question["options"]]
    barrier = threading.Barrier(2)
    results = []

    def save(option_id):
        barrier.wait()
        with app.test_client() as thread_client:
            response = thread_client.post(
                "/api/play/answers",
                json={
                    "access_code_id": access_code["id"],
                    "player_name": "Jordan Smith",
                    "question_id": tf_question["id"],
                    "selected_option_id": option_id,
                    "answer_text": None,
                },
            )
            results.append(response.status_code)

    threads = [threading.Thread(target=save, args=(option_id,)) for option_id in option_ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [204, 204]

    with app.test_client() as verify_client:
        resumed = start_attempt(verify_client, access_code["id"], "Jordan Smith").get_json()
    assert len(resumed["answers"]) == 1
    assert resumed["answers"][0]["selected_option_id"] in option_ids


def test_submit_without_a_prior_start_is_rejected(client, coach_headers):
    _, tf_question, _, access_code = build_ready_quiz(client, coach_headers)

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )

    assert response.status_code == 404


def test_submit_still_locks_the_attempt_when_a_later_answer_in_the_payload_is_invalid(
    client, coach_headers
):
    """A validation failure partway through the answers list must not leave
    the transaction dangling - the whole submit is rejected cleanly and the
    attempt stays usable afterward (not stuck 'idle in transaction')."""
    _, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Jordan Smith")

    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [
                {"question_id": tf_question["id"]},
                {"question_id": 999999, "answer_text": "does not belong to this quiz"},
            ],
        },
    )
    assert response.status_code == 422

    # The session must have been rolled back cleanly - a normal submit
    # right after must still work, not hang or 500.
    retry = client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "answers": [{"question_id": tf_question["id"]}],
        },
    )
    assert retry.status_code == 201


def test_coach_can_reset_an_attempt_and_the_player_can_start_fresh(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}]
    ).get_json()
    attempt_id = submit_response["id"]

    reset_response = client.delete(
        f"/api/quizzes/{quiz['id']}/attempts/{attempt_id}", headers=coach_headers
    )
    assert reset_response.status_code == 204

    responses = client.get(f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers).get_json()
    assert responses == []

    # The unique constraint no longer blocks a fresh attempt under the same name.
    restart = start_attempt(client, access_code["id"], "Jordan Smith")
    assert restart.status_code == 201
    assert restart.get_json()["status"] == "in_progress"


def test_reset_attempt_requires_the_quizs_creator_or_an_org_admin(client, coach_headers, invite_teammate):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}]
    ).get_json()

    _, _, teammate_headers = invite_teammate(coach_headers)

    response = client.delete(
        f"/api/quizzes/{quiz['id']}/attempts/{submit_response['id']}", headers=teammate_headers
    )
    # 404 now, not 403. A teammate cannot see this quiz at all, so telling
    # them "forbidden" would confirm the id exists. Was 403 when every quiz
    # was visible org-wide and pretending otherwise would have been confusing.
    assert response.status_code == 404


def test_reset_attempt_404s_for_an_attempt_belonging_to_a_different_quiz(client, coach_headers):
    quiz_a, tf_question_a, _, access_code_a = build_ready_quiz(client, coach_headers)
    quiz_b = client.post("/api/quizzes", json={"title": "Week 2 Prep"}, headers=coach_headers).get_json()

    submit_response = start_and_submit(
        client, access_code_a["id"], "Jordan Smith", [{"question_id": tf_question_a["id"]}]
    ).get_json()

    response = client.delete(
        f"/api/quizzes/{quiz_b['id']}/attempts/{submit_response['id']}", headers=coach_headers
    )
    assert response.status_code == 404


def test_list_responses_excludes_an_in_progress_attempt(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])
    start_attempt(client, access_code["id"], "Alex Lee")

    responses = client.get(f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers).get_json()

    assert len(responses) == 1
    assert responses[0]["player_name"] == "Jordan Smith"


def test_export_csv_excludes_an_in_progress_attempt(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])
    start_attempt(client, access_code["id"], "Alex Lee")

    response = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)

    assert response.status_code == 200
    csv_text = response.get_data(as_text=True)
    assert "Jordan Smith" in csv_text
    assert "Alex Lee" not in csv_text
