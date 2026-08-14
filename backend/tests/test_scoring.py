"""Unit tests for the shared scoring rule (services/scoring.py).

These test the HELPER. The surfaces that consume it are pinned separately by
tests/test_scoring_characterization.py, which was written before the helper
existed and must never be relaxed to accommodate it.
"""

import pytest

from app.services.scoring import (
    NO_COUNTS,
    Outcome,
    ScoreCounts,
    classify,
    count_answers,
    count_delivered,
    pending_grading_count,
    score_percent,
)


class FakeAnswer:
    """Just enough Answer to exercise the rule without a database."""

    def __init__(self, is_correct=None, question_id=None, question_type=None):
        self.is_correct = is_correct
        self.question_id = question_id
        self.question = type("Q", (), {"question_type": question_type})()


class FakeQuestion:
    def __init__(self, id):
        self.id = id


# ---------------------------------------------------------------------------
# classify
# ---------------------------------------------------------------------------


class TestClassify:
    def test_the_four_outcomes(self):
        assert classify(FakeAnswer(is_correct=True)) is Outcome.CORRECT
        assert classify(FakeAnswer(is_correct=False)) is Outcome.INCORRECT
        assert classify(FakeAnswer(is_correct=None)) is Outcome.NOT_GRADED
        assert classify(None) is Outcome.UNANSWERED

    def test_not_graded_and_unanswered_are_not_the_same_thing(self):
        """A row with no grade means the player answered and is waiting on a
        coach. No row means they never answered. Collapsing the two is how an
        unanswered question would start looking like a grading task."""
        assert classify(FakeAnswer(is_correct=None)) is not classify(None)


# ---------------------------------------------------------------------------
# score_percent - the formula
# ---------------------------------------------------------------------------


class TestScorePercent:
    def test_it_returns_none_rather_than_zero_when_nothing_is_graded(self):
        """The distinction the whole rule turns on: 'no score yet' is not 0%."""
        assert score_percent(0, 0) is None

    def test_a_real_zero_is_still_zero(self):
        """Graded and all wrong IS 0% - only an empty denominator is None."""
        assert score_percent(0, 5) == 0.0

    @pytest.mark.parametrize(
        "correct,total,expected",
        [(1, 1, 100.0), (1, 2, 50.0), (2, 3, 66.7), (1, 3, 33.3), (5, 8, 62.5)],
    )
    def test_it_rounds_to_one_decimal(self, correct, total, expected):
        assert score_percent(correct, total) == expected


# ---------------------------------------------------------------------------
# count_answers - from answer rows alone
# ---------------------------------------------------------------------------


class TestCountAnswers:
    def test_it_counts_the_three_knowable_outcomes(self):
        counts = count_answers(
            [
                FakeAnswer(is_correct=True),
                FakeAnswer(is_correct=True),
                FakeAnswer(is_correct=False),
                FakeAnswer(is_correct=None),
            ]
        )
        assert (counts.correct, counts.incorrect, counts.not_graded) == (2, 1, 1)

    def test_unanswered_is_none_because_it_cannot_be_known_from_rows(self):
        """NOT zero. Answer rows cannot distinguish 'five questions, two
        skipped' from 'three questions'. Reporting 0 would be a lie a later
        reader has no way to detect."""
        assert count_answers([FakeAnswer(is_correct=True)]).unanswered is None

    def test_the_denominator_excludes_ungraded(self):
        counts = count_answers([FakeAnswer(is_correct=True), FakeAnswer(is_correct=None)])
        assert counts.scored_total == 1
        assert counts.percent == 100.0

    def test_no_answers_at_all_scores_none(self):
        counts = count_answers([])
        assert counts.scored_total == 0
        assert counts.percent is None


# ---------------------------------------------------------------------------
# count_delivered - the only form that can see a skipped question
# ---------------------------------------------------------------------------


