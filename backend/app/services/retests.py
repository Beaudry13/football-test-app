"""Who qualifies for a retest, and which questions it should ask.

Peira does the assembly; the coach owns the football judgement and the send.
That split is why this file decides only two things - the eligible players and
the questions they missed - and hands the result to the ordinary quiz editor
rather than to a retest workflow.

BOTH RULES ARE DELIBERATELY BORING. A coach has to be able to predict what
Peira will build before they tap the button, and explain it to an assistant
afterwards. Anything cleverer - per-player question sets, weighting by how
badly a question was missed, automatic rewording - would make the output harder
to anticipate than the problem it solves.
"""
from __future__ import annotations

from app.models import AttemptStatus, PlayerAttempt, Question
from app.services.attempt_scope import official_only
from app.services.player_identity import PlayerKey, representative_attempts


def missed_by_player(quiz, concept_id: int) -> dict[PlayerKey, set[int]]:
    """`{PlayerKey: {question_id, ...}}` for one concept.

    KEYED BY PLAYER IDENTITY, NOT BY ATTEMPT. A quiz can hold several access
    codes and attempt uniqueness is scoped to one of them, so keying on
    `attempt.id` counted a player who took the quiz twice as two people. Each
    player is represented by their MOST RECENT official submission - see
    services/player_identity for why the latest attempt speaks for them rather
    than the union of everything they ever got wrong.

    WHAT COUNTS AS A MISS, and every exclusion here is a rule Peira already
    follows somewhere else:

    * GRADED-INCORRECT only. `is_correct is False`. An UNGRADED answer is not a
      miss - the coach has not judged it yet, and treating their own backlog as
      a wrong answer is the fabricated-zero mistake wearing a different hat.
    * SUBMITTED attempts only. Work still in progress is not a result.
    * OFFICIAL attempts only (`official_only`, i.e. mode == GRADED). Nobody owes
      a practice rep, and a practice answer has never counted toward anything.
    * UNANSWERED is absent by construction: no answer row, nothing to classify.
      Absence is not wrongness.

    A canonical player is keyed by player_id and a free-text join by their
    casefolded name, kept structurally separate so the two can never merge on
    a matching string.
    """
    attempts = (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .all()
    )
    concept_question_ids = {q.id for q in quiz.questions if q.concept_id == concept_id}
    if not concept_question_ids:
        return {}

    missed: dict[PlayerKey, set[int]] = {}
    for key, attempt in representative_attempts(attempts).items():
        for answer in attempt.answers:
            if answer.question_id not in concept_question_ids:
                continue
            if answer.is_correct is not False:
                continue
            missed.setdefault(key, set()).add(answer.question_id)
    return missed


def eligible_players(quiz, concept_id: int) -> dict[PlayerKey, PlayerAttempt]:
    """`{PlayerKey: representative attempt}` for everyone who missed something.

    Returns a mapping rather than a list so a caller targeting players by id or
    name never has to re-derive identity - which is where a second, subtly
    different rule would otherwise appear.
    """
    missed = missed_by_player(quiz, concept_id)
    if not missed:
        return {}
    attempts = representative_attempts(
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .all()
    )
    return {key: attempts[key] for key in missed if key in attempts}


def questions_to_copy(
    quiz, concept_id: int, player_keys: set[PlayerKey]
) -> tuple[set[int], list[Question]]:
    """`(copyable question ids, retired questions that were skipped)`.

    THE RULE: every question tagged with this concept that at least one of the
    selected players answered incorrectly. A UNION, not per-player sets - one
    quiz has one question list, and "you all get the questions this group
    missed" is a sentence a coach can say out loud. A player who got one of
    them right still receives it, which costs a question and buys a cheap
    confirmation.

    RETIRED QUESTIONS ARE EXCLUDED AND RETURNED SEPARATELY. A coach stops
    sending a question because it is broken or wrong; duplication deliberately
    carries `retired_at`, so copying one would put an undeliverable question
    into a retest - and a retest that silently contains a question nobody can
    answer is worse than one that says a question was left out. The caller
    tells the coach.
    """
    missed = missed_by_player(quiz, concept_id)
    wanted: set[int] = set()
    for key, question_ids in missed.items():
        if key in player_keys:
            wanted |= question_ids

    by_id = {q.id: q for q in quiz.questions}
    copyable = {qid for qid in wanted if by_id[qid].retired_at is None}
    skipped = [by_id[qid] for qid in sorted(wanted - copyable)]
    return copyable, skipped
