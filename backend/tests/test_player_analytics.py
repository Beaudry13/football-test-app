"""Player Progress Analytics: shared scoring/analytics service and the
routes built on it (GET /players/<id>/history, GET /players/progress).
"""

import pytest

from app.services.player_analytics import (
    MIN_COMPARISON_SAMPLE_PLAYERS,
    REVIEW_THRESHOLD_PERCENT,
    compute_org_roster,
)


# --- helpers --------------------------------------------------------------


def create_tf_quiz(client, headers, title="Quiz", question_text="Is this correct?"):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": question_text,
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    ).get_json()
    return quiz, question


def create_written_quiz(client, headers, title="Written Quiz"):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Explain your assignment.", "question_type": "written", "options": []},
        headers=headers,
    ).get_json()
    return quiz, question


def make_player(client, headers, first, last, jersey=None, position=None):
    response = client.post(
        "/api/players",
        json={"first_name": first, "last_name": last, "jersey_number": jersey, "position": position},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def add_to_roster(client, headers, quiz_id, player_ids):
    """Adds canonical Players directly to a quiz's Roster - a quiz can't be
    activated without an eligible roster/Group (see activate())."""
    response = client.post(
        f"/api/quizzes/{quiz_id}/roster/members",
        json={"player_ids": player_ids},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def activate(client, headers, quiz_id, group_ids=None, player_ids=None):
    """Activates a quiz. Group-based activation (group_ids) works as-is;
    otherwise the given Players are added straight to the quiz's own direct
    Roster first, since POST .../access-codes 422s for a quiz with neither a
    roster nor a group selected."""
    if group_ids:
        body = {"group_ids": group_ids}
    else:
        add_to_roster(client, headers, quiz_id, player_ids or [])
        body = {}
    response = client.post(f"/api/quizzes/{quiz_id}/access-codes", json=body, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def submit(client, access_code, question, player_name, player_id, correct=True, answer_text=None):
    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": player_name, "player_id": player_id},
    )
    if question["question_type"] == "written":
        answer = {"question_id": question["id"], "selected_option_id": None, "answer_text": answer_text or "An answer."}
    else:
        option_id = question["options"][0 if correct else 1]["id"]
        answer = {"question_id": question["id"], "selected_option_id": option_id, "answer_text": None}
    return client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": player_name,
            "player_id": player_id,
            "answers": [answer],
        },
    )


def start_only(client, access_code, player_name, player_id):
    return client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": player_name, "player_id": player_id},
    )


# --- PLAYER SUMMARY ---------------------------------------------------------


def test_summary_counts_assigned_completed_and_completion_percent(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[player["id"]])

    submit(client, code1, q1, "Jordan Lee", player["id"], correct=True)
    # Only starts quiz2 - never submits, so it's assigned but not completed.
    start_only(client, code2, "Jordan Lee", player["id"])

    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    summary = history["summary"]
    assert summary["assigned_count"] == 2
    assert summary["completed_count"] == 1
    assert summary["completion_percent"] == 50.0


def test_summary_average_score_percent(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[player["id"]])

    submit(client, code1, q1, "Jordan Lee", player["id"], correct=True)
    submit(client, code2, q2, "Jordan Lee", player["id"], correct=False)

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["average_score_percent"] == 50.0


