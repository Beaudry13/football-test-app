"""Multi-Select M1 - THE SELECTION SET, STORED BUT NOT YET USED.

    M1 IS BEHAVIOUR-INERT. Nothing reads `answer_selected_options` yet and
    `allows_multiple_answers` is False everywhere, so single-choice behaves
    exactly as it did before.

WHAT THESE TESTS ARE FOR
------------------------
Two jobs, and they pull in opposite directions:

1. **Prove nothing moved.** A storage migration that quietly changes a score or
   a results page is the worst possible outcome, because it looks like success.
2. **Prove the new storage has the property it was chosen for** - that a
   recorded selection outlives the live option row it points at.

THE MISSING FOREIGN KEY IS THE POINT
------------------------------------
`answer_selected_options.option_id` has no FK to `question_options`, and
`test_a_selection_outlives_the_option_it_points_at` is the test that says why.
Deleting an option SET NULLs `answers.selected_option_id` - losing the pointer
while keeping the answer - whereas a CASCADE on the join table would have
deleted the row outright and silently shrunk a recorded answer set. The new
storage is deliberately MORE durable than the column it will eventually
replace.
"""

import pytest
from sqlalchemy import text

from app.extensions import db
from app.models import Answer, AnswerSelectedOption, Question, QuestionOption

PLAYER = "Jordan Smith"


def build_quiz(client, headers, *, correct="B gap", wrong="A gap"):
    quiz = client.post(
        "/api/quizzes", json={"title": "Selection storage"}, headers=headers
    ).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Which gap?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": correct, "is_correct_answer": True},
                {"option_text": wrong, "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert question.status_code == 201, question.get_json()
    question = question.get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER]},
        headers=headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers
    ).get_json()
    return quiz, question, code


def answer_it(client, code, question, option_index=0):
    started = client.post(
        "/api/play/start",
        json={"access_code_id": code["id"], "player_name": PLAYER},
    )
    assert started.status_code in (200, 201), started.get_json()
    saved = client.post(
        "/api/play/answers",
        json={
            "access_code_id": code["id"],
            "player_name": PLAYER,
            "question_id": question["id"],
            "selected_option_id": question["options"][option_index]["id"],
            "answer_text": None,
        },
    )
    assert saved.status_code == 204, saved.get_json()
    return saved


# ---------------------------------------------------------------------------
# The schema exists and has the shape that was chosen
# ---------------------------------------------------------------------------


class TestSchema:
    def test_the_table_exists(self, app):
        with app.app_context():
            present = db.session.execute(
                text(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_name = 'answer_selected_options'"
                )
            ).first()
        assert present, "the migration ran against the test database"

    def test_option_id_has_NO_foreign_key(self, app):
        """THE DELIBERATE ABSENCE. If this ever fails, someone has "fixed" the
        missing FK - read models/answer_selected_option.py before agreeing
        with them."""
        with app.app_context():
            targets = [
                row[0]
                for row in db.session.execute(
                    text(
                        "SELECT confrelid::regclass::text FROM pg_constraint "
                        "WHERE conrelid = 'answer_selected_options'::regclass "
                        "AND contype = 'f'"
                    )
                )
            ]
        assert targets == ["answers"], "answers only - never question_options"

    def test_the_same_option_cannot_be_selected_twice(self, app, client, coach_headers):
        """Set semantics enforced by the primary key rather than by validation
        somebody has to remember to write."""
        from sqlalchemy.exc import IntegrityError

        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question)

        with app.app_context():
            answer = Answer.query.one()
            option_id = answer.selected_option_id
            db.session.add(
                AnswerSelectedOption(answer_id=answer.id, option_id=option_id)
            )
            with pytest.raises(IntegrityError):
                db.session.commit()
            db.session.rollback()

    def test_allows_multiple_answers_defaults_to_false(self, app, client, coach_headers):
        """Every question that exists is single-choice, which is why no
        backfill was needed for this column."""
        _, question, _ = build_quiz(client, coach_headers)

        with app.app_context():
            assert db.session.get(Question, question["id"]).allows_multiple_answers is False


# ---------------------------------------------------------------------------
# The property the missing FK was chosen for
# ---------------------------------------------------------------------------


