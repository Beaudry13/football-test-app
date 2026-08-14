"""CHARACTERIZATION of ordinary Peira scoring, as it behaves TODAY.

Written BEFORE the Phase 2 refactor and deliberately not adjusted to suit it.
Its whole job is to pin production behaviour to exact values so a refactor that
changes any number fails loudly.

THE SUBJECT IS ONE ATTEMPT, READ SIX WAYS. Every test here reads the SAME
underlying submitted attempt through a different scoring surface. If two
surfaces ever disagree about it, that is a finding, not something to smooth
over - see docs and the Phase 2 report.

The fixture deliberately contains every case the rule has to survive:

  Q1 multiple choice  answered correctly      -> is_correct True
  Q2 multiple choice  answered incorrectly    -> is_correct False
  Q3 written          answered, graded RIGHT  -> is_correct True
  Q4 written          answered, NOT graded    -> is_correct None
  Q5 true/false       never answered at all   -> no Answer row

so the documented rule - score = correct / (correct + incorrect), never
counting Not Graded or Unanswered, never fabricating 0% - must produce:

  correct 2, incorrect 1, not graded 1, unanswered 1
  score   2 / 3 = 66.666... -> 66.7
"""

import csv
import io

import pytest

from app.extensions import db
from app.models import Answer, AttemptStatus, PlayerAttempt
from app.models.assessment_mode import PRACTICE

PLAYER_FIRST = "Jordan"
PLAYER_LAST = "Smith"
PLAYER_NAME = f"{PLAYER_FIRST} {PLAYER_LAST}"

#: What every surface must say about the fixture attempt.
EXPECTED_CORRECT = 2
EXPECTED_INCORRECT = 1
EXPECTED_NOT_GRADED = 1
EXPECTED_UNANSWERED = 1
EXPECTED_GRADED_DENOMINATOR = EXPECTED_CORRECT + EXPECTED_INCORRECT  # 3
EXPECTED_SCORE_PERCENT = 66.7


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


def _mc(client, headers, quiz_id, text):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Right", "is_correct_answer": True},
                {"option_text": "Wrong", "is_correct_answer": False},
                {"option_text": "Also wrong", "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _written(client, headers, quiz_id, text):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": text, "question_type": "written", "options": []},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _true_false(client, headers, quiz_id, text):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _option(question, correct: bool):
    return next(o["id"] for o in question["options"] if o["option_text"] == ("Right" if correct else "Wrong"))


@pytest.fixture
def scored(app, client, coach_headers):
    """One submitted GRADED attempt covering all four result categories.

    Built through the real API - create, activate, start, submit, grade - so
    this characterizes the production path rather than hand-made rows.
    """
    quiz = client.post("/api/quizzes", json={"title": "Install 1"}, headers=coach_headers).get_json()
    quiz_id = quiz["id"]

    q_correct = _mc(client, coach_headers, quiz_id, "Q1 answered correctly")
    q_incorrect = _mc(client, coach_headers, quiz_id, "Q2 answered incorrectly")
    q_graded = _written(client, coach_headers, quiz_id, "Q3 written, graded correct")
    q_ungraded = _written(client, coach_headers, quiz_id, "Q4 written, awaiting grading")
    q_unanswered = _true_false(client, coach_headers, quiz_id, "Q5 never answered")

    player = client.post(
        "/api/players",
        json={"first_name": PLAYER_FIRST, "last_name": PLAYER_LAST},
        headers=coach_headers,
    ).get_json()

    # Added as a CANONICAL roster member (player_ids), not as a typed name.
    # A name-only roster row leaves player_id NULL on the attempt, which makes
    # the attempt invisible to the player profile - the very surface this file
    # has to characterize.
    added = client.post(
        f"/api/quizzes/{quiz_id}/roster/members",
        json={"player_ids": [player["id"]]},
        headers=coach_headers,
    )
    assert added.status_code == 201, added.get_json()

    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    ).get_json()

    started = client.post(
        "/api/play/start",
        json={"access_code_id": code["id"], "player_name": PLAYER_NAME, "player_id": player["id"]},
    )
    assert started.status_code == 201, started.get_json()

    submitted = client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": PLAYER_NAME,
            "player_id": player["id"],
            # Q5 is deliberately absent from the payload: an unanswered
            # question has NO Answer row, which is the case the whole
            # denominator rule turns on.
            "answers": [
                {
                    "question_id": q_correct["id"],
                    "selected_option_id": _option(q_correct, True),
                    "answer_text": None,
                },
                {
                    "question_id": q_incorrect["id"],
                    "selected_option_id": _option(q_incorrect, False),
                    "answer_text": None,
                },
                {"question_id": q_graded["id"], "selected_option_id": None, "answer_text": "Cover 3"},
                {"question_id": q_ungraded["id"], "selected_option_id": None, "answer_text": "Cover 2"},
            ],
        },
    )
    assert submitted.status_code == 201, submitted.get_json()
    attempt_id = submitted.get_json()["id"]

    # Grade exactly ONE of the two written answers, leaving the other pending.
    with app.app_context():
        answer_id = (
            Answer.query.filter_by(attempt_id=attempt_id, question_id=q_graded["id"]).one().id
        )
    graded = client.patch(
        f"/api/answers/{answer_id}/grade",
        json={"is_correct": True, "coach_feedback": "Good read"},
        headers=coach_headers,
    )
    assert graded.status_code == 200, graded.get_json()

    return {
        "quiz_id": quiz_id,
        "code": code,
        "player_id": player["id"],
        "attempt_id": attempt_id,
        "questions": {
            "correct": q_correct,
            "incorrect": q_incorrect,
            "graded": q_graded,
            "ungraded": q_ungraded,
            "unanswered": q_unanswered,
        },
    }


