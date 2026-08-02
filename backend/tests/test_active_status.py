"""GET /api/quizzes/active-status - the dashboard's live submitted/in-progress/
not-started breakdown for every currently active access code in the org."""

from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models import AccessCode
from tests.test_play_and_grading import build_ready_quiz, start_and_submit, start_attempt


def create_group_with_players(client, headers, name="Defense", players=("Jordan Smith",)):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    client.put(f"/api/groups/{group['id']}/players", json={"players": list(players)}, headers=headers)
    return group


def test_empty_when_no_quiz_is_active(client, coach_headers):
    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_json() == []


def test_reports_submitted_in_progress_and_not_started_split(client, coach_headers):
    quiz, tf_question, _, access_code = build_ready_quiz(client, coach_headers)
    # Roster is ["Jordan Smith", "Alex Lee"] - submit one, start-but-not-submit
    # neither of the others so both "in progress" and "not started" appear.
    start_and_submit(client, access_code["id"], "Jordan Smith", [{"question_id": tf_question["id"]}])

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.status_code == 200
    entries = response.get_json()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["quiz_id"] == quiz["id"]
    assert entry["quiz_title"] == "Week 1 Prep"
    assert entry["roster_size"] == 2
    assert [s["player_name"] for s in entry["submitted"]] == ["Jordan Smith"]
    assert entry["in_progress"] == []
    assert entry["not_started"] == ["Alex Lee"]


def test_distinguishes_started_but_not_submitted_from_never_started(client, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)
    start_attempt(client, access_code["id"], "Alex Lee")

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    entry = response.get_json()[0]
    assert entry["submitted"] == []
    assert [p["player_name"] for p in entry["in_progress"]] == ["Alex Lee"]
    assert entry["not_started"] == ["Jordan Smith"]


def test_reports_multiple_simultaneously_active_quizzes_separately(client, coach_headers):
    quiz_a, tf_question_a, _, access_code_a = build_ready_quiz(client, coach_headers)
    quiz_b = client.post("/api/quizzes", json={"title": "Week 2 Prep"}, headers=coach_headers).get_json()
    client.post(
        f"/api/quizzes/{quiz_b['id']}/questions",
        json={"question_text": "Q1", "question_type": "written", "options": []},
        headers=coach_headers,
    )
    client.put(
        f"/api/quizzes/{quiz_b['id']}/roster", json={"players": ["Sam Rivera"]}, headers=coach_headers
    )
    access_code_b = client.post(
        f"/api/quizzes/{quiz_b['id']}/access-codes", headers=coach_headers
    ).get_json()

    start_and_submit(client, access_code_a["id"], "Jordan Smith", [{"question_id": tf_question_a["id"]}])
    start_attempt(client, access_code_b["id"], "Sam Rivera")

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.status_code == 200
    entries = {e["quiz_id"]: e for e in response.get_json()}
    assert len(entries) == 2
    assert [s["player_name"] for s in entries[quiz_a["id"]]["submitted"]] == ["Jordan Smith"]
    assert [p["player_name"] for p in entries[quiz_b["id"]]["in_progress"]] == ["Sam Rivera"]


def test_group_scoped_activation_reports_only_that_groups_roster(client, coach_headers):
    quiz, _, _, _ = build_ready_quiz(client, coach_headers)
    group = create_group_with_players(client, coach_headers, players=("Casey Jones",))
    access_code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=coach_headers,
    ).get_json()

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    entry = response.get_json()[0]
    # Not the quiz's own roster (Jordan Smith/Alex Lee) - the linked group's.
    assert entry["group_names"] == ["Defense"]
    assert entry["roster_size"] == 1
    assert entry["not_started"] == ["Casey Jones"]


def test_group_names_are_empty_for_a_whole_roster_activation(client, coach_headers):
    build_ready_quiz(client, coach_headers)

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.get_json()[0]["group_names"] == []


def test_group_names_sorted_alphabetically_for_multiple_linked_groups(client, coach_headers):
    quiz, _, _, _ = build_ready_quiz(client, coach_headers)
    group_b = create_group_with_players(client, coach_headers, name="Special Teams", players=("A",))
    group_a = create_group_with_players(client, coach_headers, name="Defense", players=("B",))
    client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group_b["id"], group_a["id"]]},
        headers=coach_headers,
    )

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.get_json()[0]["group_names"] == ["Defense", "Special Teams"]


def test_excludes_a_quiz_whose_only_access_code_has_expired(client, app, coach_headers):
    _, _, _, access_code = build_ready_quiz(client, coach_headers)

    with app.app_context():
        code_row = db.session.get(AccessCode, access_code["id"])
        code_row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

    response = client.get("/api/quizzes/active-status", headers=coach_headers)

    assert response.get_json() == []


def test_a_teammates_active_quiz_appears_but_a_different_orgs_does_not(
    client, coach_headers, invite_teammate, register_coach
):
    build_ready_quiz(client, coach_headers)
    _, _, teammate_headers = invite_teammate(coach_headers)

    outsider_coach, _, outsider_headers = register_coach(
        username="outsider", email="outsider@example.com", organization="Rival Org"
    )
    build_ready_quiz(client, outsider_headers)

    teammate_view = client.get("/api/quizzes/active-status", headers=teammate_headers).get_json()
    assert len(teammate_view) == 1

    outsider_view = client.get("/api/quizzes/active-status", headers=outsider_headers).get_json()
    assert len(outsider_view) == 1
    assert outsider_view[0]["quiz_title"] == "Week 1 Prep"
    # Confirms org-scoping, not a global list - the teammate's org only sees its own quiz.
    assert teammate_view[0]["quiz_id"] != outsider_view[0]["quiz_id"]
