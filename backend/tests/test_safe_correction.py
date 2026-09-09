"""PAST = FROZEN. FUTURE = CORRECTED.

A coach who finds a typo on an active quiz must be able to fix it without
deleting the quiz, duplicating it, or issuing a new access code - and without
changing one thing about what a player already received.

THE INVARIANT THESE TESTS EXIST FOR:

    Player A starts  ->  coach corrects  ->  A resumes  ->  A still sees the
    version A started with.  Player B starts afterwards and sees the correction.

That works because `/play/start` writes an `attempt_question_snapshots` row per
question and every read path goes through `services/delivered_questions`, never
through the live question. These tests hold that line from the OUTSIDE, through
the real routes, because the invariant is a product promise rather than an
implementation detail.

WHAT IS DELIBERATELY REFUSED, and tested here as carefully as what is allowed:
changing which answer is correct, and removing an option. Both would leave two
players with different verdicts for the same answer - `answers.is_correct` is a
stored column written at answer time from the LIVE options, so old answers keep
their verdict while new ones get the new key. That is a regrade policy, not a
code change, and it is out of scope by decision.
"""

import pytest

from app.extensions import db
from app.models import Answer, PlayerAttempt, Question


@pytest.fixture
def active_quiz(client, coach_headers):
    """A quiz with one multiple-choice question, a roster and a live code."""
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Cover 3 install"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": "Which coverage is shown?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()["id"]
    client.put(
        f"/api/quizzes/{quiz_id}/roster",
        json={"players": ["Casey Fields", "Rowan Pike"]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    ).get_json()
    return quiz_id, question_id, code


def start(client, code, player):
    response = client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )
    assert response.status_code in (200, 201), response.get_json()
    return response.get_json()


def delivered_text(payload, question_id):
    for question in payload["questions"]:
        if question["id"] == question_id:
            return question["question_text"]
    raise AssertionError("question not delivered")


def correct(client, coach_headers, quiz_id, question_id, *, text=None, options=None):
    body = {
        "question_text": text or "Which coverage is shown?",
        "question_type": "multiple_choice",
        "options": options
        or [
            {"option_text": "Cover 3", "is_correct_answer": True},
            {"option_text": "Cover 2", "is_correct_answer": False},
        ],
    }
    return client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}", json=body, headers=coach_headers
    )


class TestTheAttemptVersionInvariant:
    def test_a_resumed_attempt_keeps_the_version_it_started_with(
        self, client, coach_headers, active_quiz
    ):
        """THE CENTRAL PROMISE. Finish the quiz you started."""
        quiz_id, question_id, code = active_quiz
        before = start(client, code, "Casey Fields")
        assert delivered_text(before, question_id) == "Which coverage is shown?"

        assert correct(
            client, coach_headers, quiz_id, question_id, text="Which coverage is this?"
        ).status_code == 200

        resumed = start(client, code, "Casey Fields")
        assert delivered_text(resumed, question_id) == "Which coverage is shown?"

    def test_a_new_player_receives_the_correction(self, client, coach_headers, active_quiz):
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")
        correct(client, coach_headers, quiz_id, question_id, text="Which coverage is this?")

        fresh = start(client, code, "Rowan Pike")
        assert delivered_text(fresh, question_id) == "Which coverage is this?"

    def test_the_access_code_never_changes(self, client, coach_headers, active_quiz):
        """No new code, no duplicate quiz - the coach keeps the one they sent."""
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")
        correct(client, coach_headers, quiz_id, question_id, text="Corrected")

        after = start(client, code, "Rowan Pike")
        assert after is not None
        codes = client.get(
            f"/api/quizzes/{quiz_id}/access-codes", headers=coach_headers
        ).get_json()
        ids = [c["id"] for c in (codes if isinstance(codes, list) else codes.get("items", []))]
        assert code["id"] in ids


class TestSafeCorrectionsAreAllowed:
    def test_rewording_a_delivered_question_succeeds(self, client, coach_headers, active_quiz):
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")

        assert correct(
            client, coach_headers, quiz_id, question_id, text="Fixed the typo"
        ).status_code == 200

    def test_rewording_an_option_KEEPS_ITS_ROW(self, app, client, coach_headers, active_quiz):
        """The whole reason delivered options are edited in place. A rebuilt
        list would mint new ids and strand every `Answer.selected_option_id`
        pointing at the old ones."""
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")
        with app.app_context():
            before = [o.id for o in db.session.get(Question, question_id).options]

        assert correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3 (base)", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        ).status_code == 200

        with app.app_context():
            question = db.session.get(Question, question_id)
            assert [o.id for o in question.options] == before
            assert question.options[0].option_text == "Cover 3 (base)"

    def test_appending_an_option_is_allowed(self, app, client, coach_headers, active_quiz):
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")

        assert correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
                {"option_text": "Cover 4", "is_correct_answer": False},
            ],
        ).status_code == 200

        with app.app_context():
            assert len(db.session.get(Question, question_id).options) == 3

    def test_a_never_delivered_question_is_still_freely_editable(
        self, client, coach_headers, active_quiz
    ):
        """Nothing here may make ordinary authoring harder."""
        quiz_id, question_id, _ = active_quiz  # nobody has started

        assert correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ],
        ).status_code == 200