def test_summary_last_activity_and_below_threshold_count(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    result = submit(client, code1, q1, "Jordan Lee", player["id"], correct=False)
    submitted_at = result.get_json()["submitted_at"]

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["last_completed_at"] == submitted_at
    assert summary["below_threshold_count"] == 1
    assert summary["review_threshold_percent"] == REVIEW_THRESHOLD_PERCENT


def test_summary_zero_data_state_has_no_divide_by_zero(client, coach_headers):
    player = make_player(client, coach_headers, "New", "Player")
    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    summary = history["summary"]
    assert summary["assigned_count"] == 0
    assert summary["completed_count"] == 0
    assert summary["completion_percent"] is None
    assert summary["average_score_percent"] is None
    assert summary["last_completed_at"] is None
    assert history["history"] == []
    assert history["trend"] == {"available": False, "direction": None, "points": []}


def test_summary_preserved_for_inactive_player(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["completed_count"] == 1
    assert summary["average_score_percent"] == 100.0


# --- UNIFIED HISTORY ---------------------------------------------------


def test_unified_history_combines_direct_roster_and_group_activations(client, coach_headers):
    """A Player's history must be one unified timeline regardless of
    whether a given quiz reached them via the quiz's own direct Roster or
    via Group membership - the coach shouldn't have to check two places."""
    player = make_player(client, coach_headers, "Jordan", "Lee")
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)

    direct_quiz, dq = create_tf_quiz(client, coach_headers, "Direct Roster Quiz")
    direct_code = activate(client, coach_headers, direct_quiz["id"], player_ids=[player["id"]])
    submit(client, direct_code, dq, "Jordan Lee", player["id"], correct=True)

    group_quiz, gq = create_tf_quiz(client, coach_headers, "Group Quiz")
    group_code = activate(client, coach_headers, group_quiz["id"], group_ids=[group["id"]])
    submit(client, group_code, gq, "Jordan Lee", player["id"], correct=True)

    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    assert history["summary"]["assigned_count"] == 2
    assert history["summary"]["completed_count"] == 2
    titles = {row["quiz_title"] for row in history["history"]}
    assert titles == {"Direct Roster Quiz", "Group Quiz"}


def test_unified_history_survives_removal_from_group(client, coach_headers):
    """Removing a Player from a Group must not erase what they already did
    while a member of it - only the assigned_count definition (see the
    services/player_analytics.py module docstring) depends on the
    attempt existing, never on current Group membership."""
    player = make_player(client, coach_headers, "Jordan", "Lee")
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)

    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], group_ids=[group["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    client.delete(f"/api/groups/{group['id']}/members/{player['id']}", headers=coach_headers)

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["completed_count"] == 1
    assert summary["average_score_percent"] == 100.0


def test_unified_history_survives_a_rename(client, coach_headers):
    """Renaming a Player (a name-string edit only, same canonical id) must
    keep every prior attempt attached - history is keyed on player_id, not
    on whatever name string was captured at attempt time."""
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    client.patch(
        f"/api/players/{player['id']}",
        json={"first_name": "Jordan", "last_name": "Lee-Martinez", "jersey_number": None, "position": None},
        headers=coach_headers,
    )

    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    assert history["summary"]["completed_count"] == 1
    assert history["summary"]["average_score_percent"] == 100.0
    assert len(history["history"]) == 1


def test_unified_history_keeps_same_name_players_separate(client, coach_headers):
    """Two distinct canonical Players who happen to share a display name
    must never have their histories merged or cross-counted."""
    chris_a = make_player(client, coach_headers, "Chris", "Smith", jersey="2")
    chris_b = make_player(client, coach_headers, "Chris", "Smith", jersey="42")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[chris_a["id"], chris_b["id"]])
    submit(client, code, q, "Chris Smith", chris_a["id"], correct=True)
    submit(client, code, q, "Chris Smith", chris_b["id"], correct=False)

    history_a = client.get(f"/api/players/{chris_a['id']}/history", headers=coach_headers).get_json()
    history_b = client.get(f"/api/players/{chris_b['id']}/history", headers=coach_headers).get_json()
    assert history_a["summary"]["average_score_percent"] == 100.0
    assert history_b["summary"]["average_score_percent"] == 0.0
    assert len(history_a["history"]) == 1
    assert len(history_b["history"]) == 1


# --- SCORING -----------------------------------------------------------


def test_in_progress_attempt_not_counted_as_completed(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    start_only(client, code, "Jordan Lee", player["id"])

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["assigned_count"] == 1
    assert summary["completed_count"] == 0
    assert summary["average_score_percent"] is None


def test_pending_written_grading_not_counted_as_incorrect(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_written_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"])

    history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()
    summary = history["summary"]
    # Nothing graded yet -> average is None, not 0%, and the attempt shows
    # as pending grading, not a review-threshold failure.
    assert summary["average_score_percent"] is None
    assert summary["below_threshold_count"] == 0
    assert summary["pending_grading_count"] == 1
    row = history["history"][0]
    assert row["review_status"] == "pending_grading"
    assert row["score_percent"] is None


def test_grading_a_written_answer_updates_the_average(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_written_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit_response = submit(client, code, q, "Jordan Lee", player["id"])
    answer_id = submit_response.get_json()["answers"][0]["id"]

    client.patch(f"/api/answers/{answer_id}/grade", json={"is_correct": True}, headers=coach_headers)

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["average_score_percent"] == 100.0
    assert summary["pending_grading_count"] == 0


def test_reset_attempt_excluded_from_analytics(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit_response = submit(client, code, q, "Jordan Lee", player["id"], correct=False)
    attempt_id = submit_response.get_json()["id"]

    client.delete(f"/api/quizzes/{quiz['id']}/attempts/{attempt_id}", headers=coach_headers)

    summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    assert summary["assigned_count"] == 0
    assert summary["completed_count"] == 0
    assert summary["average_score_percent"] is None


def test_same_fixture_scores_agree_across_surfaces(client, coach_headers):
    """The core of the audit: Player Profile, the quiz dashboard, and the
    quiz-card list must never disagree about the same quiz's average."""
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    player_summary = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["summary"]
    dashboard = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers).get_json()
    quiz_list = client.get("/api/quizzes", headers=coach_headers).get_json()
    quiz_card = next(qz for qz in quiz_list if qz["id"] == quiz["id"])

    breakdown = dashboard["question_breakdown"][0]
    dashboard_score = round(100 * breakdown["correct_count"] / breakdown["answered_count"], 1)

    assert player_summary["average_score_percent"] == 100.0
    assert dashboard_score == 100.0
    assert quiz_card["average_score_percent"] == 100.0


# --- TREND ---------------------------------------------------------------


def test_trend_insufficient_data_with_fewer_than_two_results(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    trend = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["trend"]
    assert trend["available"] is False
    assert trend["direction"] is None


def test_trend_chronological_ordering(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quizzes = [create_tf_quiz(client, coach_headers, f"Quiz {i}") for i in range(3)]
    for quiz, q in quizzes:
        code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
        submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    trend = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["trend"]
    dates = [p["date"] for p in trend["points"]]
    assert dates == sorted(dates)


def test_trend_improving(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    submit(client, code1, q1, "Jordan Lee", player["id"], correct=False)
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[player["id"]])
    submit(client, code2, q2, "Jordan Lee", player["id"], correct=True)

    trend = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["trend"]
    assert trend["available"] is True
    assert trend["direction"] == "improving"


def test_trend_declining(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    submit(client, code1, q1, "Jordan Lee", player["id"], correct=True)
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[player["id"]])
    submit(client, code2, q2, "Jordan Lee", player["id"], correct=False)

    trend = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["trend"]
    assert trend["direction"] == "declining"


def test_trend_flat(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz1, q1 = create_tf_quiz(client, coach_headers, "Quiz 1")
    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code1 = activate(client, coach_headers, quiz1["id"], player_ids=[player["id"]])
    submit(client, code1, q1, "Jordan Lee", player["id"], correct=True)
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[player["id"]])
    submit(client, code2, q2, "Jordan Lee", player["id"], correct=True)

    trend = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["trend"]
    assert trend["direction"] == "flat"


# --- MISSED QUESTIONS ------------------------------------------------------


def test_missed_questions_shows_incorrect_multiple_choice(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers, "Quiz 1", "Is this a blitz?")
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=False)

    missed = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    assert len(missed) == 1
    assert missed[0]["question_id"] == q["id"]
    assert missed[0]["quiz_title"] == "Quiz 1"
    assert "blitz" in missed[0]["question_preview"]


def test_missed_questions_excludes_correct_answers(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    missed = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    assert missed == []


def test_missed_questions_excludes_pending_written_answers(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_written_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"])

    missed = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    assert missed == []


def test_missed_questions_counts_exact_repeat_misses(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    # Miss the exact same question on two separate activations of the same quiz.
    code1 = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code1, q, "Jordan Lee", player["id"], correct=False)
    code2 = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code2, q, "Jordan Lee", player["id"], correct=False)

    missed = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    assert len(missed) == 1
    assert missed[0]["miss_count"] == 2


def test_missed_questions_never_mix_across_players(client, coach_headers):
    player_a = make_player(client, coach_headers, "Alex", "Rivera")
    player_b = make_player(client, coach_headers, "Blake", "Diaz")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player_a["id"]])
    submit(client, code, q, "Alex Rivera", player_a["id"], correct=False)

    missed_a = client.get(f"/api/players/{player_a['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    missed_b = client.get(f"/api/players/{player_b['id']}/history", headers=coach_headers).get_json()["missed_questions"]
    assert len(missed_a) == 1
    assert missed_b == []


# --- COMPARISONS -----------------------------------------------------------


def test_comparisons_group_average(client, coach_headers):
    p1 = make_player(client, coach_headers, "Jordan", "Lee")
    p2 = make_player(client, coach_headers, "Sam", "Rivera")
    p3 = make_player(client, coach_headers, "Alex", "Diaz")
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [p1["id"], p2["id"], p3["id"]]},
        headers=coach_headers,
    )
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], group_ids=[group["id"]])
    submit(client, code, q, "Jordan Lee", p1["id"], correct=True)
    submit(client, code, q, "Sam Rivera", p2["id"], correct=False)
    submit(client, code, q, "Alex Diaz", p3["id"], correct=True)

    comparisons = client.get(f"/api/players/{p1['id']}/history", headers=coach_headers).get_json()["comparisons"]
    group_stats = next(g for g in comparisons["groups"] if g["group_id"] == group["id"])
    assert group_stats["average_score_percent"] == pytest.approx(66.7, abs=0.1)
    assert group_stats["player_count"] == 3
    assert group_stats["sufficient_data"] is True


def test_comparisons_position_average(client, coach_headers):
    p1 = make_player(client, coach_headers, "Jordan", "Lee", position="WR")
    p2 = make_player(client, coach_headers, "Sam", "Rivera", position="WR")
    p3 = make_player(client, coach_headers, "Alex", "Diaz", position="WR")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[p1["id"], p2["id"], p3["id"]])
    submit(client, code, q, "Jordan Lee", p1["id"], correct=True)
    submit(client, code, q, "Sam Rivera", p2["id"], correct=True)
    submit(client, code, q, "Alex Diaz", p3["id"], correct=False)

    comparisons = client.get(f"/api/players/{p1['id']}/history", headers=coach_headers).get_json()["comparisons"]
    assert comparisons["position"]["position"] == "WR"
    assert comparisons["position"]["average_score_percent"] == pytest.approx(66.7, abs=0.1)