# ---------------------------------------------------------------------------
# The raw stored grades this all rests on
# ---------------------------------------------------------------------------


class TestStoredGrades:
    def test_the_attempt_stores_exactly_the_grades_the_rule_expects(self, app, client, scored):
        """Everything below reads answers.is_correct, a STORED value. If this
        drifts, every other assertion in this file is measuring the wrong
        thing."""
        with app.app_context():
            answers = Answer.query.filter_by(attempt_id=scored["attempt_id"]).all()
            by_question = {a.question_id: a.is_correct for a in answers}

            assert by_question[scored["questions"]["correct"]["id"]] is True
            assert by_question[scored["questions"]["incorrect"]["id"]] is False
            assert by_question[scored["questions"]["graded"]["id"]] is True
            assert by_question[scored["questions"]["ungraded"]["id"]] is None
            # THE POINT: no row at all, not a row with a null grade.
            assert scored["questions"]["unanswered"]["id"] not in by_question
            assert len(answers) == 4


# ---------------------------------------------------------------------------
# Surface 1 - quiz card average (routes/quizzes.py)
# ---------------------------------------------------------------------------


class TestQuizCardAverage:
    def test_quiz_list_average_score_percent(self, client, coach_headers, scored):
        body = client.get("/api/quizzes", headers=coach_headers).get_json()
        card = next(q for q in body if q["id"] == scored["quiz_id"])

        assert card["average_score_percent"] == EXPECTED_SCORE_PERCENT

    def test_a_quiz_with_nothing_graded_omits_the_key_entirely(self, client, coach_headers):
        """Never fabricate 0% when nothing is graded.

        The route computes None, and `Quiz.to_dict` then OMITS the key rather
        than serialising a null - so the frontend sees `undefined`, which is
        exactly what QuizCard.tsx's `!== undefined` guard tests for. Recorded
        as characterized behaviour: a refactor that starts emitting an
        explicit null would make the avg-score line appear on every fresh
        quiz card.
        """
        quiz = client.post("/api/quizzes", json={"title": "Fresh"}, headers=coach_headers).get_json()
        body = client.get("/api/quizzes", headers=coach_headers).get_json()
        card = next(q for q in body if q["id"] == quiz["id"])

        assert "average_score_percent" not in card


# ---------------------------------------------------------------------------
# Surface 2 - canonical player profile (routes/players.py)
# ---------------------------------------------------------------------------


class TestPlayerProfileHistory:
    def test_per_attempt_and_cumulative_score(self, client, coach_headers, scored):
        body = client.get(
            f"/api/players/{scored['player_id']}/history", headers=coach_headers
        ).get_json()

        assert len(body["recent_results"]) == 1
        result = body["recent_results"][0]
        assert result["score_percent"] == EXPECTED_SCORE_PERCENT
        assert result["graded_answer_count"] == EXPECTED_GRADED_DENOMINATOR
        assert result["correct_answer_count"] == EXPECTED_CORRECT
        # Only WRITTEN/DRAW_RESPONSE count as pending - an ungraded written
        # answer does, an unanswered question does not.
        assert result["pending_grading_count"] == EXPECTED_NOT_GRADED

        assert body["average_score_percent"] == EXPECTED_SCORE_PERCENT