class TestHistoryChangingCorrectionsAreRefused:
    def test_changing_which_answer_is_correct(self, client, coach_headers, active_quiz):
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")

        response = correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3", "is_correct_answer": False},
                {"option_text": "Cover 2", "is_correct_answer": True},
            ],
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "correct_answer_change_blocked"

    def test_removing_an_option(self, client, coach_headers, active_quiz):
        """THREE options down to two, not two down to one: a multiple-choice
        question needs at least two, so a shorter payload is refused by the
        type validator before the removal guard is ever consulted - and would
        have proved nothing about removal."""
        quiz_id, question_id, code = active_quiz
        assert correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
                {"option_text": "Cover 4", "is_correct_answer": False},
            ],
        ).status_code == 200
        start(client, code, "Casey Fields")

        response = correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "option_removal_blocked"

    def test_appending_a_CORRECT_option_to_a_single_answer_question(
        self, app, client, coach_headers, active_quiz
    ):
        """APPEND INCORRECT = allowed. APPEND CORRECT = answer-key change.

        On a single-answer question the refusal comes from the TYPE rule
        ("exactly one option must be marked as the correct answer") rather than
        from the delivery rule, because two correct answers are invalid here
        whether or not anybody has received it. That ordering is right and is
        not worth rearranging: the payload is refused before anything is
        applied, and the answer key is protected either way. What matters to
        the product is asserted below - the refusal happens, and the correct
        set does not move.
        """
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")

        response = correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            options=[
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
                {"option_text": "Also right", "is_correct_answer": True},
            ],
        )
        assert response.status_code == 422

        with app.app_context():
            question = db.session.get(Question, question_id)
            assert [o.is_correct_answer for o in question.options] == [True, False]
            assert len(question.options) == 2

    def test_appending_a_CORRECT_option_to_a_select_all_question(
        self, app, client, coach_headers
    ):
        """THE DELIVERY RULE ITSELF, on the one question shape where a second
        correct answer is legitimate. "Select all that apply" makes two correct
        options valid, so the type rule stays quiet and the delivered-question
        guard is what has to refuse - because everyone who already answered was
        graded against the old key."""
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Select all"}, headers=coach_headers
        ).get_json()["id"]
        question_id = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Which are true?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [
                    {"option_text": "A", "is_correct_answer": True},
                    {"option_text": "B", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()["id"]
        client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey Fields"]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code, "Casey Fields")

        response = client.patch(
            f"/api/quizzes/{quiz_id}/questions/{question_id}",
            json={
                "question_text": "Which are true?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [
                    {"option_text": "A", "is_correct_answer": True},
                    {"option_text": "B", "is_correct_answer": False},
                    {"option_text": "C", "is_correct_answer": True},
                ],
            },
            headers=coach_headers,
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "correct_answer_change_blocked"

        with app.app_context():
            assert len(db.session.get(Question, question_id).options) == 2

    def test_appending_an_INCORRECT_option_to_a_select_all_question_is_allowed(
        self, app, client, coach_headers
    ):
        """The other half of the same rule, so the refusal above is shown to be
        about CORRECTNESS rather than about appending."""
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Select all ok"}, headers=coach_headers
        ).get_json()["id"]
        question_id = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Which are true?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [
                    {"option_text": "A", "is_correct_answer": True},
                    {"option_text": "B", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()["id"]
        client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey Fields"]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code, "Casey Fields")

        response = client.patch(
            f"/api/quizzes/{quiz_id}/questions/{question_id}",
            json={
                "question_text": "Which are true?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [
                    {"option_text": "A", "is_correct_answer": True},
                    {"option_text": "B", "is_correct_answer": False},
                    {"option_text": "C", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        )
        assert response.status_code == 200

        with app.app_context():
            assert len(db.session.get(Question, question_id).options) == 3

    def test_a_refused_correction_writes_NOTHING(
        self, app, client, coach_headers, active_quiz
    ):
        """A refusal that half-applied would be worse than no rule at all."""
        quiz_id, question_id, code = active_quiz
        start(client, code, "Casey Fields")

        correct(
            client,
            coach_headers,
            quiz_id,
            question_id,
            text="This text must not survive",
            options=[
                {"option_text": "Cover 3", "is_correct_answer": False},
                {"option_text": "Cover 2", "is_correct_answer": True},
            ],
        )

        with app.app_context():
            question = db.session.get(Question, question_id)
            assert question.question_text == "Which coverage is shown?"
            assert [o.is_correct_answer for o in question.options] == [True, False]


class TestHistoryIsUntouched:
    def test_an_existing_answer_keeps_its_stored_verdict(
        self, app, client, coach_headers, active_quiz
    ):
        """`answers.is_correct` is a STORED column, written from the LIVE
        options at the moment the player answered. A later correction must not
        recompute it, and no read path ever does.

        THE ANSWER ROW IS WRITTEN DIRECTLY rather than through /play/answers.
        This test is about what a CORRECTION does to an answer that already
        exists; routing through the save endpoint would drag its rate limiter,
        code-validity checks and attempt locking into an assertion that is not
        about any of them. `upsert_answer` is covered by tests/test_attempts.py.
        """
        quiz_id, question_id, code = active_quiz
        started = start(client, code, "Casey Fields")
        option_id = next(
            q for q in started["questions"] if q["id"] == question_id
        )["options"][0]["id"]

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(access_code_id=code["id"]).first()
            assert attempt is not None
            db.session.add(
                Answer(
                    attempt_id=attempt.id,
                    question_id=question_id,
                    selected_option_id=option_id,
                    is_correct=True,
                )
            )
            db.session.commit()

        assert correct(
            client, coach_headers, quiz_id, question_id, text="Reworded after answering"
        ).status_code == 200

        with app.app_context():
            after = Answer.query.filter_by(question_id=question_id).one()
            assert after.is_correct is True
            assert after.selected_option_id == option_id
