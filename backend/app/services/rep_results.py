"""Situational Rep diagnostics: the football problem, not the grade.

A Rep is a quiz a coach made with kind REP: one decision per screen, an
immediate verdict, the coach's explanation. This module answers the coach's
question about it - not "safeties scored 72%" but

    MOTION ADJUSTMENT - 4 of 11 missed - most chose "Stay boundary"
    [who missed it, and what each of them answered]

WHY PRACTICE ATTEMPTS, AND WHY THAT DOES NOT BEND THE OFFICIAL RULE
-------------------------------------------------------------------
A Rep is always delivered as PRACTICE (routes/access_codes forces it): the
immediate verdict and explanation only exist there. So its answers live in
practice attempts, which every official reader rightly ignores
(services/attempt_scope). This module reads them deliberately, for this one
REP quiz only, and produces a diagnosis - never a grade, an average or an
export. Nothing here feeds a number that official results show. It is listed
in the attempt-scope guard's EXEMPT set for exactly that reason.

WHICH ANSWER COUNTS: THE FIRST TRY
----------------------------------
Practice allows a player to run a Rep again. The answer that says what he knew
is the one he gave BEFORE he saw the verdict and the explanation, so each
player counts once, by his first attempt that answered anything. How many
times he ran it is reported beside it, never folded in.

An answer counts once it has been CHECKED (the player saw its verdict), whether
or not he pressed a final submit - a player who answers all three decisions
and closes the tab still made all three decisions.

COACH-DEFINED TRUTH ONLY. Correctness is the stored `is_correct`, decided at
save time against the coach's own correct option. Nothing here infers what a
wrong answer "means".
"""

from __future__ import annotations

from collections import defaultdict
from statistics import median

from app.models import PlayerAttempt
from app.models.assessment_mode import PRACTICE
from app.services.player_identity import PlayerKey
from app.services.question_snapshots import has_history


def rep_attempts(quiz) -> list:
    """Every attempt at this Rep, oldest first."""
    return (
        PlayerAttempt.query.filter(
            PlayerAttempt.quiz_id == quiz.id,
            PlayerAttempt.mode == PRACTICE,
        )
        .order_by(PlayerAttempt.started_at.asc(), PlayerAttempt.id.asc())
        .all()
    )


def _checked(attempt) -> list:
    return [a for a in attempt.answers if a.checked_at is not None]


def first_tries(attempts) -> dict:
    """{PlayerKey: (first attempt that answered anything, attempts made)}."""
    first: dict = {}
    made: dict = defaultdict(int)
    for attempt in attempts:
        if not _checked(attempt):
            continue
        key = PlayerKey.of(attempt)
        made[key] += 1
        first.setdefault(key, attempt)
    return {key: (attempt, made[key]) for key, attempt in first.items()}


def run_summary(attempt) -> dict:
    """One run of a Rep, for the player who made it: how many right, and the
    concepts he missed and the ones he got every time."""
    checked = _checked(attempt)
    judged = [a for a in checked if a.is_correct is not None]
    missed: list[str] = []
    got: list[str] = []
    by_concept: dict = defaultdict(list)
    for a in judged:
        concept = a.question.concept.name if a.question is not None and a.question.concept is not None else None
        if concept:
            by_concept[concept].append(a.is_correct)
    for name, verdicts in by_concept.items():
        (got if all(verdicts) else missed).append(name)
    return {
        "correct": sum(1 for a in judged if a.is_correct),
        "answered": len(judged),
        "missed_concepts": sorted(missed),
        "mastered_concepts": sorted(got),
    }


def player_progress(quiz, attempt) -> dict:
    """WHERE THIS PLAYER STANDS ON THIS REP, for his own finish screen:
    `previous` - his run before this one, here; `original` - for a Retest, his
    first try on the Rep it re-asks. Either is None when there is none."""
    key = PlayerKey.of(attempt)
    earlier = [
        a
        for a in rep_attempts(quiz)
        if PlayerKey.of(a) == key and a.id != attempt.id and a.started_at <= attempt.started_at and _checked(a)
    ]
    original = None
    parent = quiz.retest_of
    if parent is not None and parent.kind == quiz.kind:
        first = first_tries(rep_attempts(parent)).get(key)
        if first is not None:
            original = {"title": parent.title, **run_summary(first[0])}
    return {
        "previous": run_summary(earlier[-1]) if earlier else None,
        "original": original,
    }


def _chosen_ids(answer) -> list[int]:
    """The options the player picked - the selection set first, which survives a
    deleted option; the single column as the fallback."""
    return [s.option_id for s in answer.selected_options] or (
        [answer.selected_option_id] if answer.selected_option_id is not None else []
    )


