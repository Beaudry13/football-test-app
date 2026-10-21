"""REVIEW WHAT YOU MISSED, ON A GRADED QUIZ'S RESULTS: THE FOOTBALL PICTURE.

After submitting, a player's results page says, in words, the question, what
they answered and - unless the coach excluded it - the correct answer. It now
also carries the picture each question was asked on (the DELIVERED one) and,
where the coach ringed him on it, who he was - so the player reviews a miss on
the football, not on a line of text.

THE ANSWER-REVEAL POLICY DOES NOT MOVE. Graded results never carry the answer
key's structure (which options were right, which of the player's were) or the
coach's question explanation - test_player_results_drawing and
test_multi_select_results pin that, and nothing here widens it.
"""

import json
from types import SimpleNamespace

import pytest

from app.routes.play import _review_fields
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
TARGETS = [{"x": 0.2, "y": 0.6}, {"x": 0.8, "y": 0.55}]
RING = {"x": 0.5, "y": 0.4, "r": 0.06}


def _upload_image(client, headers, quiz_id, question_id, name="film.png", size=(40, 40)):
    buffer, filename = make_image_file(name, size)
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=headers,
    )


@pytest.fixture
def graded(client, coach_headers):
    """A graded quiz: one tap decision on a picture, missed; one plain question, right."""
    quiz = client.post("/api/quizzes", json={"title": "Coverage check"}, headers=coach_headers).get_json()
    decision = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Who gets the ball?",
            "question_type": "multiple_choice",
            "options": [{"option_text": "X", "is_correct_answer": True}, {"option_text": "Z"}],
            "tap_targets": TARGETS,
            "subject_marker": RING,
            "answer_explanation": "The corner bails, so X is open on the slant.",
        },
        headers=coach_headers,
    ).get_json()
    _upload_image(client, coach_headers, quiz["id"], decision["id"])
    plain = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "What is the front?",
            "question_type": "multiple_choice",
            "options": [{"option_text": "Over", "is_correct_answer": True}, {"option_text": "Under"}],
        },
        headers=coach_headers,
    ).get_json()
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers).get_json()
    started = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER}).get_json()
    by_id = {q["id"]: q for q in started["questions"]}
    wrong = next(o["id"] for o in by_id[decision["id"]]["options"] if o["option_text"] == "Z")
    right = next(o["id"] for o in by_id[plain["id"]]["options"] if o["option_text"] == "Over")
    submitted = client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": PLAYER,
            "answers": [
                {"question_id": decision["id"], "selected_option_id": wrong, "answer_text": None},
                {"question_id": plain["id"], "selected_option_id": right, "answer_text": None},
            ],
        },
    )
    assert submitted.status_code in (200, 201), submitted.get_json()
    return {
        "quiz_id": quiz["id"],
        "code": code,
        "decision": decision,
        "plain": plain,
        "delivered_image": by_id[decision["id"]]["image"],
    }


def _results(client, graded):
    response = client.post("/api/play/results", json={"code": graded["code"]["code"], "player_name": PLAYER})
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def _answer(payload, question_id):
    return next(a for a in payload["answers"] if a["question_id"] == question_id)


class TestAMissIsReviewedOnItsPicture:
    def test_the_delivered_picture_and_who_he_was_in_it(self, client, graded):
        missed = _answer(_results(client, graded), graded["decision"]["id"])
        assert missed["is_correct"] is False
        assert missed["image"]["image_url"] == graded["delivered_image"]["image_url"]
        assert missed["subject_marker"] == RING
        # The words are unchanged: his answer, and the correct one as a whole.
        assert missed["your_answer"] == "Z"
        assert missed["correct_answer"] == "X"

    def test_a_question_without_a_picture_says_so_plainly(self, client, graded):
        plain = _answer(_results(client, graded), graded["plain"]["id"])
        assert plain["image"] is None
        assert plain["subject_marker"] is None


class TestTheRevealPolicyDoesNotMove:
    def test_no_answer_key_structure_and_no_explanation(self, client, graded):
        blob = json.dumps(_results(client, graded))
        for leak in (
            "is_correct_answer",
            "correct_option_ids",
            "selected_option_ids",
            "answer_explanation",
            "tap_targets",
            "expected_answers",
        ):
            assert leak not in blob

    def test_an_excluded_question_still_withholds_the_answer(self, client, coach_headers, graded):
        client.post(
            f"/api/quizzes/{graded['quiz_id']}/questions/{graded['decision']['id']}/exclusions",
            json={"access_code_id": None, "reason": "Wrong picture"},
            headers=coach_headers,
        )
        excluded = _answer(_results(client, graded), graded["decision"]["id"])
        assert excluded["is_excluded"] is True
        assert excluded["correct_answer"] is None
        # The picture he answered on is still his to see.
        assert excluded["image"] is not None


class TestTheRingOnlyOnTheDeliveredPicture:
    def test_a_replaced_picture_keeps_the_delivered_one_and_drops_the_ring(self, client, coach_headers, graded):
        _upload_image(client, coach_headers, graded["quiz_id"], graded["decision"]["id"], "new.png", (60, 60))
        missed = _answer(_results(client, graded), graded["decision"]["id"])
        live = client.get(f"/api/quizzes/{graded['quiz_id']}", headers=coach_headers).get_json()
        live_url = next(q for q in live["questions"] if q["id"] == graded["decision"]["id"])["image"]["image_url"]
        # Still the picture he answered on (the delivery now points at a
        # preserved copy of it), not the new one - and no ring placed on it.
        assert missed["image"] is not None
        assert missed["image"]["image_url"] != live_url
        assert missed["subject_marker"] is None
        assert missed["correct_answer"] == "X"


class TestReviewFieldsUnit:
    def _delivered(self, image_url="a.png", image_id=7):
        return SimpleNamespace(image=SimpleNamespace(image_url=image_url, image_id=image_id))

    def _live(self, image_url="a.png", image_id=7):
        return SimpleNamespace(
            image=SimpleNamespace(image_url=image_url, id=image_id),
            subject_marker=RING,
            subject_role="Boundary safety",
        )

    def test_the_same_picture_keeps_the_ring_and_the_role(self):
        fields = _review_fields(self._delivered(), self._live())
        assert fields == {"image": {"id": 7, "image_url": "a.png"}, "subject_role": "Boundary safety", "subject_marker": RING}

    def test_a_different_picture_drops_the_ring_but_keeps_the_role(self):
        fields = _review_fields(self._delivered(), self._live(image_url="b.png"))
        assert fields["subject_marker"] is None
        assert fields["subject_role"] == "Boundary safety"

    def test_a_deleted_live_question_still_shows_the_delivered_picture(self):
        fields = _review_fields(self._delivered(), None)
        assert fields == {"image": {"id": 7, "image_url": "a.png"}, "subject_role": None, "subject_marker": None}

    def test_an_unrecorded_image_id_falls_back_to_the_url(self):
        fields = _review_fields(self._delivered(image_id=None), self._live(image_id=99))
        assert fields["subject_marker"] == RING
