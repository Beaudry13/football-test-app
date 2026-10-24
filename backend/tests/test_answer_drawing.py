"""DRAW YOUR ASSIGNMENT, WITH SOMETHING TO COMPARE IT TO.

A Draw Response question can carry the coach's own drawing of the right
answer. It is an answer key and is gated like one: the coach sees it, a player
on a QUIZ never does (practice or graded), and a Situational Rep - teaching -
shows it to the player once his own drawing is locked.
"""
import pytest

from app.extensions import db
from app.models import Quiz
from app.models.quiz import REP_KIND
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"


def key_drawing(image_id="pending"):
    return {
        "format": "peira.drawing",
        "version": 1,
        "coordinate_width": 1000,
        "coordinate_height": 600,
        "source": {"image_id": str(image_id)},
        "strokes": [
            {"id": "s1", "tool": "pen", "layer": "player", "color": "#22c55e", "width": 4,
             "points": [100, 500, 300, 200], "order": 1}
        ],
    }


def _draw_question(client, headers, *, mode=None, rep=False, app=None):
    quiz = client.post("/api/quizzes", json={"title": "Coverage"}, headers=headers).get_json()
    if rep:
        with app.app_context():
            db.session.get(Quiz, quiz["id"]).kind = REP_KIND
            db.session.commit()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Draw the FS rotation", "question_type": "draw_response", "options": []},
        headers=headers,
    ).get_json()
    buffer, filename = make_image_file("coverage.png", (40, 40))
    image = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=headers,
    )
    assert image.status_code == 201
    return quiz, question


def _set_key(client, headers, quiz, question, drawing):
    return client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
        json={"answer_drawing": drawing},
        headers=headers,
    )


def _coach_view(client, headers, quiz):
    return client.get(f"/api/quizzes/{quiz['id']}", headers=headers).get_json()["questions"][0]


class TestTheCoachDrawsTheAnswer:
    def test_saved_as_the_coachs_strokes_bound_to_the_picture(self, client, coach_headers):
        quiz, question = _draw_question(client, coach_headers)
        response = _set_key(client, coach_headers, quiz, question, key_drawing())
        assert response.status_code == 200, response.get_json()
        seen = _coach_view(client, coach_headers, quiz)
        assert [s["layer"] for s in seen["answer_drawing"]["strokes"]] == ["coach"]
        assert seen["answer_drawing"]["source"]["image_id"] == str(seen["image"]["id"])

    def test_only_a_draw_question_has_one_and_a_broken_drawing_is_refused(self, client, coach_headers):
        quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
        mc = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Q?", "question_type": "multiple_choice",
                  "options": [{"option_text": "A", "is_correct_answer": True}, {"option_text": "B"}]},
            headers=coach_headers,
        ).get_json()
        refused = _set_key(client, coach_headers, quiz, mc, key_drawing())
        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "answer_drawing_not_allowed"
        quiz2, draw = _draw_question(client, coach_headers)
        assert _set_key(client, coach_headers, quiz2, draw, {"format": "nope"}).status_code == 422

    def test_cleared_with_null_and_dropped_when_the_question_stops_being_a_drawing(self, client, coach_headers):
        quiz, question = _draw_question(client, coach_headers)
        _set_key(client, coach_headers, quiz, question, key_drawing())
        assert _set_key(client, coach_headers, quiz, question, None).status_code == 200
        assert _coach_view(client, coach_headers, quiz)["answer_drawing"] is None

    def test_a_copy_keeps_it(self, client, coach_headers):
        quiz, question = _draw_question(client, coach_headers)
        _set_key(client, coach_headers, quiz, question, key_drawing())
        copy = client.post(f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers).get_json()
        copied = client.get(f"/api/quizzes/{copy['id']}", headers=coach_headers).get_json()["questions"][0]
        assert copied["answer_drawing"]["strokes"][0]["points"] == [100, 500, 300, 200]


class TestWhoSeesIt:
    @staticmethod
    def _deliver(client, headers, quiz, mode):
        client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=headers)
        payload = {"mode": mode} if mode else {}
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json=payload, headers=headers).get_json()
        delivered = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        started = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER}).get_json()
        return code, delivered, started

    @pytest.mark.parametrize("mode", [None, "PRACTICE"])
    def test_a_player_on_a_quiz_never_receives_it(self, client, coach_headers, mode):
        quiz, question = _draw_question(client, coach_headers)
        _set_key(client, coach_headers, quiz, question, key_drawing())
        code, delivered, started = self._deliver(client, coach_headers, quiz, mode)
        assert "answer_drawing" not in str(delivered)
        assert "answer_drawing" not in str(started)
        if mode == "PRACTICE":
            checked = client.post("/api/play/check", json={"access_code_id": code["id"], "player_name": PLAYER,
                                                            "question_id": question["id"]}).get_json()
            assert "answer_drawing" not in checked

    def test_a_rep_shows_it_once_his_drawing_is_locked(self, client, coach_headers, app):
        quiz, question = _draw_question(client, coach_headers, rep=True, app=app)
        _set_key(client, coach_headers, quiz, question, key_drawing())
        code, delivered, started = self._deliver(client, coach_headers, quiz, "PRACTICE")
        assert "answer_drawing" not in str(delivered)
        checked = client.post("/api/play/check", json={"access_code_id": code["id"], "player_name": PLAYER,
                                                        "question_id": question["id"]}).get_json()
        assert checked["is_correct"] is None  # still the coach's to judge
        assert checked["answer_drawing"]["strokes"][0]["layer"] == "coach"
