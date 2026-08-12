"""Model D scoring - pure unit tests and the knowledge-first invariant.

THE INVARIANT THESE EXIST TO DEFEND
------------------------------------
    MORE CORRECT ANSWERS ALWAYS OUTRANK FEWER CORRECT ANSWERS.

Not statistically, and not at the lengths we happen to run today. Always.
TestKnowledgeFirstInvariant proves it by construction across eight competition
lengths, and TestSpeedBudget proves the arithmetic it rests on.

No database, no app context - the scorer is pure, so these are fast enough to
run on every change.
"""

import pytest

from app.services import competition_scoring as scoring

LENGTHS = (1, 2, 3, 5, 10, 20, 40, 100)


class TestSpeedBudget:
    """The whole guarantee reduces to: total speed < one correct answer."""

    @pytest.mark.parametrize("total_rounds", LENGTHS)
    def test_total_speed_is_under_one_correct_answer(self, total_rounds):
        assert scoring.max_total_speed(total_rounds) < scoring.BASE_POINTS

    @pytest.mark.parametrize("total_rounds", LENGTHS)
    def test_total_speed_is_exactly_the_budget(self, total_rounds):
        """Exactly 90 at EVERY length - the reason caps are a difference of
        floors rather than a rounded division.

        `round(90/N)` gives 1 per round at N=100, so the maximum total would be
        100 - equal to a correct answer, and the guarantee would be gone at
        precisely the boundary it exists to defend.
        """
        assert scoring.max_total_speed(total_rounds) == scoring.SPEED_BUDGET

    @pytest.mark.parametrize("total_rounds", LENGTHS)
    def test_no_round_can_exceed_its_cap(self, total_rounds):
        window = 20_000
        for round_index in range(min(total_rounds, 12)):
            cap = scoring.speed_cap(round_index, total_rounds)
            fastest = scoring.score_answer(
                is_correct=True, response_ms=0, window_ms=window,
                round_index=round_index, total_rounds=total_rounds,
            )
            assert fastest == scoring.BASE_POINTS + cap

    def test_the_familiar_ten_question_shape_is_preserved(self):
        """The approved 9/6/4/1 display still falls out at ten questions."""
        window = 20_000
        got = [
            scoring.score_answer(
                is_correct=True, response_ms=ms, window_ms=window,
                round_index=0, total_rounds=10,
            ) - scoring.BASE_POINTS
            for ms in (0, 6_000, 11_000, 18_000)
        ]
        assert got == [9, 6, 4, 1]

    def test_out_of_range_rounds_earn_no_speed(self):
        assert scoring.speed_cap(-1, 10) == 0
        assert scoring.speed_cap(10, 10) == 0
        assert scoring.speed_cap(0, 0) == 0


class TestKnowledgeFirstInvariant:
    """A player who knows more finishes higher. Full stop."""

    @pytest.mark.parametrize("total_rounds", LENGTHS)
    @pytest.mark.parametrize("gap", (1, 2))
    def test_one_more_correct_beats_any_speed_advantage(self, total_rounds, gap):
        """The extreme case: the better player is ALWAYS slowest, the worse
        player ALWAYS instant."""
        if total_rounds <= gap:
            pytest.skip("needs more rounds than the accuracy gap")
        window = 20_000

        # Knows more, answers at the last possible moment every time.
        slow_expert = sum(
            scoring.score_answer(
                is_correct=True, response_ms=window, window_ms=window,
                round_index=index, total_rounds=total_rounds,
            )
            for index in range(total_rounds)
        )
        # Knows less, answers instantly every time.
        fast_guesser = sum(
            scoring.score_answer(
                is_correct=index < total_rounds - gap, response_ms=0, window_ms=window,
                round_index=index, total_rounds=total_rounds,
            )
            for index in range(total_rounds)
        )

        assert slow_expert > fast_guesser, (
            f"{total_rounds} rounds, gap {gap}: speed overtook knowledge "
            f"({fast_guesser} vs {slow_expert})"
        )

    @pytest.mark.parametrize("total_rounds", LENGTHS)
    def test_the_margin_is_at_least_ten(self, total_rounds):
        """100 base minus a 90 budget leaves 10 points of headroom, whatever
        the length."""
        window = 20_000
        expert = sum(
            scoring.score_answer(
                is_correct=True, response_ms=window, window_ms=window,
                round_index=i, total_rounds=total_rounds,
            )
            for i in range(total_rounds)
        )
        guesser = sum(
            scoring.score_answer(
                is_correct=i < total_rounds - 1, response_ms=0, window_ms=window,
                round_index=i, total_rounds=total_rounds,
            )
            for i in range(total_rounds)
        )
        assert expert - guesser >= 10


class TestScoreAnswer:
    """Table-driven behaviour of a single answer."""

    @pytest.mark.parametrize(
        "response_ms,expected_bonus",
        [
            (0, 9),        # instant - first quartile
            (4_999, 9),    # still first quartile
            (5_000, 6),    # second
            (9_999, 6),
            (10_000, 4),   # third
            (14_999, 4),
            (15_000, 1),   # fourth
            (19_999, 1),
            (20_000, 1),   # exactly at the deadline
        ],
    )
    def test_quartile_boundaries(self, response_ms, expected_bonus):
        assert scoring.score_answer(
            is_correct=True, response_ms=response_ms, window_ms=20_000,
            round_index=0, total_rounds=10,
        ) == scoring.BASE_POINTS + expected_bonus

    @pytest.mark.parametrize("response_ms", (0, 5_000, 19_999, 25_000))
    def test_a_wrong_answer_earns_nothing_however_fast(self, response_ms):
        """Instant and wrong is worth exactly as much as never answering."""
        assert scoring.score_answer(
            is_correct=False, response_ms=response_ms, window_ms=20_000,
            round_index=0, total_rounds=10,
        ) == 0

    def test_an_answer_inside_the_grace_scores_as_the_slowest(self):
        """The grace buys inclusion, never points."""
        clamped = scoring.clamp_response_ms(20_600, 20_000)
        assert clamped == 20_000
        assert scoring.score_answer(
            is_correct=True, response_ms=20_600, window_ms=20_000,
            round_index=0, total_rounds=10,
        ) == scoring.BASE_POINTS + 1

    def test_response_ms_is_clamped_at_both_ends(self):
        assert scoring.clamp_response_ms(-500, 20_000) == 0
        assert scoring.clamp_response_ms(999_999, 20_000) == 20_000

    def test_scoring_is_deterministic(self):
        args = dict(is_correct=True, response_ms=3_210, window_ms=20_000,
                    round_index=2, total_rounds=10)
        assert len({scoring.score_answer(**args) for _ in range(50)}) == 1


class TestStreaksDoNotScore:
    def test_streak_advances_on_correct_and_resets_on_wrong(self):
        assert scoring.next_streak(0, True) == 1
        assert scoring.next_streak(3, True) == 4
        assert scoring.next_streak(7, False) == 0

    def test_no_streak_value_can_change_a_score(self):
        """THE invariant: streaks are presentation, and score_answer has no
        parameter through which one could leak in."""
        import inspect

        signature = inspect.signature(scoring.score_answer)
        assert "streak" not in " ".join(signature.parameters)

        baseline = scoring.score_answer(
            is_correct=True, response_ms=1_000, window_ms=20_000,
            round_index=0, total_rounds=10,
        )
        for streak in range(0, 50):
            scoring.next_streak(streak, True)
            assert scoring.score_answer(
                is_correct=True, response_ms=1_000, window_ms=20_000,
                round_index=0, total_rounds=10,
            ) == baseline
