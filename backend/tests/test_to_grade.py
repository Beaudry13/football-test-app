"""WHAT IS WAITING ON THE COACH: GET /api/quizzes/to-grade.

Home says "7 to grade" and opens the grading screen; this pins that the
number offered is the work the grading screen gives:

1. Only answers a coach decides (written, drawn) that are still undecided,
   from submitted official attempts - an auto-graded answer never counts.
2. A question the coach excluded ("don't count") is out.
3. Grading an answer takes it off; a quiz with nothing left disappears.
4. Own-only, like every quiz list; another organization sees nothing.
"""

from tests.test_play_and_grading import build_ready_quiz, start_and_submit, stored_answer_id
from tests.test_question_exclusions import exclude

URL = "/api/quizzes/to-grade"


def _submit_both(client, quiz, written, code):
    attempts = []
    for name, text in (("Jordan Smith", "I set the edge."), ("Alex Lee", "Force.")):
        response = start_and_submit(client, code["id"], name, [{"question_id": written["id"], "answer_text": text}])
        assert response.status_code == 201, response.get_json()
        attempts.append(response.get_json()["attempt_id"])
    return attempts


class TestToGrade:
    def test_counts_the_answers_only_a_coach_can_decide(self, client, coach_headers):
        quiz, _tf, written, code = build_ready_quiz(client, coach_headers)
        _submit_both(client, quiz, written, code)
        assert client.get(URL, headers=coach_headers).get_json() == [
            {"quiz_id": quiz["id"], "title": "Week 1 Prep", "count": 2}
        ]

    def test_grading_takes_them_off_and_a_finished_quiz_disappears(self, client, coach_headers, app):
        quiz, _tf, written, code = build_ready_quiz(client, coach_headers)
        attempts = _submit_both(client, quiz, written, code)
        with app.app_context():
            ids = [stored_answer_id(a, written["id"]) for a in attempts]
        client.patch(f"/api/answers/{ids[0]}/grade", json={"is_correct": True}, headers=coach_headers)
        assert client.get(URL, headers=coach_headers).get_json()[0]["count"] == 1
        client.patch(f"/api/answers/{ids[1]}/grade", json={"is_correct": False}, headers=coach_headers)
        assert client.get(URL, headers=coach_headers).get_json() == []

    def test_an_excluded_question_is_not_waiting(self, client, coach_headers):
        quiz, _tf, written, code = build_ready_quiz(client, coach_headers)
        _submit_both(client, quiz, written, code)
        response = exclude(client, coach_headers, quiz["id"], written["id"], None, reason="Bad wording")
        assert response.status_code in (200, 201), response.get_json()
        assert client.get(URL, headers=coach_headers).get_json() == []

    def test_nothing_submitted_nothing_waiting(self, client, coach_headers):
        build_ready_quiz(client, coach_headers)
        assert client.get(URL, headers=coach_headers).get_json() == []

    def test_own_only_and_nothing_across_organizations(self, client, register_coach, invite_teammate):
        _, _, headers = register_coach()
        quiz, _tf, written, code = build_ready_quiz(client, headers)
        _submit_both(client, quiz, written, code)
        _, _, teammate = invite_teammate(headers)
        assert client.get(URL, headers=teammate).get_json() == []
        _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert client.get(URL, headers=rival).get_json() == []
        assert client.get(URL).status_code == 401
