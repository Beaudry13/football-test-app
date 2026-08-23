"""Quiz CRUD, duplication, and coach data scoping."""

from pathlib import Path

from flask import current_app

from tests.conftest import make_image_file
from tests.test_play_and_grading import (
    _activate_with_group,
    build_ready_quiz,
    start_and_submit,
    start_attempt,
)


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


def test_list_quizzes_reports_no_score_stat_before_anyone_has_been_graded(client, coach_headers):
    """A brand-new quiz shouldn't show a misleading "0% avg. score" before
    anyone's answered anything gradeable - the field is omitted entirely,
    not sent as 0."""
    quiz = create_quiz(client, coach_headers, title="Fresh Quiz")
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith", "Alex Lee"]}, headers=coach_headers)

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 0
    assert listed["roster_size"] == 2
    assert "average_score_percent" not in listed


def test_list_quizzes_reports_completed_count_and_average_score(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)

    # Jordan gets it right, Alex gets it wrong - 1 of 2 graded answers correct.
    start_and_submit(
        client, access_code["id"], "Jordan Smith",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )
    wrong_option = next(o for o in tf_question["options"] if o["id"] != correct_option["id"])
    start_and_submit(
        client, access_code["id"], "Alex Lee",
        [{"question_id": tf_question["id"], "selected_option_id": wrong_option["id"]}],
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 2
    assert listed["average_score_percent"] == 50.0


def test_list_quizzes_score_stat_ignores_in_progress_attempts(client, coach_headers):
    """Only SUBMITTED attempts count toward completed_count/average_score -
    a player who's merely started (or autosaved an answer without
    submitting) shouldn't move either number."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)

    start_attempt(client, access_code["id"], "Jordan Smith")
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": tf_question["id"],
            "selected_option_id": correct_option["id"],
        },
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 0
    assert "average_score_percent" not in listed


def test_list_quizzes_roster_size_for_direct_roster_quiz_with_submissions(client, coach_headers):
    """Baseline: a quiz activated against its own Roster (no linked groups)
    reports that roster's size - unaffected by the group-aware roster-size
    fix below, which only changes behavior when groups are involved."""
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)  # roster: 2 players
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Jordan Smith",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["roster_size"] == 2
    assert listed["completed_count"] == 1


def test_list_quizzes_roster_size_for_group_activated_quiz_with_submissions(client, coach_headers):
    """A quiz activated against a group (not its own Roster) must report the
    group's member count, not the quiz's own (here, unrelated) direct
    roster - this is the bug this fix addresses."""
    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)  # quiz's own roster: 2 players
    access_code = _activate_with_group(
        client, coach_headers, quiz, ["Sam Rivera", "Casey Jones", "Riley Park"]
    )
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["roster_size"] == 3
    assert listed["completed_count"] == 1


def test_list_quizzes_roster_size_for_group_activated_quiz_with_zero_submissions(client, coach_headers):
    quiz, _, _, _ = build_ready_quiz(client, coach_headers)
    _activate_with_group(client, coach_headers, quiz, ["Sam Rivera", "Casey Jones"])

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["roster_size"] == 2
    assert listed["completed_count"] == 0
    assert "average_score_percent" not in listed


def test_list_quizzes_group_membership_can_exceed_completed_count(client, coach_headers):
    """A partially-completed group activation must show a roster size
    larger than its completed count - the exact "more completed than
    roster" shape (previously "1/0") the bug produced."""
    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(
        client, coach_headers, quiz, ["Sam Rivera", "Casey Jones", "Riley Park"]
    )
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 1
    assert listed["roster_size"] == 3


def test_list_quizzes_completed_count_excludes_reset_and_in_progress_attempts_for_group_activation(
    client, coach_headers
):
    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(client, coach_headers, quiz, ["Sam Rivera", "Casey Jones"])
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)

    # Casey only starts (never submits) - must not count.
    start_attempt(client, access_code["id"], "Casey Jones")

    # Sam submits, then the coach resets it - must not count either.
    submitted = start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    ).get_json()
    client.delete(f"/api/quizzes/{quiz['id']}/attempts/{submitted['id']}", headers=coach_headers)

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 0
    assert listed["roster_size"] == 2