# ---------------------------------------------------------------------------
# Surface 3 - legacy name-matched history (routes/grading.py)
# ---------------------------------------------------------------------------


class TestLegacyNameHistory:
    def test_it_returns_counts_and_no_percentage(self, client, coach_headers, scored):
        """This endpoint deliberately returns COUNTS ONLY. The percentage a
        coach actually sees is computed in the browser - see
        PlayerHistoryPage.tsx - which is why it is a scoring surface even
        though no percentage appears here."""
        body = client.get(
            f"/api/players/history?name={PLAYER_NAME}", headers=coach_headers
        ).get_json()

        assert len(body["history"]) == 1
        entry = body["history"][0]
        assert entry["graded_answer_count"] == EXPECTED_GRADED_DENOMINATOR
        assert entry["correct_answer_count"] == EXPECTED_CORRECT
        assert entry["pending_grading_count"] == EXPECTED_NOT_GRADED
        assert "score_percent" not in entry


# ---------------------------------------------------------------------------
# Surface 4 - grading dashboard (routes/grading.py)
# ---------------------------------------------------------------------------


class TestGradingDashboard:
    def test_per_question_breakdown_counts(self, client, coach_headers, scored):
        body = client.get(
            f"/api/quizzes/{scored['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        by_question = {q["question_id"]: q for q in body["question_breakdown"]}

        assert by_question[scored["questions"]["correct"]["id"]]["correct_count"] == 1
        assert by_question[scored["questions"]["incorrect"]["id"]]["incorrect_count"] == 1
        assert by_question[scored["questions"]["graded"]["id"]]["correct_count"] == 1
        assert by_question[scored["questions"]["ungraded"]["id"]]["ungraded_count"] == 1
        # An unanswered question has NO answer rows, so every count is zero -
        # the dashboard counts answers, not delivered questions.
        unanswered = by_question[scored["questions"]["unanswered"]["id"]]
        assert unanswered["answered_count"] == 0
        assert (unanswered["correct_count"], unanswered["incorrect_count"]) == (0, 0)

    def test_the_dashboard_publishes_no_score_percentage(self, client, coach_headers, scored):
        body = client.get(
            f"/api/quizzes/{scored['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        assert "average_score_percent" not in body
        assert "score_percent" not in body


# ---------------------------------------------------------------------------
# Surface 5 - detailed PDF counts (services/export.py)
# ---------------------------------------------------------------------------


class TestDetailedExportCounts:
    def test_the_four_way_classification_and_score(self, app, client, coach_headers, scored):
        """The ONLY surface that counts DELIVERED QUESTIONS rather than answer
        rows - it iterates the quiz's questions, so an unanswered one becomes
        UNANSWERED instead of simply being absent."""
        from app.models import Question
        from app.services.export import (
            RESULT_CORRECT,
            RESULT_INCORRECT,
            RESULT_NOT_GRADED,
            RESULT_UNANSWERED,
            _player_result_counts,
            _score_percent,
        )

        with app.app_context():
            attempt = db.session.get(PlayerAttempt, scored["attempt_id"])
            questions = sorted(
                Question.query.filter_by(quiz_id=scored["quiz_id"]).all(), key=lambda q: q.position
            )
            counts, _ = _player_result_counts(questions, attempt)

        assert counts[RESULT_CORRECT] == EXPECTED_CORRECT
        assert counts[RESULT_INCORRECT] == EXPECTED_INCORRECT
        assert counts[RESULT_NOT_GRADED] == EXPECTED_NOT_GRADED
        assert counts[RESULT_UNANSWERED] == EXPECTED_UNANSWERED

        score = _score_percent(counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT])
        assert score == EXPECTED_SCORE_PERCENT

    def test_score_percent_never_fabricates_a_zero(self):
        from app.services.export import _score_percent

        assert _score_percent(0, 0) is None
        assert _score_percent(0, 4) == 0.0
        assert _score_percent(1, 3) == 33.3
        assert _score_percent(2, 3) == 66.7


# ---------------------------------------------------------------------------
# Surface 6 - CSV export (services/export.py)
# ---------------------------------------------------------------------------


class TestCsvExport:
    def test_per_question_correct_labels(self, client, coach_headers, scored):
        """The CSV classifies with its own 3-way label map plus a "No answer"
        fallback, NOT with _grading_result. Characterized here so a refactor
        that unifies them has to prove the strings did not move."""
        raw = client.get(
            f"/api/quizzes/{scored['quiz_id']}/export.csv", headers=coach_headers
        ).get_data(as_text=True)
        rows = list(csv.DictReader(io.StringIO(raw)))

        by_question = {r["Question"]: r["Correct"] for r in rows}
        assert by_question["Q1 answered correctly"] == "Yes"
        assert by_question["Q2 answered incorrectly"] == "No"
        assert by_question["Q3 written, graded correct"] == "Yes"
        assert by_question["Q4 written, awaiting grading"] == "Ungraded"
        assert by_question["Q5 never answered"] == "No answer"

    def test_the_csv_publishes_no_score_percentage(self, client, coach_headers, scored):
        raw = client.get(
            f"/api/quizzes/{scored['quiz_id']}/export.csv", headers=coach_headers
        ).get_data(as_text=True)
        assert "%" not in raw


# ---------------------------------------------------------------------------
# Surface 7 - the player's own results (routes/play.py)
# ---------------------------------------------------------------------------


class TestPlayerFacingResults:
    def test_it_reports_per_answer_verdicts_and_no_aggregate(self, client, scored):
        body = client.post(
            "/api/play/results",
            json={"code": scored["code"]["code"], "player_name": PLAYER_NAME},
        ).get_json()

        verdicts = {a["question_text"]: a["is_correct"] for a in body["answers"]}
        assert verdicts["Q1 answered correctly"] is True
        assert verdicts["Q2 answered incorrectly"] is False
        assert verdicts["Q3 written, graded correct"] is True
        assert verdicts["Q4 written, awaiting grading"] is None
        # Unanswered is reported as None, exactly like Not Graded - the player
        # results payload cannot tell those two apart.
        assert verdicts["Q5 never answered"] is None

        assert "score_percent" not in body
        assert "average_score_percent" not in body


# ---------------------------------------------------------------------------
# THE CROSS-SURFACE AGREEMENT CHECK
# ---------------------------------------------------------------------------


class TestEverySurfaceAgreesOnTheSameAttempt:
    def test_all_backend_surfaces_report_the_same_score_for_one_attempt(
        self, app, client, coach_headers, scored
    ):
        """THE LOAD-BEARING TEST. One attempt, every surface that produces a
        score, all asked at once. This is what a refactor must not move."""
        from app.models import Question
        from app.services.export import (
            RESULT_CORRECT,
            RESULT_INCORRECT,
            _player_result_counts,
            _score_percent,
        )

        card = next(
            q
            for q in client.get("/api/quizzes", headers=coach_headers).get_json()
            if q["id"] == scored["quiz_id"]
        )
        profile = client.get(
            f"/api/players/{scored['player_id']}/history", headers=coach_headers
        ).get_json()
        legacy = client.get(
            f"/api/players/history?name={PLAYER_NAME}", headers=coach_headers
        ).get_json()["history"][0]

        with app.app_context():
            attempt = db.session.get(PlayerAttempt, scored["attempt_id"])
            questions = sorted(
                Question.query.filter_by(quiz_id=scored["quiz_id"]).all(), key=lambda q: q.position
            )
            counts, _ = _player_result_counts(questions, attempt)
        export_score = _score_percent(
            counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT]
        )

        assert card["average_score_percent"] == EXPECTED_SCORE_PERCENT
        assert profile["recent_results"][0]["score_percent"] == EXPECTED_SCORE_PERCENT
        assert profile["average_score_percent"] == EXPECTED_SCORE_PERCENT
        assert export_score == EXPECTED_SCORE_PERCENT

        # The two count-only surfaces must agree on the same numerator and
        # denominator even though neither divides them.
        assert (legacy["correct_answer_count"], legacy["graded_answer_count"]) == (
            EXPECTED_CORRECT,
            EXPECTED_GRADED_DENOMINATOR,
        )
        assert (counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT]) == (
            EXPECTED_CORRECT,
            EXPECTED_GRADED_DENOMINATOR,
        )


