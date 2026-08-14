"""The ordinary Peira scoring rule, in one place.

THE RULE
--------
    score = correct / (correct + incorrect)

`correct` is `answers.is_correct is True`, `incorrect` is `is_correct is False`.
NOT GRADED (a row exists, `is_correct` is None) and UNANSWERED (no row at all)
are in NEITHER the numerator NOR the denominator, and a score is `None` - never
0% - when nothing has been graded. A player is not marked wrong because their
coach has not read their answer yet, and a brand-new quiz does not report that
everybody failed it.

WHY THIS FILE EXISTS
--------------------
The same arithmetic was written out in four places (`routes/quizzes.py`,
`routes/players.py` twice, `services/export.py`) and the classification behind
it in two more. They all agreed - a characterization suite proves they agreed
on the same attempt before this module existed - but agreeing by coincidence is
not the same as agreeing by construction. "Don't count this question" changes
the DENOMINATOR, and a change to a denominator that lives in six places is a
change that will land in five of them.

Two module docstrings previously claimed this rule was "defined identically in
services/player_analytics.py". That file has never existed on master - it lives
only on an abandoned branch. This module is the real second half those comments
were reaching for.

WHAT THIS MODULE IS NOT
-----------------------
It is not a home for everything that mentions correctness. Display labels (the
PDF's "Not Graded", the CSV's "Ungraded"/"No answer") stay with the exporter
that renders them; this module supplies the OUTCOME, and each surface names it
in its own vocabulary. Completion rate and response rate are different
measurements that merely share the shape `round(100 * a / b, 1)` - folding them
in here would mean a later change to scoring silently moved them too.

PHASE 3 NOTE (not implemented, deliberately)
--------------------------------------------
`count_delivered` takes the delivered questions as an ARGUMENT rather than
deriving them, so excluding a question later is a change to what is passed in,
not a change to the arithmetic. `unanswered` is carried alongside the graded
counts for the same reason: exclusion has to be able to talk about a question
nobody answered. Nothing here reads `attempt_question_snapshots`, and today's
denominator is unchanged - see `ScoreCounts.scored_total`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Outcome(str, Enum):
    """What one delivered question came to, for one attempt.

    The SEMANTIC four-way split. Callers map these onto whatever words they
    show a coach - the detailed PDF says "Not Graded", the CSV says
    "Ungraded" - so the wording can differ per surface while the decision
    behind it cannot.
    """

    CORRECT = "correct"
    INCORRECT = "incorrect"
    #: An answer exists but carries no grade yet. Never scored as wrong.
    NOT_GRADED = "not_graded"
    #: No Answer row at all. Distinct from NOT_GRADED, which means the player
    #: did answer and is waiting on a coach.
    UNANSWERED = "unanswered"


def classify(answer) -> Outcome:
    """The one place an answer's outcome is decided. `None` means no row."""
    if answer is None:
        return Outcome.UNANSWERED
    if answer.is_correct is None:
        return Outcome.NOT_GRADED
    return Outcome.CORRECT if answer.is_correct else Outcome.INCORRECT


def score_percent(correct: int, scored_total: int) -> float | None:
    """`correct / scored_total` as a percentage to one decimal place.

    Returns None - NOT 0.0 - when `scored_total` is zero. Every caller relies
    on that distinction to avoid publishing a fabricated 0%.
    """
    return round(100 * correct / scored_total, 1) if scored_total else None


