"""CSV and PDF results export for a quiz."""

import csv
import io

from tests.test_play_and_grading import build_ready_quiz


def _submit(client, access_code, tf_question, written_question, correct_option_id, player_name):
    return client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": player_name,
            "answers": [
                {"question_id": tf_question["id"], "selected_option_id": correct_option_id},
                {"question_id": written_question["id"], "answer_text": "I set the edge."},
            ],
        },
    )


def _correct_option_id(client, coach_headers, tf_question):
    options = client.get(f"/api/quizzes/{tf_question['quiz_id']}", headers=coach_headers).get_json()["questions"][0][
        "options"
    ]
    return next(o["id"] for o in options if o["is_correct_answer"])


def test_export_csv_has_one_row_per_player_per_question(client, coach_headers):
    quiz, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    correct_option_id = _correct_option_id(client, coach_headers, tf_question)
    _submit(client, access_code, tf_question, written_question, correct_option_id, "Jordan Smith")

    response = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)

    assert response.status_code == 200
    assert response.content_type.startswith("text/csv")
    assert 'filename="week-1-prep-results.csv"' in response.headers["Content-Disposition"]

    rows = list(csv.reader(io.StringIO(response.get_data(as_text=True))))
    assert rows[0] == ["Player", "Submitted At", "Question #", "Question", "Type", "Answer", "Correct", "Coach Feedback"]
    data_rows = rows[1:]
    assert len(data_rows) == 2  # one response x two questions
    by_question_text = {row[3]: row for row in data_rows}
    assert by_question_text["Is this cover 2?"][5] == "True"
    assert by_question_text["Is this cover 2?"][6] == "Yes"
    assert by_question_text["Describe your assignment."][5] == "I set the edge."
    assert by_question_text["Describe your assignment."][6] == "Ungraded"


def test_export_csv_with_no_responses_is_just_the_header(client, coach_headers):
    quiz, *_ = build_ready_quiz(client, coach_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)

    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.get_data(as_text=True))))
    assert len(rows) == 1


def test_export_pdf_returns_a_real_pdf(client, coach_headers):
    quiz, tf_question, written_question, access_code = build_ready_quiz(client, coach_headers)
    correct_option_id = _correct_option_id(client, coach_headers, tf_question)
    _submit(client, access_code, tf_question, written_question, correct_option_id, "Jordan Smith")

    response = client.get(f"/api/quizzes/{quiz['id']}/export.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert response.content_type == "application/pdf"
    assert 'filename="week-1-prep-results.pdf"' in response.headers["Content-Disposition"]
    assert response.get_data()[:5] == b"%PDF-"


def test_export_pdf_with_no_responses_still_renders(client, coach_headers):
    quiz, *_ = build_ready_quiz(client, coach_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}/export.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_data()[:5] == b"%PDF-"


def test_export_endpoints_404_for_another_coachs_quiz(client, register_coach):
    _, _, coach_a_headers = register_coach(username="coachA", email="a@example.com")
    _, _, coach_b_headers = register_coach(username="coachB", email="b@example.com")
    quiz, *_ = build_ready_quiz(client, coach_a_headers)

    csv_response = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_b_headers)
    pdf_response = client.get(f"/api/quizzes/{quiz['id']}/export.pdf", headers=coach_b_headers)

    assert csv_response.status_code == 404
    assert pdf_response.status_code == 404