class TestHistoricalDurability:
    def test_a_selection_outlives_the_option_it_points_at(
        self, app, client, coach_headers
    ):
        """THE WHOLE ARGUMENT FOR NO FOREIGN KEY, in one test.

        Deleting an option SET NULLs `answers.selected_option_id` - the answer
        and its grade survive, the pointer does not. A CASCADE on the join
        table would have deleted the selection row outright, which for a
        multi-select answer means silently recording a SMALLER set than the
        player actually chose.

        The row survives instead, and its meaning is resolved from the
        delivered snapshot.
        """
        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question)

        with app.app_context():
            answer = Answer.query.one()
            option_id = answer.selected_option_id
            assert option_id is not None, "the fixture really did select something"
            assert AnswerSelectedOption.query.filter_by(
                answer_id=answer.id, option_id=option_id
            ).first(), "and it was recorded in the new table"

            db.session.delete(db.session.get(QuestionOption, option_id))
            db.session.commit()

            db.session.expire_all()
            assert (
                AnswerSelectedOption.query.filter_by(option_id=option_id).first()
                is not None
            ), "the SELECTION survives"
            assert (
                db.session.get(Answer, answer.id).selected_option_id is None
            ), "while the old column was SET NULL, as it always was"

    def test_deleting_the_answer_does_take_its_selections(
        self, app, client, coach_headers
    ):
        """The other direction is a genuine cascade: a selection has no meaning
        without the answer it belongs to."""
        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question)

        with app.app_context():
            answer = Answer.query.one()
            assert AnswerSelectedOption.query.count() == 1
            db.session.execute(text("DELETE FROM answers WHERE id = :i"), {"i": answer.id})
            db.session.commit()

            assert AnswerSelectedOption.query.count() == 0


# ---------------------------------------------------------------------------
# M1 changed nothing a coach or player can see
# ---------------------------------------------------------------------------


class TestBehaviourIsInert:
    def test_a_single_choice_answer_still_records_selected_option_id(
        self, app, client, coach_headers
    ):
        """`selected_option_id` remains what current behaviour reads. M1 adds a
        second representation; it does not switch to it."""
        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question)

        with app.app_context():
            answer = Answer.query.one()
            assert answer.selected_option_id == question["options"][0]["id"]

    def test_grading_is_unchanged(self, app, client, coach_headers):
        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question, option_index=0)

        with app.app_context():
            assert Answer.query.one().is_correct is True

        quiz2, question2, code2 = build_quiz(client, coach_headers)
        answer_it(client, code2, question2, option_index=1)

        with app.app_context():
            wrong = Answer.query.filter_by(question_id=question2["id"]).one()
            assert wrong.is_correct is False

    def test_the_question_payload_reports_the_flag_without_changing_anything_else(
        self, client, coach_headers
    ):
        quiz, question, _ = build_quiz(client, coach_headers)

        payload = client.get(
            f"/api/quizzes/{quiz['id']}", headers=coach_headers
        ).get_json()["questions"][0]

        assert payload["allows_multiple_answers"] is False
        # The fields every existing consumer relies on are untouched.
        for field in ("id", "question_text", "question_type", "options", "position"):
            assert field in payload

    def test_the_player_payload_exposes_no_answer_key(self, client, coach_headers):
        """M1 exposed nothing at all; M3 added `allows_multiple_answers`, which
        says HOW MANY answers may be picked and never WHICH are right.

        What must never appear is the key itself, and that is what this now
        pins - the earlier "gains nothing" assertion could not survive the
        phase that made the feature usable."""
        import json

        quiz, question, code = build_quiz(client, coach_headers)
        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": PLAYER},
        ).get_json()

        blob = json.dumps(started)
        assert "is_correct_answer" not in blob
        assert "expected_answers" not in blob

    def test_results_still_read_the_single_selected_option(
        self, client, coach_headers
    ):
        quiz, question, code = build_quiz(client, coach_headers)
        answer_it(client, code, question)
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": question["options"][0]["id"],
                        "answer_text": None,
                    }
                ],
            },
        )

        results = client.post(
            "/api/play/results",
            json={"code": code["code"], "player_name": PLAYER},
        ).get_json()

        assert results["answers"][0]["your_answer"] == "B gap"
