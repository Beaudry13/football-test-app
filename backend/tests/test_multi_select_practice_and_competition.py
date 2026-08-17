"""Multi-Select M3 - PRACTICE FEEDBACK, AND THE COMPETITION FENCE.

PRACTICE TELLS A PLAYER WHETHER THEY WERE RIGHT, NOT WHICH BOXES WERE
---------------------------------------------------------------------
Per-option feedback would let a player reverse-engineer the answer key one
checkbox at a time: tick A, check, tick B, check. The verdict is the whole
answer, exactly as it already is for every other question type, and the coach's
explanation stays the teaching mechanism.

This needed NO new feedback system. `practice_feedback` already returns only
`is_correct` plus the explanation, so multi-select inherits the right behaviour
by being auto-gradable - which is the outcome worth having: the decision was
already the architecture's default.

COMPETITION IS OUT OF V1, AND SAYS SO
-------------------------------------
Blocked through `unsupported_questions`, the list a coach is ALREADY shown when
a quiz cannot be played live - not a new mechanism. Competition scores one tap
against one option and times it; a set answer needs a different submission, a
different grading path and an explicit lock-in, none of which v1 builds.
"""

import json

import pytest

from app.models.assessment_mode import PRACTICE

PLAYER = "Jordan Smith"


def opt(text, correct=False):
    return {"option_text": text, "is_correct_answer": correct}


def build(client, headers, *, mode=None, multi=True):
    """`multi=False` is the CONTROL, and its options differ deliberately: a
    single-choice question must have exactly one correct answer, so reusing the
    two-correct list would simply fail to create the question and every
    assertion after it would be measuring an empty quiz."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Pressure"}, headers=headers
    ).get_json()
    options = (
        [opt("Mike", True), opt("Will"), opt("Nickel", True)]
        if multi
        else [opt("Mike", True), opt("Will"), opt("Nickel")]
    )
    created = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Who is in the pressure?",
            "question_type": "multiple_choice",
            "allows_multiple_answers": multi,
            "answer_explanation": "The Mike and the Nickel both come.",
            "options": options,
        },
        headers=headers,
    )
    assert created.status_code == 201, created.get_json()
    question = created.get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER]},
        headers=headers,
    )
    payload = {"mode": mode} if mode else {}
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json=payload, headers=headers
    )
    return quiz, question, code


def ids_for(question, texts):
    by_text = {o["option_text"]: o["id"] for o in question["options"]}
    return [by_text[t] for t in texts]


class TestPracticeFeedback:
    @pytest.fixture
    def practice(self, client, coach_headers):
        quiz, question, code = build(client, coach_headers, mode=PRACTICE)
        assert code.status_code == 201, code.get_json()
        code = code.get_json()
        client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": PLAYER},
        )
        return {"quiz": quiz, "question": question, "code": code}

    def answer_and_check(self, client, practice, texts):
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": practice["code"]["id"],
                "player_name": PLAYER,
                "question_id": practice["question"]["id"],
                "selected_option_id": None,
                "selected_option_ids": ids_for(practice["question"], texts),
                "answer_text": None,
            },
        )
        return client.post(
            "/api/play/check",
            json={
                "access_code_id": practice["code"]["id"],
                "player_name": PLAYER,
                "question_id": practice["question"]["id"],
            },
        )

    def test_the_exact_set_is_reported_correct(self, client, practice):
        checked = self.answer_and_check(client, practice, ["Mike", "Nickel"])

        assert checked.status_code == 200, checked.get_json()
        assert checked.get_json()["is_correct"] is True

    def test_a_partial_set_is_reported_incorrect(self, client, practice):
        checked = self.answer_and_check(client, practice, ["Mike"])

        assert checked.get_json()["is_correct"] is False

    def test_it_does_NOT_say_which_selections_were_right(self, client, practice):
        """THE DECISION THAT MATTERS HERE. Per-option feedback would let a
        player find the answer key one checkbox at a time."""
        body = self.answer_and_check(client, practice, ["Mike"]).get_json()
        blob = json.dumps(body)

        # No per-option verdicts, and no answer key.
        assert "is_correct_answer" not in blob
        assert "correct_option_ids" not in blob
        assert "selected_option_ids" not in blob
        # The verdict is one boolean about the WHOLE answer.
        assert set(body) <= {
            "question_id",
            "auto_gradable",
            "is_correct",
            "answer_explanation",
        }

    def test_the_coachs_explanation_is_still_the_teaching_mechanism(
        self, client, practice
    ):
        body = self.answer_and_check(client, practice, ["Mike"]).get_json()

        assert body["answer_explanation"] == "The Mike and the Nickel both come."


class TestCompetitionFence:
    def test_a_quiz_with_a_multi_select_question_cannot_start_a_competition(
        self, client, coach_headers
    ):
        quiz, _, _ = build(client, coach_headers)

        started = client.post(
            f"/api/competition/quizzes/{quiz['id']}", json={}, headers=coach_headers
        )

        assert started.status_code == 422
        assert started.get_json()["reason"] == "unsupported_questions"

    def test_the_coach_is_told_which_question_and_why(self, client, coach_headers):
        """Actionable, and free of architecture: a coach does not need to know
        that Competition scores one tap against one option."""
        quiz, question, _ = build(client, coach_headers)

        body = client.post(
            f"/api/competition/quizzes/{quiz['id']}", json={}, headers=coach_headers
        ).get_json()

        blocked = body["details"]["unsupported_questions"]
        assert [b["question_id"] for b in blocked] == [question["id"]]
        assert "Select All That Apply" in blocked[0]["reason"]
        assert "Competition Mode yet" in blocked[0]["reason"]

    def test_an_ordinary_multiple_choice_quiz_still_starts(self, client, coach_headers):
        """The fence must not touch the normal Competition path."""
        quiz, _, _ = build(client, coach_headers, multi=False)

        started = client.post(
            f"/api/competition/quizzes/{quiz['id']}", json={}, headers=coach_headers
        )

        assert started.status_code == 201, started.get_json()


class TestOrdinaryActivationIsUnfenced:
    def test_a_multi_select_quiz_CAN_now_be_activated_normally(
        self, client, coach_headers
    ):
        """The M2 fence is gone: players can answer these now, so a graded
        Peira containing one is sendable."""
        _, _, code = build(client, coach_headers)

        assert code.status_code == 201, code.get_json()

    def test_and_in_practice_mode(self, client, coach_headers):
        _, _, code = build(client, coach_headers, mode=PRACTICE)

        assert code.status_code == 201, code.get_json()
