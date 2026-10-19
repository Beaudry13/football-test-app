"""What does this player know, and what is he still missing?

A small, per-player read of results PEIRA already has - not a report, not a
ranking. For each concept the coach tagged, the player's answers in the
coach's own quizzes and Reps, in time order:

  * a QUIZ counts by its submitted GRADED attempts (the official rule every
    result follows - practice never counts toward anything);
  * a REP counts by the player's FIRST try (the Rep rule: what he knew before
    he saw the verdict - services/rep_results).

One sitting on a concept is MISSED if any answer on it was graded wrong, GOT
if every graded answer was right; ungraded answers say nothing. The latest
sitting decides HAS or WORK ON. RECENT is how each concept changed ("Missed ->
Retest correct"). Concepts the coach never tagged are not invented.
"""
from __future__ import annotations

from app.models import AttemptStatus, PlayerAttempt, Quiz
from app.models.question import QuestionType
from app.models.quiz import REP_KIND
from app.services.attempt_scope import official_only
from app.services.rep_results import first_tries, rep_attempts

MISSED = "missed"
GOT = "got"
_TAP_TYPES = (QuestionType.MULTIPLE_CHOICE, QuestionType.TRUE_FALSE)


def _tappable(question) -> bool:
    """A decision a Rep can re-ask (the make-rep rule)."""
    return question.question_type in _TAP_TYPES and not question.allows_multiple_answers and not question.is_retired


def _sitting(attempt, by_question) -> dict[int, tuple[str, list[int]]]:
    """{concept_id: (MISSED | GOT, retest_question_ids)} for one attempt's
    judged answers. The question ids are the ones a "retest him" would send
    back: the missed decisions (or, on a GOT, the ones he got), tap-an-answer
    only, as a Rep can only hold those."""
    verdicts: dict[int, list[tuple[bool, object]]] = {}
    for answer in attempt.answers:
        question = by_question.get(answer.question_id)
        if question is None or question.concept_id is None or answer.is_correct is None:
            continue
        verdicts.setdefault(question.concept_id, []).append((bool(answer.is_correct), question))
    out = {}
    for cid, judged in verdicts.items():
        outcome = GOT if all(ok for ok, _q in judged) else MISSED
        ids = sorted({q.id for ok, q in judged if (ok if outcome == GOT else not ok) and _tappable(q)})
        out[cid] = (outcome, ids)
    return out


def player_learning(coach, player) -> dict:
    quizzes = Quiz.query.filter(
        Quiz.organization_id == coach.organization_id, Quiz.coach_id == coach.id
    ).all()
    events: list[dict] = []
    names: dict[int, str] = {}
    for quiz in quizzes:
        by_question = {q.id: q for q in quiz.questions}
        for q in quiz.questions:
            if q.concept is not None:
                names[q.concept.id] = q.concept.name
        if quiz.kind == REP_KIND:
            mine = [a for a in rep_attempts(quiz) if a.player_id == player.id]
            firsts = first_tries(mine)
            attempts = [attempt for attempt, _made in firsts.values()]
        else:
            # The official rule, written once (attempt_scope): practice never counts.
            attempts = official_only(PlayerAttempt.query).filter(
                PlayerAttempt.quiz_id == quiz.id,
                PlayerAttempt.player_id == player.id,
                PlayerAttempt.status == AttemptStatus.SUBMITTED,
            ).all()
        for attempt in attempts:
            when = attempt.submitted_at or attempt.started_at
            for concept_id, (outcome, question_ids) in _sitting(attempt, by_question).items():
                events.append(
                    {
                        "concept_id": concept_id,
                        "outcome": outcome,
                        "question_ids": question_ids,
                        "at": when.isoformat() if when else None,
                        "quiz_id": quiz.id,
                        "quiz_title": quiz.title,
                        "kind": quiz.kind,
                        "is_retest": quiz.retest_of_quiz_id is not None,
                    }
                )

    by_concept: dict[int, list[dict]] = {}
    for event in sorted(events, key=lambda e: e["at"] or ""):
        by_concept.setdefault(event["concept_id"], []).append(event)

    has, work_on, recent = [], [], []
    for concept_id, trail in by_concept.items():
        last = trail[-1]
        row = {"concept_id": concept_id, "name": names.get(concept_id, "Concept"), "last": last}
        (has if last["outcome"] == GOT else work_on).append(row)
        if len(trail) > 1:
            recent.append({"concept_id": concept_id, "name": row["name"], "trail": trail[-3:]})

    def newest(r):
        return r["last"]["at"] or ""

    has.sort(key=newest, reverse=True)
    work_on.sort(key=newest, reverse=True)
    recent.sort(key=lambda r: r["trail"][-1]["at"] or "", reverse=True)
    return {"has": has, "work_on": work_on, "recent": recent[:5]}