def test_comparisons_organization_average_and_sample_size(client, coach_headers):
    players = [make_player(client, coach_headers, f"P{i}", "Lee") for i in range(3)]
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[p["id"] for p in players])
    for p in players:
        submit(client, code, q, f"{p['first_name']} Lee", p["id"], correct=True)

    comparisons = client.get(f"/api/players/{players[0]['id']}/history", headers=coach_headers).get_json()["comparisons"]
    assert comparisons["organization"]["average_score_percent"] == 100.0
    assert comparisons["organization"]["player_count"] == 3
    assert comparisons["organization"]["sufficient_data"] is True


def test_comparisons_insufficient_sample_size_flagged(client, coach_headers):
    assert MIN_COMPARISON_SAMPLE_PLAYERS > 1
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=True)

    comparisons = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["comparisons"]
    assert comparisons["organization"]["player_count"] == 1
    assert comparisons["organization"]["sufficient_data"] is False


def test_comparisons_shows_each_group_separately_for_a_multi_group_player(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    group_a = client.post("/api/groups", json={"name": "Offense"}, headers=coach_headers).get_json()
    group_b = client.post("/api/groups", json={"name": "Special Teams"}, headers=coach_headers).get_json()
    for group in (group_a, group_b):
        client.post(
            f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers
        )

    comparisons = client.get(f"/api/players/{player['id']}/history", headers=coach_headers).get_json()["comparisons"]
    group_ids = {g["group_id"] for g in comparisons["groups"]}
    assert group_ids == {group_a["id"], group_b["id"]}


def test_comparisons_do_not_average_averages(client, coach_headers):
    """A Player with 1 attempt and a Player with 3 attempts must not count
    equally - the org average is weighted by graded answers, not by
    treating each Player's own percentage as one equally-weighted vote."""
    p1 = make_player(client, coach_headers, "Jordan", "Lee")
    p2 = make_player(client, coach_headers, "Sam", "Rivera")
    quiz, q = create_tf_quiz(client, coach_headers)

    code = activate(client, coach_headers, quiz["id"], player_ids=[p1["id"]])
    submit(client, code, q, "Jordan Lee", p1["id"], correct=True)

    quiz2, q2 = create_tf_quiz(client, coach_headers, "Quiz 2")
    code2 = activate(client, coach_headers, quiz2["id"], player_ids=[p2["id"]])
    submit(client, code2, q2, "Sam Rivera", p2["id"], correct=False)
    quiz3, q3 = create_tf_quiz(client, coach_headers, "Quiz 3")
    code3 = activate(client, coach_headers, quiz3["id"], player_ids=[p2["id"]])
    submit(client, code3, q3, "Sam Rivera", p2["id"], correct=False)
    quiz4, q4 = create_tf_quiz(client, coach_headers, "Quiz 4")
    code4 = activate(client, coach_headers, quiz4["id"], player_ids=[p2["id"]])
    submit(client, code4, q4, "Sam Rivera", p2["id"], correct=False)

    comparisons = client.get(f"/api/players/{p1['id']}/history", headers=coach_headers).get_json()["comparisons"]
    # Naive average-of-averages would be (100 + 0) / 2 = 50%. The correct,
    # answer-weighted average is 1 correct out of 4 graded = 25%.
    assert comparisons["organization"]["average_score_percent"] == 25.0


# --- ORGANIZATION PAGE -------------------------------------------------


def test_org_progress_summary_and_rows(client, coach_headers):
    p1 = make_player(client, coach_headers, "Jordan", "Lee")
    p2 = make_player(client, coach_headers, "Sam", "Rivera")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[p1["id"], p2["id"]])
    submit(client, code, q, "Jordan Lee", p1["id"], correct=True)
    start_only(client, code, "Sam Rivera", p2["id"])  # incomplete

    progress = client.get("/api/players/progress", headers=coach_headers).get_json()
    assert progress["summary"]["total_active_players"] == 2
    assert progress["summary"]["players_with_incomplete_assignments"] == 1
    assert progress["summary"]["completion_rate"] == 50.0

    row_jordan = next(r for r in progress["players"] if r["player"]["id"] == p1["id"])
    assert row_jordan["completed_count"] == 1
    assert row_jordan["average_score_percent"] == 100.0
    assert row_jordan["needs_review"] is False


