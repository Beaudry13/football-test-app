"""Which questions do not count, resolved once and applied everywhere.

THE PREDICATE, ONCE
-------------------
A question is excluded for an attempt when an exclusion row exists that is

    ACTIVE (restored_at IS NULL)
    AND for that question
    AND (quiz-wide  OR  scoped to that attempt's access code)

Five backend surfaces need that answer. If each re-derived it, the first one
that forgot `restored_at`, or that treated a quiz-wide row as assignment-scoped,
would quietly report a different score from the others - and scores that
disagree are exactly what Phase 2 existed to make impossible.

HOW EXCLUSION REACHES A SCORE
-----------------------------
It filters the INPUT. Phase 2's arithmetic is untouched:

    answers -> drop excluded -> count_answers -> score_percent

Delivered-question reporting works the same way one level up:

    delivered questions -> drop excluded -> count_delivered

**Exclusion does not need delivered-question snapshots to change a score**, and
this was measured rather than assumed. Today's denominator is graded ANSWER
ROWS, so a delivered question nobody answered is already outside it - excluding
it cannot move the number. Snapshots matter for what a report SHOWS (an
excluded question must stop being presented as an active unanswered one), not
for the percentage. That is why legacy attempts with no snapshots still score
correctly under exclusion.

ONE SPELLING LIVES ELSEWHERE, DELIBERATELY
------------------------------------------
`routes/quizzes.py` computes the quiz-card average as a pooled SQL aggregate
and must not load every answer of every attempt to divide two numbers
(measured: 19ms in SQL against 88ms in Python at 75k answers). It therefore
carries a SQL translation of the predicate above. That duplication is approved
and is held in place by the equivalence tests in
tests/test_question_exclusions.py - if you change the rule here, change it
there, and those tests are what will tell you that you forgot.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Mapping

from app.extensions import db
from app.models import Answer, QuestionExclusion


@dataclass(frozen=True)
class ExclusionSet:
    """Every active exclusion relevant to one request, resolved up front.

    Loaded once per request rather than queried per attempt: the player profile
    walks every attempt a player has made, and a per-attempt lookup would be an
    N+1 against a table that is almost always tiny.
    """

    #: question_ids excluded for EVERY assignment.
    quiz_wide: frozenset[int]
    #: access_code_id -> question_ids excluded for that assignment only.
    by_access_code: Mapping[int, frozenset[int]]

    def excludes(self, question_id: int, access_code_id: int | None) -> bool:
        """THE predicate. `access_code_id` None means "no assignment context",
        in which case only quiz-wide exclusions can apply."""
        if question_id in self.quiz_wide:
            return True
        if access_code_id is None:
            return False
        return question_id in self.by_access_code.get(access_code_id, frozenset())

    @property
    def is_empty(self) -> bool:
        """True when nothing anywhere is excluded - the overwhelmingly common
        case, which lets callers skip filtering entirely."""
        return not self.quiz_wide and not self.by_access_code

    def excluded_for(self, access_code_id: int | None) -> frozenset[int]:
        """Every question excluded for one assignment, from either scope.

        For the coach UI, which shows what is currently excluded; and for the
        overlap case, where a question is covered twice and restoring one
        exclusion must not make it count.
        """
        scoped = self.by_access_code.get(access_code_id, frozenset()) if access_code_id else frozenset()
        return self.quiz_wide | scoped

    def active_answers(self, attempt) -> list:
        """The answers that still count for this attempt. THE SCORE PATH.

        Filters, never mutates: the Answer rows stay exactly as recorded, which
        is what makes exclusion reversible and auditable. A coach restoring the
        question gets the original number back because nothing was destroyed.
        """
        if self.is_empty:
            return list(attempt.answers)
        return [
            answer
            for answer in attempt.answers
            if not self.excludes(answer.question_id, attempt.access_code_id)
        ]

    def active_questions(self, questions: Iterable, access_code_id: int | None) -> list:
        """The delivered questions that still count. THE REPORTING PATH.

        Used where a surface counts delivered questions rather than answer rows
        (the detailed PDF), so an excluded question stops being reported as an
        active unanswered one.
        """
        if self.is_empty:
            return list(questions)
        return [q for q in questions if not self.excludes(q.id, access_code_id)]


#: Nothing excluded. Callers that have no reason to load exclusions (or that
#: run before any exist) use this rather than inventing an empty instance.
NO_EXCLUSIONS = ExclusionSet(quiz_wide=frozenset(), by_access_code={})


def _build(rows: Iterable[QuestionExclusion]) -> ExclusionSet:
    quiz_wide: set[int] = set()
    by_code: dict[int, set[int]] = {}
    for row in rows:
        if row.access_code_id is None:
            quiz_wide.add(row.question_id)
        else:
            by_code.setdefault(row.access_code_id, set()).add(row.question_id)
    return ExclusionSet(
        quiz_wide=frozenset(quiz_wide),
        by_access_code={code: frozenset(ids) for code, ids in by_code.items()},
    )


def load_for_quizzes(quiz_ids: Iterable[int]) -> ExclusionSet:
    """Active exclusions for a set of quizzes, in ONE query.

    Scoped through `questions.quiz_id` rather than by question id so a caller
    with many quizzes (the dashboard) does not have to enumerate every question
    first.
    """
    from app.models import Question

    quiz_ids = list(quiz_ids)
    if not quiz_ids:
        return NO_EXCLUSIONS

    rows = (
        db.session.query(QuestionExclusion)
        .join(Question, Question.id == QuestionExclusion.question_id)
        .filter(
            Question.quiz_id.in_(quiz_ids),
            QuestionExclusion.restored_at.is_(None),
        )
        .all()
    )
    return _build(rows)


def load_for_attempts(attempts: Iterable) -> ExclusionSet:
    """Active exclusions relevant to a set of already-loaded attempts.

    The player profile and the legacy history hold attempts spanning several
    quizzes, so this derives the quiz set from them rather than making each
    caller do it.
    """
    return load_for_quizzes({attempt.quiz_id for attempt in attempts})


def active_exclusions_for_quiz(quiz_id: int) -> list[QuestionExclusion]:
    """Every ACTIVE exclusion on this quiz, newest first, for the coach UI.

    Returns rows rather than an ExclusionSet because the UI has to show scope,
    author, reason and timestamps - and because a question covered by BOTH a
    quiz-wide and an assignment exclusion must be shown as two facts, not one
    boolean. Collapsing them is how a coach would press Restore, see the
    question still excluded, and conclude the button is broken.
    """
    from app.models import Question

    return (
        db.session.query(QuestionExclusion)
        .join(Question, Question.id == QuestionExclusion.question_id)
        .filter(Question.quiz_id == quiz_id, QuestionExclusion.restored_at.is_(None))
        .order_by(QuestionExclusion.excluded_at.desc())
        .all()
    )


def restore(exclusion: QuestionExclusion) -> QuestionExclusion:
    """Put a question back into scoring. Does NOT delete the row.

    Idempotent: restoring an already-restored exclusion leaves the original
    timestamp alone, so the record stays "when it was first put back" rather
    than moving every time somebody double-clicks.
    """
    if exclusion.restored_at is None:
        exclusion.restored_at = datetime.now(timezone.utc)
    return exclusion


# ---------------------------------------------------------------------------
# The SQL spelling
# ---------------------------------------------------------------------------


def sql_not_excluded(attempt_alias, answer_alias):
    """`NOT EXISTS (...)` matching `ExclusionSet.excludes`, for pooled SQL.

    The one place the predicate is expressed twice. Written here, next to the
    Python it must agree with, rather than inline in routes/quizzes.py - so the
    two spellings are read together and the equivalence tests have an obvious
    home.

    Reads as: no ACTIVE exclusion of this answer's question that is either
    quiz-wide or scoped to this attempt's assignment.
    """
    return ~db.session.query(QuestionExclusion).filter(
        QuestionExclusion.question_id == answer_alias.question_id,
        QuestionExclusion.restored_at.is_(None),
        db.or_(
            QuestionExclusion.access_code_id.is_(None),
            QuestionExclusion.access_code_id == attempt_alias.access_code_id,
        ),
    ).exists()


def excluded_answer_ids(attempt) -> set[int]:
    """Answer ids dropped from scoring for this attempt, for explainability.

    Not used by any scoring path - the score filters objects directly. This
    exists so a surface can say WHICH answers stopped counting without
    re-deriving the rule.
    """
    exclusions = load_for_quizzes([attempt.quiz_id])
    return {
        answer.id
        for answer in attempt.answers
        if exclusions.excludes(answer.question_id, attempt.access_code_id)
    }