class TestCountDelivered:
    def test_a_delivered_question_with_no_answer_is_unanswered(self):
        questions = [FakeQuestion(1), FakeQuestion(2), FakeQuestion(3)]
        answers = {1: FakeAnswer(is_correct=True), 2: FakeAnswer(is_correct=False)}

        counts = count_delivered(questions, answers)

        assert (counts.correct, counts.incorrect, counts.not_graded) == (1, 1, 0)
        assert counts.unanswered == 1

    def test_unanswered_stays_out_of_the_denominator(self):
        """THE PHASE 2 INVARIANT. Seeing unanswered questions must not start
        counting them - the score is identical either way."""
        questions = [FakeQuestion(1), FakeQuestion(2), FakeQuestion(3)]
        answers = {1: FakeAnswer(is_correct=True), 2: FakeAnswer(is_correct=False)}

        delivered = count_delivered(questions, answers)
        from_rows = count_answers(list(answers.values()))

        assert delivered.scored_total == from_rows.scored_total == 2
        assert delivered.percent == from_rows.percent == 50.0

    def test_an_answer_for_a_question_not_delivered_is_ignored(self):
        """The delivered list decides what is measured - which is the seam a
        later exclusion feature would use."""
        counts = count_delivered(
            [FakeQuestion(1)], {1: FakeAnswer(is_correct=True), 99: FakeAnswer(is_correct=False)}
        )
        assert counts.scored_total == 1
        assert counts.percent == 100.0


# ---------------------------------------------------------------------------
# Pooling
# ---------------------------------------------------------------------------


class TestPooling:
    def test_counts_add(self):
        a = ScoreCounts(correct=2, incorrect=1, not_graded=1, unanswered=1)
        b = ScoreCounts(correct=1, incorrect=3, not_graded=0, unanswered=2)

        assert a + b == ScoreCounts(correct=3, incorrect=4, not_graded=1, unanswered=3)

    def test_pooling_weights_by_question_count_not_by_attempt(self):
        """A cumulative average is POOLED, not an average of percentages. Nine
        right out of ten and none out of one is 9/11, not the 45% an
        average-of-averages would report."""
        big = ScoreCounts(correct=9, incorrect=1, not_graded=0, unanswered=0)
        small = ScoreCounts(correct=0, incorrect=1, not_graded=0, unanswered=0)

        assert (big + small).percent == 81.8
        assert round((big.percent + small.percent) / 2, 1) == 45.0

    def test_an_unmeasured_unanswered_poisons_the_pool(self):
        measured = ScoreCounts(correct=1, incorrect=0, not_graded=0, unanswered=4)
        unmeasured = count_answers([FakeAnswer(is_correct=True)])

        assert (measured + unmeasured).unanswered is None

    def test_no_counts_is_the_identity_for_sum(self):
        counts = [
            ScoreCounts(correct=1, incorrect=1, not_graded=0, unanswered=0),
            ScoreCounts(correct=2, incorrect=0, not_graded=1, unanswered=3),
        ]
        assert sum(counts, NO_COUNTS) == ScoreCounts(
            correct=3, incorrect=1, not_graded=1, unanswered=3
        )

    def test_summing_nothing_scores_none(self):
        assert sum([], NO_COUNTS).percent is None


# ---------------------------------------------------------------------------
# pending_grading_count - deliberately NOT part of the score
# ---------------------------------------------------------------------------


class TestPendingGradingCount:
    def test_only_manually_graded_types_are_pending(self):
        """An auto-gradable question left blank has a row and no grade, but no
        coach can do anything about it - counting it would queue work that
        does not exist."""
        from app.models import QuestionType

        answers = [
            FakeAnswer(is_correct=None, question_type=QuestionType.WRITTEN),
            FakeAnswer(is_correct=None, question_type=QuestionType.DRAW_RESPONSE),
            FakeAnswer(is_correct=None, question_type=QuestionType.MULTIPLE_CHOICE),
            FakeAnswer(is_correct=None, question_type=QuestionType.FILL_BLANK),
        ]

        assert pending_grading_count(answers) == 2

    def test_an_already_graded_written_answer_is_not_pending(self):
        from app.models import QuestionType

        answers = [FakeAnswer(is_correct=True, question_type=QuestionType.WRITTEN)]
        assert pending_grading_count(answers) == 0

    def test_it_is_not_the_same_as_not_graded(self):
        """not_graded counts every ungraded row; pending counts only the ones
        a coach owes. A blank multiple choice is the case that separates
        them."""
        from app.models import QuestionType

        answers = [FakeAnswer(is_correct=None, question_type=QuestionType.MULTIPLE_CHOICE)]

        assert count_answers(answers).not_graded == 1
        assert pending_grading_count(answers) == 0