@dataclass(frozen=True)
class ScoreCounts:
    """The four counts every scoring surface is derived from.

    `unanswered` is `int | None`, and None means NOT MEASURED rather than zero.
    Counting from Answer rows alone genuinely cannot know how many questions
    were delivered and skipped - only a caller that also holds the delivered
    question list can. Reporting 0 there would be a lie that a later reader
    (Phase 3, which must count skipped questions) would have no way to detect.
    """

    correct: int
    incorrect: int
    not_graded: int
    unanswered: int | None

    @property
    def scored_total(self) -> int:
        """THE DENOMINATOR: correct + incorrect.

        Deliberately excludes `not_graded` and `unanswered`. This is the single
        definition Phase 3 will need to revisit when exclusions arrive; today it
        is exactly what every existing surface already computed.
        """
        return self.correct + self.incorrect

    @property
    def percent(self) -> float | None:
        return score_percent(self.correct, self.scored_total)

    def __add__(self, other: "ScoreCounts") -> "ScoreCounts":
        """Pool two sets of counts, for a cumulative average across attempts.

        Pooled, NOT averaged-of-averages: a 10-question attempt and a
        2-question attempt do not carry equal weight. That is what the existing
        cumulative figures already did, and this preserves it.

        `unanswered` stays None if EITHER side is unmeasured - a partial count
        would read as a real one.
        """
        if not isinstance(other, ScoreCounts):
            return NotImplemented
        if self.unanswered is None or other.unanswered is None:
            unanswered = None
        else:
            unanswered = self.unanswered + other.unanswered
        return ScoreCounts(
            correct=self.correct + other.correct,
            incorrect=self.incorrect + other.incorrect,
            not_graded=self.not_graded + other.not_graded,
            unanswered=unanswered,
        )

    __radd__ = __add__


#: Identity for `sum(...)`. `unanswered=0` rather than None so it does not
#: poison a pool of measured counts, while still yielding None the moment an
#: unmeasured one joins.
NO_COUNTS = ScoreCounts(correct=0, incorrect=0, not_graded=0, unanswered=0)


def count_answers(answers) -> ScoreCounts:
    """Counts from ANSWER ROWS ALONE.

    `unanswered` is None: this input cannot distinguish "the quiz had five
    questions and two were skipped" from "the quiz had three questions". Use
    `count_delivered` where the delivered set is known.

    This is what the quiz-card average, the player profile and the legacy
    name-matched history have always counted, and it is why none of them can
    report an unanswered figure today.
    """
    counts = {outcome: 0 for outcome in Outcome}
    for answer in answers:
        counts[classify(answer)] += 1
    return ScoreCounts(
        correct=counts[Outcome.CORRECT],
        incorrect=counts[Outcome.INCORRECT],
        not_graded=counts[Outcome.NOT_GRADED],
        unanswered=None,
    )


def count_delivered(questions, answers_by_question: dict) -> ScoreCounts:
    """Counts over the DELIVERED QUESTIONS, so skipped ones are visible.

    `questions` is what the attempt is being measured against and is passed in
    rather than derived - which is the seam Phase 3 needs, since excluding a
    question is then a change to this argument and not to the arithmetic below.

    Only the detailed results PDF counts this way today. It changes no score:
    UNANSWERED lands outside `scored_total` exactly as an absent Answer row
    already did.
    """
    counts = {outcome: 0 for outcome in Outcome}
    for question in questions:
        counts[classify(answers_by_question.get(question.id))] += 1
    return ScoreCounts(
        correct=counts[Outcome.CORRECT],
        incorrect=counts[Outcome.INCORRECT],
        not_graded=counts[Outcome.NOT_GRADED],
        unanswered=counts[Outcome.UNANSWERED],
    )


def pending_grading_count(answers) -> int:
    """Answers actually waiting on a COACH, which is not the same as ungraded.

    An auto-gradable question can sit at `is_correct is None` too - a
    multiple-choice question the player opened and left blank has an Answer row
    and no grade - and counting those would tell a coach they have work queued
    that they cannot do anything about.

    Separate from `ScoreCounts` on purpose: it needs each answer's QUESTION
    TYPE, it drives a grading-queue badge rather than a score, and it is not in
    any denominator. It lives here because the identical comprehension was
    written out in both routes/players.py and routes/grading.py.
    """
    from app.models.question import MANUALLY_GRADED_TYPES

    return sum(
        1
        for answer in answers
        if answer.is_correct is None and answer.question.question_type in MANUALLY_GRADED_TYPES
    )