def test_org_progress_needs_review_flag(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    quiz, q = create_tf_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], player_ids=[player["id"]])
    submit(client, code, q, "Jordan Lee", player["id"], correct=False)

    progress = client.get("/api/players/progress", headers=coach_headers).get_json()
    row = next(r for r in progress["players"] if r["player"]["id"] == player["id"])
    assert row["needs_review"] is True
    assert progress["summary"]["players_below_threshold"] == 1


def test_org_progress_excludes_inactive_by_default(client, coach_headers):
    player = make_player(client, coach_headers, "Jordan", "Lee")
    client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)

    progress = client.get("/api/players/progress", headers=coach_headers).get_json()
    assert progress["players"] == []

    progress_all = client.get("/api/players/progress?active=all", headers=coach_headers).get_json()
    assert len(progress_all["players"]) == 1


def test_org_progress_is_organization_scoped(client, coach_headers, register_coach):
    make_player(client, coach_headers, "Mine", "Player")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    progress = client.get("/api/players/progress", headers=other_headers).get_json()
    assert progress["players"] == []


def test_org_progress_no_players_yet(client, coach_headers):
    progress = client.get("/api/players/progress", headers=coach_headers).get_json()
    assert progress["players"] == []
    assert progress["summary"]["total_active_players"] == 0
    assert progress["summary"]["completion_rate"] is None