# ---------------------------------------------------------------------------
# Practice, and what it is excluded from
# ---------------------------------------------------------------------------


class TestPracticeIsExcludedEverywhere:
    def test_a_practice_attempt_changes_no_official_number(self, app, client, coach_headers, scored):
        """Practice is real and stored but never influences a grade, an
        average or an export. Characterized here so the refactor cannot
        quietly fold it in."""
        practice_code = client.post(
            f"/api/quizzes/{scored['quiz_id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        ).get_json()

        client.post(
            "/api/play/start",
            json={"access_code_id": practice_code["id"], "player_name": PLAYER_NAME},
        )
        # Every answer WRONG, so folding practice in would visibly drag the
        # average down if the filter ever broke.
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": practice_code["id"],
                "player_name": PLAYER_NAME,
                "answers": [
                    {
                        "question_id": scored["questions"]["correct"]["id"],
                        "selected_option_id": _option(scored["questions"]["correct"], False),
                        "answer_text": None,
                    },
                    {
                        "question_id": scored["questions"]["incorrect"]["id"],
                        "selected_option_id": _option(scored["questions"]["incorrect"], False),
                        "answer_text": None,
                    },
                ],
            },
        )

        card = next(
            q
            for q in client.get("/api/quizzes", headers=coach_headers).get_json()
            if q["id"] == scored["quiz_id"]
        )
        profile = client.get(
            f"/api/players/{scored['player_id']}/history", headers=coach_headers
        ).get_json()

        assert card["average_score_percent"] == EXPECTED_SCORE_PERCENT
        assert profile["average_score_percent"] == EXPECTED_SCORE_PERCENT


