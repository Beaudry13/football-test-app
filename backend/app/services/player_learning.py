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

from collections import defaultdict

from sqlalchemy.orm import selectinload

from app.models import AttemptStatus, PlayerAttempt, Question, Quiz
from app.models.question import QuestionType
from app.models.quiz import REP_KIND
from app.services.attempt_scope import official_only
from app.services.rep_results import first_tries, rep_attempts_for

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
    return players_learning(coach, [player])[player.id]


def players_learning(coach, players) -> dict[int, dict]:
    """player_learning for several players in ONE pass over the coach's
    quizzes - the same rules, the same rows - so a position group ("what are
    my safeties missing?") costs one read, not one per player."""
    ids = {p.id for p in players}
    # THREE READS, HOWEVER MANY QUIZZES: his quizzes with their questions and
    # concepts; every official graded attempt by these players across them;
    # every Rep attempt by them. Per quiz this was a query or more, plus one
    # per attempt for its answers - a cost that grew all season
    # (tests/test_connected_performance).
    quizzes = (
        Quiz.query.filter(Quiz.organization_id == coach.organization_id, Quiz.coach_id == coach.id)
        .options(selectinload(Quiz.questions).joinedload(Question.concept))
        .all()
    )
    graded: dict[int, list] = defaultdict(list)
    reps: dict[int, list] = defaultdict(list)
    graded_ids = [q.id for q in quizzes if q.kind != REP_KIND]
    rep_ids = [q.id for q in quizzes if q.kind == REP_KIND]
    if ids and graded_ids:
        # The official rule, written once (attempt_scope): practice never counts.
        for attempt in (
            official_only(PlayerAttempt.query)
            .filter(
                PlayerAttempt.quiz_id.in_(graded_ids),
                PlayerAttempt.player_id.in_(list(ids)),
                PlayerAttempt.status == AttemptStatus.SUBMITTED,
            )
            .options(selectinload(PlayerAttempt.answers))
            .all()
        ):
            graded[attempt.quiz_id].append(attempt)
    if ids and rep_ids:
        for attempt in rep_attempts_for(rep_ids, player_ids=ids):
            reps[attempt.quiz_id].append(attempt)

    events_by_player: dict[int, list[dict]] = {pid: [] for pid in ids}
    names: dict[int, str] = {}
    for quiz in quizzes:
        by_question = {q.id: q for q in quiz.questions}
        for q in quiz.questions:
            if q.concept is not None:
                names[q.concept.id] = q.concept.name
        if quiz.kind == REP_KIND:
            firsts = first_tries(reps[quiz.id])
            attempts = [attempt for attempt, _made in firsts.values()]
        else:
            attempts = graded[quiz.id]
        for attempt in attempts:
            if attempt.player_id not in events_by_player:
                continue
            when = attempt.submitted_at or attempt.started_at
            for concept_id, (outcome, question_ids) in _sitting(attempt, by_question).items():
                events_by_player[attempt.player_id].append(
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

    return {pid: _summary(events, names) for pid, events in events_by_player.items()}


def _summary(events: list[dict], names: dict[int, str]) -> dict:
    """One player's events as HAS / WORK ON / RECENT (the profile's rows)."""
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


def group_needs(coach, players) -> dict:
    """WHAT A GROUP NEEDS - "show me what my safeties are missing" - from the
    same per-player rows the profile shows: for each concept at least one of
    them is still working on, who (with where he last missed it, so a retest
    can send those questions back) and how many of them have it. Most missed
    first, then the most recent miss. Nothing the coach did not tag."""
    learning = players_learning(coach, players)
    by_id = {p.id: p for p in players}
    rows: dict[int, dict] = {}
    for pid, summary in learning.items():
        for row in summary["work_on"]:
            entry = rows.setdefault(row["concept_id"], {"concept_id": row["concept_id"], "name": row["name"], "missing": [], "got": 0})
            entry["missing"].append({"player_id": pid, "name": by_id[pid].full_name, "last": row["last"]})
        for row in summary["has"]:
            entry = rows.setdefault(row["concept_id"], {"concept_id": row["concept_id"], "name": row["name"], "missing": [], "got": 0})
            entry["got"] += 1
    concepts = [r for r in rows.values() if r["missing"]]
    for r in concepts:
        r["missing"].sort(key=lambda m: m["name"])
    # Most missed first; within a count, the most recent miss (a stable sort, twice).
    concepts.sort(key=lambda r: max(m["last"]["at"] or "" for m in r["missing"]), reverse=True)
    concepts.sort(key=lambda r: len(r["missing"]), reverse=True)
    return {"players": len(players), "concepts": concepts}
