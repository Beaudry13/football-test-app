"""Did the result improve?

NOT "did the player learn it". Peira reports an observation - these players
were wrong before, here is what happened when they were asked again - and the
coach decides what it means. One correct answer on a copied question is a
second data point, not proof of knowledge, and the vocabulary here is chosen so
that no surface built on it can quietly claim otherwise.

THE TWO POPULATIONS ARE NOT THE SAME, AND THIS IS THE WHOLE DIFFICULTY.
The first check may have gone to twenty-two players; the retest went to the six
who missed. "6 of 22 missed" and "2 of 6 missed" are true statements about
different groups, and putting them side by side as though the percentages were
comparable is the single most misleading thing this feature could do. So the
comparison is PLAYER-LEVEL and closed over the targeted group: of the players
this retest was built for, what happened to each one. The team-wide figure is
returned separately, labelled as context, and never divided into anything.

WHICH CONCEPT EACH ROUND TESTED
-------------------------------
The delivered snapshot is the source of truth where it exists: it records the
concept a question carried when a player actually received it, so a coach
retagging a question in November cannot rewrite what September's round was
about.

It does not always exist. Concept tagging shipped after every attempt already
in Peira, so those attempts carry v1 snapshots with no concept at all -
measured, not assumed: every snapshot row in the development database is v1 and
carries none. A strict snapshot-only rule would make this feature blank on all
existing data and only begin working for quizzes run from today.

So: the snapshot's concept wins wherever it was recorded, and the question's
current tag is a COMPATIBILITY FALLBACK for deliveries that predate the field -
exactly the rule `delivered_questions` already follows for legacy attempts with
no snapshot at all. `concept_source` on the result says which was used, so a
caller can tell a historical fact from a fallback rather than guessing.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.models import AttemptQuestionSnapshot, AttemptStatus, PlayerAttempt
from app.services.attempt_scope import official_only

#: What happened to one targeted player on the retest. Deliberately four
#: states, never three: an ungraded answer is not a miss, and a player who did
#: not sit the retest has not failed it. Collapsing either into "incorrect"
#: would turn a coach's own grading backlog, or a player's absence, into
#: evidence about what the team knows.
CORRECT = "correct"
INCORRECT = "incorrect"
UNGRADED = "ungraded"
NOT_SUBMITTED = "not_submitted"


@dataclass(frozen=True)
class PlayerKey:
    """How one participant is recognised across two rounds.

    CANONICAL IDENTITY IS PREFERRED AND NAMES ARE NEVER USED TO MATCH ONE.
    A canonical player is matched by player_id, so renaming them between rounds
    changes nothing, and two players who share a display name stay distinct.

    A free-text participant has no Player row, so a name is all there is. That
    path is kept explicitly separate - a legacy key can never equal a canonical
    one, even when the strings match, because "Jalen Reed typed into a phone"
    and "the Player row called Jalen Reed" are not known to be the same person.
    Merging them on a string is exactly the guess this refuses to make.
    """

    player_id: int | None
    #: Only meaningful when player_id is None. Casefolded for comparison.
    legacy_name: str | None

    @classmethod
    def of(cls, attempt: PlayerAttempt) -> PlayerKey:
        if attempt.player_id is not None:
            return cls(player_id=attempt.player_id, legacy_name=None)
        return cls(player_id=None, legacy_name=attempt.player_name.strip().casefold())

    @property
    def is_canonical(self) -> bool:
        return self.player_id is not None


def _concept_of_delivered(snapshot_rows, question_id: int) -> dict | None:
    row = snapshot_rows.get(question_id)
    if row is None:
        return None
    return (row.snapshot or {}).get("concept")


def _rounds_concept_ids(quiz, attempts) -> tuple[set[int], str]:
    """Which concept ids this round actually tested, and where that came from.

    Returns ("snapshot") when at least one delivered snapshot named a concept,
    and ("live_fallback") when none did and the questions' current tags had to
    stand in. The distinction travels to the caller so a fallback is never
    presented as recorded history.
    """
    delivered: set[int] = set()
    for attempt in attempts:
        for row in attempt.question_snapshots:
            concept = (row.snapshot or {}).get("concept")
            if concept and concept.get("id") is not None:
                delivered.add(concept["id"])
    if delivered:
        return delivered, "snapshot"
    return {q.concept_id for q in quiz.questions if q.concept_id is not None}, "live_fallback"


def _outcome_for(attempt: PlayerAttempt | None, question_ids: set[int]) -> str:
    """One player's outcome on one round, over the questions that count.

    A single graded-incorrect answer makes the round incorrect; otherwise a
    single graded-correct answer makes it correct; otherwise an existing but
    ungraded answer makes it ungraded. No answer at all, or no attempt, is
    NOT_SUBMITTED. The order matters: a player who got one of three questions
    wrong has still missed the concept, and saying otherwise would let a
    partially-correct round read as a clean one.
    """
    if attempt is None or attempt.status != AttemptStatus.SUBMITTED:
        return NOT_SUBMITTED

    saw_correct = False
    saw_ungraded = False
    for answer in attempt.answers:
        if answer.question_id not in question_ids:
            continue
        if answer.is_correct is False:
            return INCORRECT
        if answer.is_correct is True:
            saw_correct = True
        else:
            saw_ungraded = True

    if saw_correct and not saw_ungraded:
        return CORRECT
    if saw_ungraded:
        return UNGRADED
    if saw_correct:
        return CORRECT
    return NOT_SUBMITTED


def _official_attempts(quiz):
    return (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id)
        .all()
    )


def verification_for(retest) -> dict | None:
    """Compare a retest against the quiz it was built from.

    None when this quiz is not a retest, which is the caller's signal to render
    nothing at all rather than an empty card.
    """
    parent = retest.retest_of
    if parent is None:
        return None

    retest_attempts = _official_attempts(retest)
    parent_attempts = _official_attempts(parent)

    concept_ids, concept_source = _rounds_concept_ids(retest, retest_attempts)
    if not concept_ids:
        return None

    retest_qs = {q.id for q in retest.questions if q.concept_id in concept_ids}
    # The parent is matched on the SAME concept, not on question identity. A
    # copied question may have been reworded before sending, and v1 measures
    # another observation on the same idea rather than a controlled re-run of
    # an identical item - see the module docstring in retests.py.
    parent_qs = {q.id for q in parent.questions if q.concept_id in concept_ids}

    parent_by_key = {}
    for attempt in parent_attempts:
        parent_by_key.setdefault(PlayerKey.of(attempt), attempt)
    retest_by_key = {}
    for attempt in retest_attempts:
        retest_by_key.setdefault(PlayerKey.of(attempt), attempt)

    # WHO THIS RETEST WAS BUILT FOR: its own roster, which Phase D set to
    # exactly the players who missed. Reading the roster rather than the
    # attempts means a player who never opened it is still counted as targeted
    # and reported as not submitted, instead of vanishing from the comparison.
    targeted: list[dict] = []
    for entry in retest.roster.players if retest.roster else []:
        key = (
            PlayerKey(player_id=entry.player_id, legacy_name=None)
            if entry.player_id is not None
            else PlayerKey(player_id=None, legacy_name=entry.player_name.strip().casefold())
        )
        retest_attempt = retest_by_key.get(key)
        parent_attempt = parent_by_key.get(key)
        targeted.append(
            {
                "player_id": entry.player_id,
                "display_name": (
                    entry.player.full_name if entry.player is not None else entry.player_name
                ),
                "identity": "canonical" if key.is_canonical else "legacy_name",
                "parent_outcome": _outcome_for(parent_attempt, parent_qs),
                "outcome": _outcome_for(retest_attempt, retest_qs),
            }
        )

    counts = {state: 0 for state in (CORRECT, INCORRECT, UNGRADED, NOT_SUBMITTED)}
    for row in targeted:
        counts[row["outcome"]] += 1

    # THE TEAM-WIDE FIGURE IS CONTEXT AND IS NEVER DIVIDED INTO ANYTHING.
    # It answers "how big was the original problem", not "what fraction
    # improved" - those denominators are different populations and the card
    # must present them as such.
    parent_missed_total = sum(
        1
        for attempt in parent_attempts
        if _outcome_for(attempt, parent_qs) == INCORRECT
    )

    return {
        "parent_quiz_id": parent.id,
        "parent_quiz_title": parent.title,
        #: "snapshot" = what these players were actually delivered.
        #: "live_fallback" = the delivery predates concept tagging, so the
        #: question's current tag stood in. Never presented as history.
        "concept_source": concept_source,
        "concept_ids": sorted(concept_ids),
        "parent_missed_total": parent_missed_total,
        "parent_response_total": len(
            [a for a in parent_attempts if a.status == AttemptStatus.SUBMITTED]
        ),
        "targeted_total": len(targeted),
        "correct_count": counts[CORRECT],
        "incorrect_count": counts[INCORRECT],
        "ungraded_count": counts[UNGRADED],
        "not_submitted_count": counts[NOT_SUBMITTED],
        #: Whether every targeted player has a graded outcome. While this is
        #: false the card must not state an improvement - the evidence is
        #: incomplete, and a number that moves after grading was never a
        #: finding.
        "is_complete": counts[UNGRADED] == 0 and counts[NOT_SUBMITTED] == 0,
        "players": targeted,
        #: Still graded-incorrect, in the shape Phase D's retest endpoint
        #: takes, so "Retest these 2" needs no second derivation.
        "still_missing": [
            {"player_id": r["player_id"], "display_name": r["display_name"]}
            for r in targeted
            if r["outcome"] == INCORRECT
        ],
    }