# ---------------------------------------------------------------------------
# Incomplete attempts
# ---------------------------------------------------------------------------


class TestPracticeFeedbackPayload:
    def test_checking_a_skipped_auto_gradable_question_reports_is_correct_none(
        self, client, coach_headers, scored
    ):
        """The input the PLAYER-FACING practice summary is built from.

        A player who skips a multiple-choice question and presses "Check
        Answer" gets `auto_gradable: True` with `is_correct: None` - no option
        was selected, so nothing was graded. Characterized because
        frontend/src/pages/play/practiceSummary.ts counts exactly this payload
        into its denominator while excluding it from its numerator, which is
        NOT `correct / (correct + incorrect)`. See the Phase 2 report.
        """
        practice_code = client.post(
            f"/api/quizzes/{scored['quiz_id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        ).get_json()
        client.post(
            "/api/play/start",
            json={"access_code_id": practice_code["id"], "player_name": PLAYER_NAME},
        )

        checked = client.post(
            "/api/play/check",
            json={
                "access_code_id": practice_code["id"],
                "player_name": PLAYER_NAME,
                "question_id": scored["questions"]["correct"]["id"],
            },
        )

        assert checked.status_code == 200, checked.get_json()
        feedback = checked.get_json()
        assert feedback["auto_gradable"] is True
        assert feedback["is_correct"] is None


class TestIncompleteAttempts:
    def test_an_in_progress_attempt_is_scored_nowhere(self, app, client, coach_headers, scored):
        """Every official reader filters on SUBMITTED. An attempt still in
        progress contributes to no average, even though its answers already
        carry is_correct."""
        other = client.post(
            "/api/players",
            json={"first_name": "Alex", "last_name": "Lee"},
            headers=coach_headers,
        ).get_json()
        added = client.post(
            f"/api/quizzes/{scored['quiz_id']}/roster/members",
            json={"player_ids": [other["id"]]},
            headers=coach_headers,
        )
        assert added.status_code == 201, added.get_json()
        code = client.post(
            f"/api/quizzes/{scored['quiz_id']}/access-codes", json={}, headers=coach_headers
        ).get_json()

        client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Alex Lee", "player_id": other["id"]},
        )
        # Answered WRONG and left in progress.
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": "Alex Lee",
                "player_id": other["id"],
                "question_id": scored["questions"]["correct"]["id"],
                "selected_option_id": _option(scored["questions"]["correct"], False),
                "answer_text": None,
            },
        )

        with app.app_context():
            in_progress = PlayerAttempt.query.filter_by(
                player_id=other["id"], status=AttemptStatus.IN_PROGRESS
            ).one()
            assert [a.is_correct for a in in_progress.answers] == [False]

        card = next(
            q
            for q in client.get("/api/quizzes", headers=coach_headers).get_json()
            if q["id"] == scored["quiz_id"]
        )
        assert card["average_score_percent"] == EXPECTED_SCORE_PERCENT

        other_profile = client.get(
            f"/api/players/{other['id']}/history", headers=coach_headers
        ).get_json()
        assert other_profile["average_score_percent"] is None
        assert other_profile["recent_results"] == []
        # The attempt still counts as ASSIGNED - only the score excludes it.
        assert other_profile["assigned_count"] == 1
        assert other_profile["completed_count"] == 0