def test_org_progress_requires_auth(client):
    assert client.get("/api/players/progress").status_code == 401


def test_history_requires_auth(client):
    assert client.get("/api/players/1/history").status_code == 401


# --- PERFORMANCE (batched, no N+1) -----------------------------------------


def test_org_roster_query_count_does_not_scale_with_player_count(app, client, coach_headers):
    """compute_org_roster should issue a small, constant number of queries
    regardless of how many Players/attempts exist - not one query per
    Player. Verified by comparing query counts for a small vs a larger
    fixture; a real N+1 would grow roughly linearly with Player count."""
    from sqlalchemy import event

    from app.extensions import db as _db

    organization_id = client.get("/api/auth/me", headers=coach_headers).get_json()["organization_id"]

    def _seed(n: int):
        players = [make_player(client, coach_headers, f"P{i}", "Test") for i in range(n)]
        quiz, q = create_tf_quiz(client, coach_headers, f"Quiz for {n}")
        code = activate(client, coach_headers, quiz["id"], player_ids=[p["id"] for p in players])
        for p in players:
            submit(client, code, q, f"{p['first_name']} Test", p["id"], correct=True)

    def _count_queries(fn):
        queries = []

        def _listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        event.listen(_db.engine, "before_cursor_execute", _listener)
        try:
            with app.app_context():
                fn()
        finally:
            event.remove(_db.engine, "before_cursor_execute", _listener)
        return len(queries)

    _seed(3)
    small_count = _count_queries(lambda: compute_org_roster(organization_id))

    _seed(15)
    large_count = _count_queries(lambda: compute_org_roster(organization_id))

    # Allow some slack, but a real N+1 over 15 extra Players would add
    # dozens of extra queries, not a handful.
    assert large_count <= small_count + 3
