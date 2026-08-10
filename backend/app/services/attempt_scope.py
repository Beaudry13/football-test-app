"""Which attempts count toward official performance.

THE RULE, ONCE
--------------
An attempt counts officially when its mode is GRADED. Practice attempts are
real, stored, and queryable - they simply never influence a grade, an average,
a completion rate, a grading queue, or an export.

WHY THIS IS A FILE AND NOT AN `if` IN TWENTY PLACES
---------------------------------------------------
Eight modules read PlayerAttempt for reporting. If each applied its own mode
filter, the first one anybody forgot would silently fold practice scores into
a player's cumulative grade - and nothing would look broken. A coach would
just see a number that was quietly wrong.

So every official reader goes through `official_only`, and a guard test fails
if a new analytics query appears that does not (see tests/test_practice_mode).

WHAT IS DELIBERATELY *NOT* HERE
-------------------------------
Onboarding's "have your first player complete a quiz" milestone counts
practice too, on purpose: it measures whether the product is being used, not
how anybody performed. It reads attempts WITHOUT this filter, and that is the
one intentional exception - documented at the call site rather than hidden as
an oversight.
"""

from __future__ import annotations

from app.models.assessment_mode import GRADED


def official_only(query):
    """Restrict an attempt query to those that count toward performance.

    Takes and returns a query so it composes with whatever else the caller is
    filtering on, rather than dictating the shape of their query.
    """
    from app.models import PlayerAttempt

    return query.filter(PlayerAttempt.mode == GRADED)


def official_filter():
    """The same rule as a bare criterion, for callers building a filter list
    rather than chaining onto a query."""
    from app.models import PlayerAttempt

    return PlayerAttempt.mode == GRADED


def is_official(attempt) -> bool:
    """Whether one already-loaded attempt counts officially.

    For code that holds objects rather than a query - the exporters, mostly,
    which are handed a list and must not re-query.
    """
    return attempt.mode == GRADED


def official_attempts(attempts: list) -> list:
    """The subset of an in-memory list that counts officially."""
    return [attempt for attempt in attempts if is_official(attempt)]
