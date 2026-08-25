"""PHASE C - "what should I teach next", as data.

Every rule here exists because the alternative would mislead a coach: a
weakness claimed from three answers, a misconception claimed from two misses,
an ungraded drawing counted as wrong, or a fabricated 0%.
"""
from app import db
from app.models import Answer
from app.services.concept_results import (
    MIN_MISSES_FOR_DISTRACTOR,
    MIN_PLAYERS_FOR_CONFIDENCE,
)
from tests.test_play_and_grading import build_ready_quiz, start_and_submit


def _concept(client, headers, name):
    return client.post("/api/concepts", json={"name": name}, headers=headers).get_json()


def _tag(client, headers, quiz_id, question_id, concept_id):
    client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}",
        json={"concept_id": concept_id},
        headers=headers,
    )


def _widen_roster(client, headers, quiz_id, names):
    """build_ready_quiz rosters two players. A join is refused for any name not
    on the quiz's roster, so a test needing five responders must say so - the
    code stays active and reads the roster live."""
    client.put(f"/api/quizzes/{quiz_id}/roster", json={"players": names}, headers=headers)


def _dashboard(client, headers, quiz_id):
    return client.get(f"/api/quizzes/{quiz_id}/dashboard", headers=headers).get_json()


class TestConceptRanking:
    def test_untagged_questions_do_not_rank_but_stay_visible(self, client, coach_headers):
        """No fake "General" bucket: inventing one would put a football idea in
        front of a coach they never assigned, and would mix genuinely unrelated
        questions into a single invented weakness."""
        quiz, tf, _written, code = build_ready_quiz(client, coach_headers)
        correct = next(o for o in tf["options"] if o["is_correct_answer"] is not False)
        start_and_submit(
            client, code["id"], "Jordan Smith",
            [{"question_id": tf["id"], "selected_option_id": correct["id"]}],
        )

        body = _dashboard(client, coach_headers, quiz["id"])

        assert body["concept_breakdown"] == []
        # ...and every question is still there to drill into.
        assert len(body["question_breakdown"]) >= 2

    def test_an_all_untagged_quiz_returns_an_empty_list_to_fall_back_on(self, client, coach_headers):
        quiz, _, _, _ = build_ready_quiz(client, coach_headers)

        assert _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"] == []

    def test_the_weakest_concept_sorts_first(self, client, coach_headers):
        quiz, tf, written, code = build_ready_quiz(client, coach_headers)
        weak = _concept(client, coach_headers, "Force / Contain")
        strong = _concept(client, coach_headers, "Alignment")
        _tag(client, coach_headers, quiz["id"], tf["id"], weak["id"])
        _tag(client, coach_headers, quiz["id"], written["id"], strong["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A Player", "B Player", "C Player"])

        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        for name in ["A Player", "B Player", "C Player"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
            )

        rows = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"]

        assert rows[0]["concept_name"] == "Force / Contain"
        assert rows[0]["incorrect_count"] == 3
        assert rows[0]["miss_rate"] == 100.0


class TestSampleSize:
    def test_a_thin_concept_is_flagged_rather_than_hidden(self, client, coach_headers):
        """One answer is arithmetic, not evidence. The row still appears -
        hiding it would be its own kind of lie - but it says it is thin."""
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["Solo Player"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "Solo Player",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["graded_count"] == 1
        assert row["players_responded_count"] == 1
        assert row["has_enough_responses"] is False
        # Counted in PLAYERS now, matching the headline it qualifies.
        assert MIN_PLAYERS_FOR_CONFIDENCE == 5

    def test_NO_FABRICATED_ZERO_when_nothing_is_graded(self, client, coach_headers):
        """A concept nobody has answered is UNMEASURED - not perfect, not
        failed. None, never 0.0, exactly as score_percent behaves."""
        quiz, tf, _, _ = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["graded_count"] == 0
        assert row["miss_rate"] is None


class TestDistractors:
    def _three_option_quiz(self, client, headers):
        quiz = client.post("/api/quizzes", json={"title": "Coverage"}, headers=headers).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who has the flat?",
                "question_type": "multiple_choice",
                "options": [
                    {"option_text": "Corner", "is_correct_answer": True},
                    {"option_text": "Safety", "is_correct_answer": False},
                    {"option_text": "Linebacker", "is_correct_answer": False},
                ],
            },
            headers=headers,
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [f"P{i}" for i in range(1, 9)]},
            headers=headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", headers=headers
        ).get_json()
        return quiz, question, code

    def test_names_the_option_most_misses_chose(self, client, coach_headers):
        quiz, question, code = self._three_option_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Coverage Responsibility")
        _tag(client, coach_headers, quiz["id"], question["id"], concept["id"])
        by_text = {o["option_text"]: o["id"] for o in question["options"]}

        for name in ["P1", "P2", "P3"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": question["id"], "selected_option_id": by_text["Safety"]}],
            )
        start_and_submit(
            client, code["id"], "P4",
            [{"question_id": question["id"], "selected_option_id": by_text["Linebacker"]}],
        )
        start_and_submit(
            client, code["id"], "P5",
            [{"question_id": question["id"], "selected_option_id": by_text["Corner"]}],
        )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["top_distractor"] == {"option_text": "Safety", "count": 3, "of_misses": 4}

    def test_SAYS_NOTHING_when_there_are_too_few_misses(self, client, coach_headers):
        """With two misses, "most of them chose Safety" describes a
        coincidence. Show the count; claim no pattern."""
        quiz, question, code = self._three_option_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Coverage Responsibility")
        _tag(client, coach_headers, quiz["id"], question["id"], concept["id"])
        by_text = {o["option_text"]: o["id"] for o in question["options"]}

        for name in ["P1", "P2"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": question["id"], "selected_option_id": by_text["Safety"]}],
            )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["incorrect_count"] == 2
        assert row["top_distractor"] is None
        assert MIN_MISSES_FOR_DISTRACTOR == 3

    def test_no_distractor_analysis_for_a_typed_answer(self, client, coach_headers):
        """A written answer has no options to count, so v1 shows nothing
        rather than an empty distribution."""
        quiz, _, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Route Adjustment")
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A", "B", "C", "D"])
        for name in ["A", "B", "C", "D"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": written["id"], "answer_text": "wrong"}],
            )
        for answer in Answer.query.filter_by(question_id=written["id"]).all():
            answer.is_correct = False
        db.session.commit()

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["incorrect_count"] == 4
        assert row["top_distractor"] is None