def test_list_quizzes_duplicate_submission_is_not_double_counted(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    answers = [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}]

    first = start_and_submit(client, access_code["id"], "Jordan Smith", answers)
    assert first.status_code == 201
    second = client.post(
        "/api/play/submit",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Smith", "answers": answers},
    )
    assert second.status_code == 409

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert listed["completed_count"] == 1


def test_quiz_card_analytics_and_dashboard_agree_on_roster_size_for_group_activated_quiz(
    client, coach_headers
):
    """The dashboard's quiz-card list and the Results tab's own dashboard
    endpoint must report the same roster size for the same group-activated
    quiz - the exact cross-check this fix is meant to guarantee."""
    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(
        client, coach_headers, quiz, ["Sam Rivera", "Casey Jones", "Riley Park"]
    )
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    listed = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    dashboard = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers).get_json()

    assert listed["roster_size"] == dashboard["roster_size"] == 3
    assert listed["completed_count"] == dashboard["response_count"] == 1


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


def test_roster_size_goes_to_zero_once_a_group_activation_expires(client, coach_headers):
    """THE 'N of 0' DASHBOARD STATE, reproduced.

    roster_size answers "who is eligible RIGHT NOW" - list_quizzes only looks
    up codes that are still active, and effective_roster_names_for_quiz falls
    back to the quiz's own Roster when there is none. completed_count answers
    "how many ever submitted". Those are not two halves of a fraction.

    A coach who activates against a GROUP never has to build a per-quiz Roster
    (groups are linked to the access code, not the quiz), so once that code
    lapses the fallback finds nothing and the denominator becomes 0 while the
    submissions remain. This pins the backend behaviour that the frontend's
    responseSummary() has to render truthfully; it is NOT a bug in this number,
    which is correct for what it means.
    """
    from datetime import datetime, timedelta, timezone

    from app import db
    from app.models.access_code import AccessCode

    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(
        client, coach_headers, quiz, ["Sam Rivera", "Casey Jones", "Riley Park"]
    )
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    live = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert live["completed_count"] == 1
    assert live["roster_size"] == 3

    # Drop the quiz's own roster so the fallback has nothing to find, then let
    # the code lapse - which is simply what time does to every activation.
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": []}, headers=coach_headers)
    row = db.session.get(AccessCode, access_code["id"])
    row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    db.session.commit()

    after = next(q for q in client.get("/api/quizzes", headers=coach_headers).get_json() if q["id"] == quiz["id"])
    assert after["completed_count"] == 1
    assert after["roster_size"] == 0


def test_dashboard_response_rate_is_none_rather_than_a_fabricated_zero(client, coach_headers):
    """A quiz players actually completed must never report a 0% response rate.

    Same expiry as the test above, seen from the Results tab: dividing an
    all-time numerator by a right-now denominator of zero used to yield 0.0,
    which the tab rendered as "0%" and the PDF printed as "Response Rate 0%".
    None is the same answer scoring already gives when nothing is gradeable.
    """
    from datetime import datetime, timedelta, timezone

    from app import db
    from app.models.access_code import AccessCode

    quiz, tf_question, _, _ = build_ready_quiz(client, coach_headers)
    access_code = _activate_with_group(client, coach_headers, quiz, ["Sam Rivera", "Casey Jones"])
    correct_option = next(o for o in tf_question["options"] if o["is_correct_answer"] is not False)
    start_and_submit(
        client, access_code["id"], "Sam Rivera",
        [{"question_id": tf_question["id"], "selected_option_id": correct_option["id"]}],
    )

    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": []}, headers=coach_headers)
    row = db.session.get(AccessCode, access_code["id"])
    row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    db.session.commit()

    body = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers).get_json()
    assert body["response_count"] == 1
    assert body["roster_size"] == 0
    assert body["response_rate"] is None, "0.0 here reads as '0% of players responded'"
