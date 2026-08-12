"""Competition scoring - Model D. Pure, versioned, deterministic.

THE RULE THIS MODEL EXISTS TO GUARANTEE
----------------------------------------
    MORE CORRECT ANSWERS ALWAYS OUTRANK FEWER CORRECT ANSWERS.

Not "usually", and not "in realistic rooms". Always, at every competition
length, against any combination of response speeds.

WHY A PER-QUESTION SPEED BONUS CANNOT PROMISE THAT
---------------------------------------------------
A bonus awarded per question accumulates on the SAME axis as correctness, so
speed always catches up given enough questions. Simulated over 12-player
rooms, "100 + 20/15/10/5" inverted accuracy in 1.13% of pairs at 20 questions,
and in the extreme case a player with 9/10 correct beat one with 10/10.
Shrinking the bonus only moves the failure point further out; it never removes
it. Model B was withdrawn for exactly this reason.

MODEL D: A BUDGET FOR THE WHOLE COMPETITION
--------------------------------------------
Speed is worth at most SPEED_BUDGET points across the ENTIRE competition,
however many questions it has. Since SPEED_BUDGET < BASE_POINTS:

    best possible score with X correct    = 100X + 90
    worst possible score with X+1 correct = 100(X+1) + 0 = 100X + 100

The second always exceeds the first, by at least 10, for every X and every
length. That is the whole proof, and it is arithmetic rather than statistics.

WHY THE PER-ROUND CAP IS A DIFFERENCE OF FLOORS
------------------------------------------------
The obvious `round(90 / N)` per round is WRONG and breaks the invariant. At
N=100 it gives `round(0.9) = 1` per round, so the maximum total speed is 100 -
exactly one correct answer, and the guarantee is gone at the boundary.

Allocating cumulatively instead makes the totals exact for every N:

    cap(i) = floor(B*(i+1)/N) - floor(B*i/N)

These sum to precisely B by construction (the intermediate floors telescope),
using only integers, with no rounding drift to audit. For the common lengths
the caps are uniform anyway - 18 each at 5 questions, 9 each at 10 - and where
N does not divide B they alternate by one point (4,5,4,5,... at 20).
"""

from __future__ import annotations

#: Bump when the formula changes. Stored on the session so an old competition's
#: standings stay explainable rather than being silently reinterpreted.
SCORING_VERSION = 1

#: What a correct answer is worth. Everything else is secondary to this.
BASE_POINTS = 100

#: The speed budget for an ENTIRE competition. STRICTLY LESS than BASE_POINTS -
#: that inequality IS the knowledge-first guarantee, and a test asserts it.
SPEED_BUDGET = 90

#: Share of a round's speed cap by quartile of the answering window.
#: The first entry MUST be 1.0: it is what makes the cap actually reachable,
#: and therefore what makes the budget exact rather than merely an upper bound.
QUARTILE_SHARES = (1.0, 0.7, 0.4, 0.1)

assert SPEED_BUDGET < BASE_POINTS, "speed must never be able to buy a correct answer"
assert QUARTILE_SHARES[0] == 1.0


def speed_cap(round_index: int, total_rounds: int) -> int:
    """Speed points available on one round.

    A difference of floors rather than a division, so the caps across a
    competition sum to exactly SPEED_BUDGET for any number of rounds. See the
    module docstring for why `round(90/N)` is unsafe.
    """
    if total_rounds <= 0 or round_index < 0 or round_index >= total_rounds:
        return 0
    upper = (SPEED_BUDGET * (round_index + 1)) // total_rounds
    lower = (SPEED_BUDGET * round_index) // total_rounds
    return upper - lower


def quartile_for(response_ms: int, window_ms: int) -> int:
    """Which quarter of the answering window the answer landed in (0 = first).

    An answer accepted inside the network grace has already been clamped to
    the full window by `clamp_response_ms`, so it lands in the last quartile -
    the grace protects a legitimate tap from latency, it never buys speed.
    """
    if window_ms <= 0:
        return len(QUARTILE_SHARES) - 1
    index = int((max(0, response_ms) * len(QUARTILE_SHARES)) // window_ms)
    return min(index, len(QUARTILE_SHARES) - 1)


def clamp_response_ms(response_ms: int, window_ms: int) -> int:
    """Server-measured latency, held inside [0, the question's duration].

    Clamped at both ends. Below zero is impossible unless a clock moved;
    above the window happens for answers accepted inside the grace period,
    and those must score as though they used every second available.
    """
    return max(0, min(int(response_ms), int(window_ms)))


def score_answer(*, is_correct: bool, response_ms: int, window_ms: int,
                 round_index: int, total_rounds: int) -> int:
    """Points for ONE answer. Pure: same inputs, same output, no I/O.

    A wrong answer earns nothing at all - no consolation, and in particular no
    speed points, so answering instantly and wrongly is worth exactly as much
    as not answering.
    """
    if not is_correct:
        return 0
    cap = speed_cap(round_index, total_rounds)
    clamped = clamp_response_ms(response_ms, window_ms)
    share = QUARTILE_SHARES[quartile_for(clamped, window_ms)]
    # round(), not floor(): with a top share of exactly 1.0 the cap is still
    # reachable and never exceeded, so this preserves the exact budget while
    # keeping the intermediate values whole and explainable.
    return BASE_POINTS + round(cap * share)


def max_total_speed(total_rounds: int) -> int:
    """The most speed can ever contribute across a whole competition.

    Exposed so the invariant is checkable directly rather than inferred from
    the scorer's behaviour.
    """
    return sum(speed_cap(index, total_rounds) for index in range(max(0, total_rounds)))


def next_streak(current_streak: int, is_correct: bool) -> int:
    """Streaks are PRESENTATION ONLY and are worth zero points.

    A wrong answer or a missed round resets to zero, because a streak that
    survived a gap would not be describing what the room just watched happen.
    Nothing in score_answer reads this, and a test proves that mutating streak
    values cannot change a single point.
    """
    return current_streak + 1 if is_correct else 0