class TestUngraded:
    def test_an_ungraded_answer_is_not_a_miss(self, client, coach_headers):
        """Ungraded is not wrong. Counting it as one would invent a weakness
        out of the coach's own grading backlog."""
        quiz, _, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Route Adjustment")
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A", "B", "C"])
        for name in ["A", "B", "C"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": written["id"], "answer_text": "maybe"}],
            )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["ungraded_count"] == 3
        assert row["incorrect_count"] == 0
        assert row["miss_rate"] is None
        assert row["players_missed"] == []


class TestWhoMissedIt:
    def test_lists_each_player_once_with_their_position_AT_THE_TIME(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "Jordan Smith",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert len(row["players_missed"]) == 1
        entry = row["players_missed"][0]
        assert entry["player_name"] == "Jordan Smith"
        # Present as a key even when never recorded - shown as nothing by the
        # client, never guessed from the roster's current value.
        assert "position_at_attempt" in entry

    def test_a_player_who_missed_two_questions_is_named_once(self, client, coach_headers):
        quiz, tf, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "Jordan Smith",
            [
                {"question_id": tf["id"], "selected_option_id": wrong["id"]},
                {"question_id": written["id"], "answer_text": "no"},
            ],
        )
        for answer in Answer.query.filter_by(question_id=written["id"]).all():
            answer.is_correct = False
        db.session.commit()

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["incorrect_count"] == 2
        assert len(row["players_missed"]) == 1


class TestBinaryQuestionsSayNothingAboutDistractors:
    """With one wrong option, "8 of the 8 misses chose False" is arithmetic.

    Every miss chose it by necessity, not by thinking, so the line restates the
    miss count in more words while reading like a finding. Suppressed by
    counting WRONG OPTIONS rather than by naming a question type, so a
    two-option multiple choice - exactly as hollow - is caught too.
    """

    def test_true_false_gets_no_distractor_line(self, client, coach_headers):
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A", "B", "C", "D"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        for name in ["A", "B", "C", "D"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
            )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        # Four misses clears the miss threshold; the option count is what
        # withholds the line.
        assert row["incorrect_count"] == 4
        assert row["top_distractor"] is None

    def test_a_TWO_OPTION_multiple_choice_is_equally_hollow(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Binary MC"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Force or spill?",
                "question_type": "multiple_choice",
                "options": [
                    {"option_text": "Force", "is_correct_answer": True},
                    {"option_text": "Spill", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()
        concept = _concept(client, coach_headers, "Force / Contain")
        _tag(client, coach_headers, quiz["id"], question["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A", "B", "C", "D"])
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers
        ).get_json()
        wrong = next(o for o in question["options"] if o["is_correct_answer"] is False)
        for name in ["A", "B", "C", "D"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": question["id"], "selected_option_id": wrong["id"]}],
            )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["incorrect_count"] == 4
        assert row["top_distractor"] is None

    def test_THREE_options_still_produce_a_distractor_line(self, client, coach_headers):
        # The case where the line actually teaches something is untouched.
        quiz = client.post(
            "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who has the flat?",
                "question_type": "multiple_choice",
                "options": [
                    {"option_text": "Corner", "is_correct_answer": True},
                    {"option_text": "Safety", "is_correct_answer": False},
                    {"option_text": "Linebacker", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()
        concept = _concept(client, coach_headers, "Coverage Responsibility")
        _tag(client, coach_headers, quiz["id"], question["id"], concept["id"])
        _widen_roster(client, coach_headers, quiz["id"], ["A", "B", "C", "D"])
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers
        ).get_json()
        by_text = {o["option_text"]: o["id"] for o in question["options"]}
        for name in ["A", "B", "C"]:
            start_and_submit(
                client, code["id"], name,
                [{"question_id": question["id"], "selected_option_id": by_text["Safety"]}],
            )
        start_and_submit(
            client, code["id"], "D",
            [{"question_id": question["id"], "selected_option_id": by_text["Linebacker"]}],
        )

        row = _dashboard(client, coach_headers, quiz["id"])["concept_breakdown"][0]

        assert row["top_distractor"] == {"option_text": "Safety", "count": 3, "of_misses": 4}
