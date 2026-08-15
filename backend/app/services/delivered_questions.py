"""What a player was actually shown, as one object every historical surface reads.

THE PROBLEM THIS SOLVES
-----------------------
`answers` stores `question_id` and `selected_option_id` pointing at LIVE rows.
So a coach fixing a typo today silently rewrites what a player is shown to have
been asked months ago - and a measured, reachable case is worse than that: a
bare `question_type` change made a correctly-answered question display as "No
answer", because the display consulted the live type and read the wrong column.

Phase 1 recorded the truth in `attempt_question_snapshots` and deliberately let
nothing read it. THIS MODULE IS THAT READ. It is the whole of Phase 4a's
architecture: one snapshot-backed view of a delivered question, shared by the
player's results page, the CSV, the detailed PDF and the coach's expanded
per-player view, so those four cannot disagree about what happened.

WHAT IT DOES NOT DO
-------------------
**It never regrades.** `answers.is_correct` remains the historical verdict, and
nothing here recomputes it from the snapshot's `is_correct_answer` flags. A
grade earned under the delivered answer key stays exactly as recorded; the
snapshot explains it rather than replacing it.

It also does not touch scoring. `services/scoring` still counts answer rows;
this only decides what a delivered question LOOKED like.

LEGACY ATTEMPTS - A COMPATIBILITY FALLBACK, NOT HISTORY
-------------------------------------------------------
Attempts from before Phase 1 have no snapshot rows. They fall back to the LIVE
question, and that is a COMPATIBILITY FALLBACK - it keeps old results rendering
exactly as they did before this module existed. It is explicitly NOT a record
of what those players received, because none was ever taken, and nothing here
should be read as claiming otherwise. No history is invented and nothing is
backfilled. `from_snapshot` is carried on every object and out through the API
so a caller can tell the two apart instead of guessing - and so an explicit
"delivered content not recorded" indicator can be added later without any
architectural change.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models import AttemptQuestionSnapshot, QuestionType


@dataclass(frozen=True)
class DeliveredOption:
    id: int | None
    text: str
    is_correct_answer: bool


@dataclass(frozen=True)
class DeliveredImage:
    #: The object this attempt was shown. After a coach replaces the live
    #: image, Phase 1 repoints this at a preserved copy of the original - so
    #: reading it here is what finally makes that preservation visible.
    image_url: str
    canvas_width: int | None
    annotations: list


@dataclass(frozen=True)
class DeliveredQuestion:
    """One question as one attempt received it."""

    #: None only if the question was later hard-deleted (blocked once answered,
    #: so in practice this stays set).
    question_id: int | None
    #: 1-BASED, IN DELIVERED ORDER. Not the live position: a coach reordering
    #: the quiz must not retitle what a player was given.
    number: int
    text: str
    question_type: QuestionType
    options: list[DeliveredOption]
    expected_answers: list[str]
    answer_matching: str | None
    image: DeliveredImage | None
    #: False means this attempt predates Phase 1 and the content below came
    #: from the live question. Never silently conflate the two.
    from_snapshot: bool

    @property
    def id(self) -> int | None:
        """Alias for `question_id`.

        `scoring.count_delivered` and `ExclusionSet.active_questions` are
        duck-typed on `.id` because they were written against live Question
        rows. Satisfying that contract here means Phase 2's counter and Phase
        3's exclusion filter work on delivered questions with NO change to
        either - which is the point: this module adds a reader, it does not
        reopen the layers underneath it.
        """
        return self.question_id

    def option_text(self, option_id: int | None, fallback: str | None = None) -> str | None:
        """What the player's selection SAID when they made it.

        Looked up in the delivered options, so an option whose text has since
        been edited still reads as the player saw it.

        `fallback` is a DEFENSIVE COMPATIBILITY PATH for legacy or corrupted
        data, not part of normal behaviour.

        Since 4a-bis a resumed attempt is served its own delivered options, so
        a player cannot be shown - or submit - an option id the snapshot never
        saw. What remains reachable is a legacy attempt, or a hand-made API
        call. Blanking the cell there would erase a real answer to protect a
        record that does not describe it, so the live option text is used
        instead.
        """
        if option_id is None:
            return None
        return next((o.text for o in self.options if o.id == option_id), fallback)

    @property
    def correct_option_text(self) -> str | None:
        return next((o.text for o in self.options if o.is_correct_answer), None)

    @property
    def is_text_answered(self) -> bool:
        """Whether this question was answered by TYPING, as delivered.

        THE FIX FOR THE MEASURED BUG. Asking the delivered type rather than the
        live one is what stops a later type change from making a
        correctly-answered multiple-choice question display as "No answer".
        """
        from app.models.question import TEXT_ANSWER_TYPES

        return self.question_type in TEXT_ANSWER_TYPES


def _question_type(value) -> QuestionType:
    """The delivered type, tolerating a value this build no longer knows.

    Postgres enums cannot drop a member, so an unknown value here would mean a
    snapshot written by a newer build. Falling back to WRITTEN keeps the row
    readable instead of 500-ing a whole results page over one question.
    """
    try:
        return QuestionType(value)
    except ValueError:
        return QuestionType.WRITTEN


def _from_snapshot(row: AttemptQuestionSnapshot, number: int) -> DeliveredQuestion:
    data = row.snapshot or {}
    image = data.get("image")
    return DeliveredQuestion(
        question_id=row.question_id,
        number=number,
        text=data.get("question_text") or "",
        question_type=_question_type(data.get("question_type")),
        options=[
            DeliveredOption(
                id=o.get("id"),
                text=o.get("text") or "",
                is_correct_answer=bool(o.get("is_correct_answer")),
            )
            for o in (data.get("options") or [])
        ],
        expected_answers=list(data.get("expected_answers") or []),
        answer_matching=data.get("answer_matching"),
        image=(
            DeliveredImage(
                image_url=image.get("image_url"),
                canvas_width=image.get("canvas_width"),
                annotations=list(image.get("annotations") or []),
            )
            if isinstance(image, dict) and image.get("image_url")
            else None
        ),
        from_snapshot=True,
    )


def _from_live(question, number: int) -> DeliveredQuestion:
    """COMPATIBILITY FALLBACK: describe the question as it stands TODAY.

    Only reached for attempts that predate Phase 1, which have no delivered
    record. This is NOT history and does not reconstruct any - it is what those
    surfaces already showed before Phase 4a, kept so old results do not break.
    `from_snapshot` is False, which is how a caller tells the difference.
    """
    from app.models.question import OPTIONLESS_TYPES

    return DeliveredQuestion(
        question_id=question.id,
        number=number,
        text=question.question_text,
        question_type=question.question_type,
        options=(
            []
            if question.question_type in OPTIONLESS_TYPES
            else [
                DeliveredOption(
                    id=o.id, text=o.option_text, is_correct_answer=o.is_correct_answer
                )
                for o in question.options
            ]
        ),
        expected_answers=list(question.expected_answers or []),
        answer_matching=question.answer_matching,
        image=(
            DeliveredImage(
                image_url=question.image.image_url,
                canvas_width=question.image.canvas_width,
                annotations=list(question.image.annotations or []),
            )
            if question.image is not None
            else None
        ),
        from_snapshot=False,
    )


def delivered_questions(attempt, quiz) -> list[DeliveredQuestion]:
    """What THIS attempt received, in the order it received it.

    Reads `attempt.question_snapshots` when they exist, falling back to the
    live quiz only for attempts that predate Phase 1.

    READ-ONLY. Nothing here mutates a snapshot row; the record is written once
    at `/play/start` and never rewritten, which is what makes it evidence.
    """
    rows = sorted(attempt.question_snapshots, key=lambda r: r.position)
    if rows:
        return [_from_snapshot(row, number) for number, row in enumerate(rows, start=1)]

    # LEGACY. Same content and same 1-based numbering over the position-sorted
    # live questions that every surface used before Phase 4a, so nothing about
    # a pre-Phase-1 attempt changes.
    live = sorted(quiz.questions, key=lambda q: q.position)
    return [_from_live(question, number) for number, question in enumerate(live, start=1)]


def delivered_by_question_id(attempt, quiz) -> dict[int, DeliveredQuestion]:
    """The same list keyed by question id, for surfaces that walk ANSWERS.

    A question deleted after delivery has `question_id` None and simply does
    not appear here - its answers were cascaded away with it, so there is
    nothing left to key.
    """
    return {
        delivered.question_id: delivered
        for delivered in delivered_questions(attempt, quiz)
        if delivered.question_id is not None
    }


def to_player_payload(delivered: DeliveredQuestion, masked_image_url: str | None = None) -> dict:
    """The question as a PLAYER may see it, for resuming an attempt.

    SEPARATE FROM `to_payload` ON PURPOSE, AND THIS SEPARATION IS A SECURITY
    BOUNDARY. The coach payload carries `is_correct_answer` and
    `expected_answers`; handing either to a player mid-quiz would give them the
    answer key. Nothing here is filtered out of a shared dict - the safe shape
    is BUILT, so a field added to the coach serialiser cannot leak by default.

    Withheld deliberately: `is_correct_answer`, `expected_answers`,
    `answer_matching`, `answer_explanation` (practice reveals that through
    /play/check, only after the question is answered).

    `masked_image_url` is passed in rather than derived. A region-backed
    question's picture is a signed, per-access-code masked render, and the
    snapshot deliberately does not record region geometry - see the region
    exception in docs/DESIGN-delivered-question-snapshots.md. It is truthful
    only while region editing stays blocked after delivery.
    """
    payload = {
        "id": delivered.question_id,
        "question_text": delivered.text,
        "question_type": delivered.question_type.value,
        "options": [
            # id + text ONLY. No correctness flag, in any branch.
            {"id": o.id, "option_text": o.text}
            for o in delivered.options
        ],
        "image": (
            {
                "image_url": delivered.image.image_url,
                "canvas_width": delivered.image.canvas_width,
                "annotations": delivered.image.annotations,
            }
            if delivered.image is not None
            else None
        ),
    }
    if masked_image_url is not None:
        payload["masked_image_url"] = masked_image_url
    return payload


def to_payload(delivered: DeliveredQuestion) -> dict:
    """JSON shape for the coach's expanded per-player view.

    Deliberately NOT `Question.to_dict`: that serialises the LIVE authoring
    row, which is the very thing this module exists to stop historical surfaces
    from reading.
    """
    return {
        "question_id": delivered.question_id,
        "question_number": delivered.number,
        "question_text": delivered.text,
        "question_type": delivered.question_type.value,
        "options": [
            {"id": o.id, "option_text": o.text, "is_correct_answer": o.is_correct_answer}
            for o in delivered.options
        ],
        "image": (
            {
                "image_url": delivered.image.image_url,
                "canvas_width": delivered.image.canvas_width,
                "annotations": delivered.image.annotations,
            }
            if delivered.image is not None
            else None
        ),
        #: Lets the UI be honest that a pre-Phase-1 attempt is showing today's
        #: question rather than a recorded one.
        "from_snapshot": delivered.from_snapshot,
    }
