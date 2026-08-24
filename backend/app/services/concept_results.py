"""What a team does not know, grouped by concept.

Results has always answered "here are the grades". This answers "what should I
teach next", which is a different question with a different shape: it groups by
IDEA rather than by artefact, and it is only answerable because a coach tagged
their questions.

WHY THIS IS COMPUTED HERE AND NOT IN THE BROWSER
------------------------------------------------
`services/scoring.py` is the one place that decides what an answer's outcome is
and what a score is made of (see CLAUDE.md, Things That Will Bite You #4). A
concept miss rate is a new aggregate, but its DENOMINATOR is the same rule:
correct / (correct + incorrect), never counting ungraded or unanswered. Doing
that arithmetic in the client would put a second copy of that rule one refactor
away from disagreeing with the PDF, the CSV and the quiz card. So the counting
happens here, on top of `count_answers`, and the client renders what it is
given.

THE CONCEPT KEY IS THE QUESTION'S CURRENT TAG, NOT THE DELIVERED SNAPSHOT
-------------------------------------------------------------------------
This is the one place Phase C deliberately reads live data, and it is worth
being explicit about why, because the rest of this codebase leans hard the
other way.

`attempt_question_snapshots` records the concept a question carried when it was
DELIVERED - that is the historical truth, and it is what a future "what was
this player asked?" reader must use. But every attempt in Peira today predates
concept tagging entirely: tagging shipped after those attempts were recorded,
so every one of their snapshots has no concept at all. Ranking on the snapshot
would mean a coach tags twenty questions and learns nothing about any quiz they
have already run - the feature would appear broken on precisely the data it was
built for.

The coach's question is also not historical. "What should I teach next?" is
about the material as they understand it TODAY, and the tag is their statement
about that material. Retagging a question therefore does move it between
concepts here - which is correct, and is the same rule the per-question
breakdown beside it already follows (it aggregates today's quiz, see
routes/grading.py).

Where history genuinely matters - WHO answered, and what group they were in -
this reads the attempt snapshot instead. See `position_at_attempt` below.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.models.question import OPTIONLESS_TYPES, QuestionType
from app.services.scoring import count_answers

#: Below this many GRADED answers, a concept's miss rate is arithmetic rather
#: than evidence. Five is not a statistical threshold - it is the point below
#: which a single player changes the number by twenty points or more, and a
#: coach reading "60% missed this" deserves to know it means three of five.
#: The flag travels with the row so the wording is decided once, here, rather
#: than by whichever surface happens to render it.
MIN_RESPONSES_FOR_CONFIDENCE = 5

#: Below this many MISSES, "most of them chose X" is not a finding. With two
#: misses the phrase describes a coincidence; the honest move is to show the
#: count and say nothing about the pattern.
MIN_MISSES_FOR_DISTRACTOR = 3

#: A question needs at least this many WRONG options before naming one of them
#: says anything.
#:
#: With a single wrong option every miss necessarily chose it, so "8 of the 8
#: misses chose False" carries no information at all - it restates the miss
#: count in more words while reading like a finding. True/False is the obvious
#: case; a two-option multiple choice is exactly as hollow, which is why this
#: counts WRONG OPTIONS rather than naming a question type.
MIN_WRONG_OPTIONS_FOR_DISTRACTOR = 2


@dataclass(frozen=True)
class MissingPlayer:
    """Who got a concept wrong, as they were at the time."""

    player_name: str
    display_name: str
    #: Their position WHEN THEY ANSWERED, from the attempt, never from the
    #: roster as it stands now. A coach who moves a corner to safety in October
    #: must not find that September's misses have quietly re-attributed
    #: themselves to a different group. None where it was never recorded -
    #: which is every attempt older than Phase A - and None is shown as
    #: nothing, not as a guess.
    position_at_attempt: str | None

    def to_dict(self) -> dict:
        return {
            "player_name": self.player_name,
            "display_name": self.display_name,
            "position_at_attempt": self.position_at_attempt,
        }


def _top_distractor(question, answers) -> dict | None:
    """The wrong option most misses chose, when there is one worth naming.

    DISCRETE OPTIONS ONLY, AND AT LEAST TWO WRONG ONES. A written answer has
    no options to count and a drawing has no discrete answer at all, so neither
    can produce a distribution. Nor can a question with one wrong option: every
    miss chose it by arithmetic, not by thinking, so there is nothing to learn.
    In all three cases the caller renders nothing rather than an empty chart or
    a hollow sentence.

    Reads the SELECTION SET (`answer_selected_options`), which is the record
    that survives a coach deleting an option later; `selected_option_id` is
    ON DELETE SET NULL and would silently lose the very answer this is about.
    """
    if question.question_type in OPTIONLESS_TYPES:
        return None
    if question.question_type not in (QuestionType.MULTIPLE_CHOICE, QuestionType.TRUE_FALSE):
        return None

    #: THE INFORMATION TEST, applied before any counting. One wrong option
    #: means the distribution is a foregone conclusion, and a coach reading it
    #: would be told something they already knew in a sentence that sounds like
    #: analysis.
    wrong_options = [o for o in question.options if not o.is_correct_answer]
    if len(wrong_options) < MIN_WRONG_OPTIONS_FOR_DISTRACTOR:
        return None

    text_by_id = {o.id: o.option_text for o in question.options}
    tally: dict[int, int] = {}
    misses = 0
    for answer in answers:
        if answer.is_correct is not False:
            # Correct, or not graded. Neither is a miss, and counting a
            # NOT-GRADED answer as one would be the fabricated-zero mistake in
            # a different costume.
            continue
        misses += 1
        chosen = [s.option_id for s in answer.selected_options] or (
            [answer.selected_option_id] if answer.selected_option_id is not None else []
        )
        for option_id in chosen:
            tally[option_id] = tally.get(option_id, 0) + 1

    if misses < MIN_MISSES_FOR_DISTRACTOR or not tally:
        return None

    option_id, count = max(tally.items(), key=lambda kv: kv[1])
    label = text_by_id.get(option_id)
    if label is None:
        # The option has since been deleted. The COUNT is still true, but
        # naming it is not possible - so this says nothing rather than
        # inventing a label or showing a bare id to a coach.
        return None
    return {"option_text": label, "count": count, "of_misses": misses}


def concept_breakdown(quiz, responses) -> list[dict]:
    """Every TAGGED concept in this quiz, weakest first.

    UNTAGGED QUESTIONS ARE ABSENT, not bucketed. There is no "General"
    concept - inventing one would put a football idea in front of a coach that
    they never assigned, and would mix genuinely unrelated questions into a
    single fake weakness. They remain fully visible in the per-question
    breakdown beside this; they simply do not rank.

    Returns [] when nothing is tagged, which is the caller's signal to fall
    back to the ordinary Results view rather than render an empty weakness.
    """
    answers_by_question: dict[int, list] = {}
    for response in responses:
        for answer in response.answers:
            answers_by_question.setdefault(answer.question_id, []).append(answer)

    # Which attempt each answer came from, so a miss can name the player as
    # they were at the time.
    attempt_of: dict[int, object] = {}
    for response in responses:
        for answer in response.answers:
            attempt_of[answer.id] = response

    grouped: dict[int, dict] = {}
    for question in quiz.questions:
        if question.concept_id is None:
            continue
        bucket = grouped.setdefault(
            question.concept_id,
            {
                "concept_id": question.concept_id,
                "concept_name": question.concept.name if question.concept else None,
                "question_count": 0,
                "correct_count": 0,
                "incorrect_count": 0,
                "ungraded_count": 0,
                "_missed": {},
                "_distractors": [],
            },
        )
        answers = answers_by_question.get(question.id, [])
        counts = count_answers(answers)
        bucket["question_count"] += 1
        bucket["correct_count"] += counts.correct
        bucket["incorrect_count"] += counts.incorrect
        bucket["ungraded_count"] += counts.not_graded

        for answer in answers:
            if answer.is_correct is False:
                attempt = attempt_of.get(answer.id)
                if attempt is None:
                    continue
                # Keyed by attempt so a player who missed three questions in
                # one concept is one name, not three.
                bucket["_missed"][attempt.id] = MissingPlayer(
                    player_name=attempt.player_name,
                    display_name=attempt.display_name,
                    position_at_attempt=attempt.position_at_attempt,
                )

        distractor = _top_distractor(question, answers)
        if distractor is not None:
            bucket["_distractors"].append(distractor)

    rows = []
    for bucket in grouped.values():
        graded = bucket["correct_count"] + bucket["incorrect_count"]
        missed = sorted(bucket.pop("_missed").values(), key=lambda p: p.display_name.lower())
        distractors = bucket.pop("_distractors")
        # The single strongest signal across this concept's questions, not a
        # merged tally: two questions offering different options cannot have
        # their choices added together without inventing a distribution.
        top = max(distractors, key=lambda d: d["count"]) if distractors else None

        rows.append(
            {
                **bucket,
                "graded_count": graded,
                # None, never 0.0, when nothing has been graded - the same rule
                # score_percent follows, for the same reason: a fabricated zero
                # reads as "they got everything wrong".
                "miss_rate": round(100 * bucket["incorrect_count"] / graded, 1) if graded else None,
                #: Whether this row is evidence or arithmetic. The wording that
                #: depends on it lives in the client, but the THRESHOLD lives
                #: here so two surfaces cannot disagree about it.
                "has_enough_responses": graded >= MIN_RESPONSES_FOR_CONFIDENCE,
                "players_missed": [p.to_dict() for p in missed],
                "top_distractor": top,
            }
        )

    # Weakest first. Ties broken by how much was answered, so a concept two
    # players got wrong does not outrank one twenty players got wrong at the
    # same rate. Rows with nothing graded sort last: they are not weak, they
    # are unmeasured.
    rows.sort(key=lambda r: (r["miss_rate"] is None, -(r["miss_rate"] or 0), -r["graded_count"]))
    return rows
