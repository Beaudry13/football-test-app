"""How one participant is recognised across attempts, quizzes and rounds.

THIS EXISTS BECAUSE AN ATTEMPT IS NOT A PERSON. Attempt uniqueness is scoped
to an ACCESS CODE (see the partial indexes on PlayerAttempt), and one quiz can
hold many codes - a coach who activates the same quiz for Tuesday and Thursday
mints two. So the same player can hold several official, submitted attempts on
one quiz, and anything that keys analysis on `attempt.id` counts them twice.

Measured, not assumed: one canonical player taking one quiz through two codes
produced two rows in "Who missed it" for one human, and doubled that concept's
graded and incorrect counts.

CANONICAL IDENTITY IS PREFERRED AND NAMES ARE NEVER USED TO MATCH ONE.
A canonical player is keyed by player_id, so renaming them changes nothing and
two players who share a display name stay distinct.

A free-text participant has no Player row, so a name is all there is. That path
is kept STRUCTURALLY SEPARATE - a legacy key can never equal a canonical one
even when the strings match, because "Jalen Reed typed into a phone" and "the
Player row called Jalen Reed" are not known to be the same person. Merging them
on a string is exactly the guess this refuses to make.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PlayerKey:
    """A stable identity for one participant."""

    player_id: int | None
    #: Only meaningful when player_id is None. Casefolded for comparison.
    legacy_name: str | None

    @classmethod
    def of(cls, attempt) -> PlayerKey:
        if attempt.player_id is not None:
            return cls(player_id=attempt.player_id, legacy_name=None)
        return cls(player_id=None, legacy_name=(attempt.player_name or "").strip().casefold())

    @classmethod
    def of_roster_entry(cls, entry) -> PlayerKey:
        if entry.player_id is not None:
            return cls(player_id=entry.player_id, legacy_name=None)
        return cls(player_id=None, legacy_name=(entry.player_name or "").strip().casefold())

    @property
    def is_canonical(self) -> bool:
        return self.player_id is not None


def _recency(attempt):
    """Sort key: most recently submitted first, id as the tie-break.

    The id decides ties rather than leaving them to the database's row order,
    which is what made verification's choice of attempt vary between page
    loads. `submitted_at` can genuinely tie - two attempts written in the same
    transaction - and can be None on an attempt still underway, which sorts
    last rather than raising.
    """
    return (attempt.submitted_at is not None, attempt.submitted_at, attempt.id)


def representative_attempts(attempts) -> dict[PlayerKey, object]:
    """One attempt per participant: their MOST RECENT official submission.

    WHICH ATTEMPT SPEAKS FOR A PLAYER IS A PRODUCT DECISION, not a tie-break.
    A player who missed a concept in Tuesday's code and got it right in
    Thursday's does not still need that lesson, so the latest attempt wins and
    the earlier one stops contributing to "who needs coaching". Taking the
    union of every attempt's misses would instead make a player permanently
    guilty of their worst day.

    Deterministic by construction - see `_recency`.
    """
    by_key: dict[PlayerKey, object] = {}
    for attempt in sorted(attempts, key=_recency, reverse=True):
        by_key.setdefault(PlayerKey.of(attempt), attempt)
    return by_key