def _player(attempt) -> dict:
    key = PlayerKey.of(attempt)
    return {
        "key": f"p{key.player_id}" if key.is_canonical else f"n:{key.legacy_name}",
        "player_id": attempt.player_id,
        "display_name": attempt.display_name,
        "position": attempt.position_at_attempt,
        "jersey_number": attempt.player.jersey_number if attempt.player is not None else None,
    }


def _concept_ref(question) -> dict | None:
    if question.concept is None:
        return None
    return {"id": question.concept.id, "name": question.concept.name}


def rep_results(quiz) -> dict:
    """Everything the coach's Rep page shows, computed from the first tries."""
    result = _first_try_results(quiz)
    result["audience"] = _audience(quiz)
    result["retest_of"] = _retest_of(quiz, result["concepts"])
    _attach_retests(quiz, result["concepts"])
    _attach_taught(quiz, result["concepts"])
    return result


def _attach_taught(quiz, concepts: list[dict]) -> None:
    """WHETHER EACH PROBLEM HAS BEEN TAUGHT (models/rep_teach_mark): `taught`
    is {at, by} or None. Taught means the next step is Retest - the same answer
    for every coach, on every device."""
    from app.models.rep_teach_mark import RepTeachMark, concept_key

    marks = {m.concept_key: m for m in RepTeachMark.query.filter_by(quiz_id=quiz.id).all()}
    for c in concepts:
        mark = marks.get(concept_key((c["concept"] or {}).get("id")))
        c["taught"] = mark.to_dict() if mark is not None else None


def _attach_retests(quiz, concepts: list[dict]) -> None:
    """THE NEXT STEP, ON EACH PROBLEM: has it been retested, and how did that
    go? Each concept gets `retest` - the latest Rep built by Retest from this
    one that re-asks it - with how many ran it and how many still miss it
    (first tries, as everywhere here). None when it has not been retested."""
    from app.models import Quiz

    children = (
        Quiz.query.filter(Quiz.retest_of_quiz_id == quiz.id, Quiz.kind == quiz.kind)
        .order_by(Quiz.created_at.desc(), Quiz.id.desc())
        .all()
    )
    latest: dict = {}
    for child in children:
        child_results = _first_try_results(child)
        for c in child_results["concepts"]:
            key = (c["concept"] or {}).get("id")
            if key in latest:
                continue
            latest[key] = {
                "id": child.id,
                "title": child.title,
                "invited": _audience(child)["invited"],
                "ran": len(child_results["players"]),
                "responded": c["responded"],
                "missed": c["missed"],
            }
    for c in concepts:
        c["retest"] = latest.get((c["concept"] or {}).get("id"))


def _retest_of(quiz, concepts: list[dict]) -> dict | None:
    """DID THE TEACHING STICK? For a Rep built by Retest: the Rep it re-asked,
    and - per concept - how many missed it there. Read beside this Rep's own
    numbers it answers "4 missed before; now 1 of 3". The parent's own
    lineage is not walked: one step back is the comparison a coach makes."""
    parent = quiz.retest_of
    if parent is None or parent.kind != quiz.kind:
        return None
    before = {(c["concept"] or {}).get("id"): c for c in _first_try_results(parent)["concepts"]}
    return {
        "id": parent.id,
        "title": parent.title,
        "concepts": [
            {
                "concept": c["concept"],
                "name": c["name"],
                "missed_before": before[key]["missed"] if key in before else None,
                "responded_before": before[key]["responded"] if key in before else None,
            }
            for c in concepts
            for key in [(c["concept"] or {}).get("id")]
        ],
    }


def _first_try_results(quiz) -> dict:
    questions = sorted(quiz.questions, key=lambda q: (q.position, q.id))
    tries = first_tries(rep_attempts(quiz))

    # (player, answer) per question, from first tries only.
    rows: dict[int, list] = {q.id: [] for q in questions}
    players: list[dict] = []
    for attempt, made in tries.values():
        person = _player(attempt)
        answers = {a.question_id: a for a in _checked(attempt)}
        verdicts = [a.is_correct for a in answers.values() if a.is_correct is not None]
        times = [a.time_to_answer_ms for a in answers.values() if a.time_to_answer_ms]
        players.append(
            {
                **person,
                "correct": sum(1 for v in verdicts if v),
                "answered": len(verdicts),
                "attempts": made,
                "total_ms": sum(times) if times else None,
            }
        )
        for question_id, answer in answers.items():
            if question_id in rows:
                rows[question_id].append((person, answer))
    players.sort(key=lambda p: (p["answered"] and p["correct"] / p["answered"], p["display_name"].lower()))

    decisions: list[dict] = []
    for index, question in enumerate(questions):
        text_by_id = {o.id: o.option_text for o in question.options}
        picked: dict[int, list] = defaultdict(list)
        answers_out: list[dict] = []
        for person, answer in rows[question.id]:
            chosen = _chosen_ids(answer)
            for option_id in chosen:
                picked[option_id].append(person)
            answers_out.append(
                {
                    "player": person,
                    "is_correct": answer.is_correct,
                    "chose": [text_by_id[o] for o in chosen if o in text_by_id],
                    "time_ms": answer.time_to_answer_ms,
                }
            )
        verdicts = [a["is_correct"] for a in answers_out if a["is_correct"] is not None]
        times = [a["time_ms"] for a in answers_out if a["time_ms"]]
        decisions.append(
            {
                "question_id": question.id,
                "number": index + 1,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "subject_role": question.subject_role,
                "concept": _concept_ref(question),
                "motion_play_id": question.motion_play_id,
                "answer_explanation": question.answer_explanation,
                "image": question.image.to_dict() if question.image else None,
                # The pre-snap moment, so Teach can run the motion for the room.
                "presnap": question.presnap,
                # Received by a player already: its answers can be reworded or
                # added to, but which one is right is locked (routes/questions).
                "delivered": has_history(question),
                "is_retired": question.is_retired,
                "correct_text": [o.option_text for o in question.options if o.is_correct_answer],
                "responded": len(verdicts),
                "missed": sum(1 for v in verdicts if v is False),
                "median_ms": int(median(times)) if times else None,
                "choices": [
                    {
                        "option_id": o.id,
                        "text": o.option_text,
                        "is_correct": o.is_correct_answer,
                        "count": len(picked[o.id]),
                        "players": picked[o.id],
                    }
                    for o in question.options
                ],
                "answers": answers_out,
            }
        )

    return {
        "quiz_id": quiz.id,
        "title": quiz.title,
        "players": players,
        "decisions": decisions,
        "concepts": _concepts(decisions),
    }


def _concepts(decisions: list[dict]) -> list[dict]:
    """The football problems: decisions grouped by the coach's concept tag,
    worst first. "General" holds untagged decisions."""
    groups: dict = {}
    for decision in decisions:
        concept = decision["concept"]
        groups.setdefault(concept["id"] if concept else None, []).append(decision)

    out: list[dict] = []
    for concept_id, members in groups.items():
        concept = members[0]["concept"]
        responded: set = set()
        missed: dict = {}
        wrong: dict = defaultdict(lambda: {"count": 0, "players": []})
        for decision in members:
            for answer in decision["answers"]:
                if answer["is_correct"] is None:
                    continue
                person = answer["player"]
                responded.add(person["key"])
                if answer["is_correct"]:
                    continue
                entry = missed.setdefault(person["key"], {**person, "answers": []})
                entry["answers"].append(
                    {
                        "question_id": decision["question_id"],
                        "number": decision["number"],
                        "chose": answer["chose"],
                        "time_ms": answer["time_ms"],
                    }
                )
                for text in answer["chose"]:
                    bucket = wrong[(decision["question_id"], text)]
                    bucket["count"] += 1
                    bucket["players"].append(person["display_name"])

        most = max(wrong.items(), key=lambda kv: kv[1]["count"]) if wrong else None
        teach = next((d["motion_play_id"] for d in members if d["motion_play_id"]), None)
        out.append(
            {
                "concept": concept,
                "name": concept["name"] if concept else "General",
                "responded": len(responded),
                "missed": len(missed),
                "players_missed": sorted(missed.values(), key=lambda p: p["display_name"].lower()),
                "most_common_wrong": (
                    {
                        "text": most[0][1],
                        "question_id": most[0][0],
                        "count": most[1]["count"],
                    }
                    if most
                    else None
                ),
                "question_ids": [d["question_id"] for d in members],
                "motion_play_id": teach,
            }
        )
    out.sort(key=lambda c: (-c["missed"], -(c["missed"] / c["responded"] if c["responded"] else 0), c["name"]))
    return out


def _audience(quiz) -> dict:
    """Who it went to, in the coach's words: the one group's name when it went
    to exactly one group ("Safeties"), and how many people that is."""
    from app.services.access_codes import effective_roster_people_for_quiz, reason_for_invalid

    code = quiz.access_codes[0] if quiz.access_codes else None
    groups = list(code.groups) if code is not None else []
    people = effective_roster_people_for_quiz(quiz, code)
    return {
        "label": groups[0].name if len(groups) == 1 else None,
        "invited": len(people),
        # Only a code a player could still use right now.
        "code": code.code if code is not None and reason_for_invalid(code) is None else None,
        "people": [
            {"player_id": p.get("player_id"), "name": p.get("name"), "position": p.get("position")}
            for p in people
        ],
        # The positions it went to, as the roster has them - so a Rep sent to
        # "everyone who plays S" can still say "4 of 11 safeties missed".
        "positions": sorted({p["position"] for p in people if p.get("position")}),
    }
