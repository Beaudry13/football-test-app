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

#: How a set of selections reads on ONE LINE: "Mike; Nickel; Boundary Safety".
#:
#: Defined once because the player's results page, the coach's expanded view and
#: the CSV all print it, and three separators that merely happen to match today
#: is how a coach ends up reading the same answer two different ways in two
#: places. Semicolon rather than comma because option wording contains commas
#: far more often than semicolons, and this string lands in a CSV cell.
SELECTION_SEPARATOR = "; "


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
    #: WHAT THE PLAYER'S CLIENT CALLED THIS IMAGE. A Draw Response document
    #: records it as `source.image_id`, so this is the field that binds a
    #: drawing permanently to the picture it was drawn on.
    #:
    #: None for a snapshot written before Phase A, and for the legacy
    #: live-question fallback where no delivery was ever recorded. None means
    #: "not recorded" and must never be treated as "matches anything".
    image_id: int | None = None


@dataclass(frozen=True)
class DeliveredClip:
    """The clip one attempt was shown.

    Carries the STORAGE KEY, not the live clip row's id. Replacing a clip
    writes a new row and leaves the old object in place, so a key resolves to
    the exact bytes this player received; following the row would follow the
    coach's edit instead.

    `clip_id` is kept alongside it as a historical label - the same way
    DeliveredImage keeps `image_id` - so a signed URL can be minted for a
    surface that is showing today's clip, while anything replaying history
    reads the key.
    """

    storage_key: str
    content_type: str
    poster_key: str | None = None
    duration_ms: int | None = None
    width: int | None = None
    height: int | None = None
    clip_id: int | None = None


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
    #: "Select all that apply" AS DELIVERED. Read from the snapshot so a coach
    #: flipping the setting later cannot change how an in-progress attempt
    #: behaves - the same rule the rest of the delivered content follows.
    allows_multiple_answers: bool
    image: DeliveredImage | None
    #: False means this attempt predates Phase 1 and the content below came
    #: from the live question. Never silently conflate the two.
    from_snapshot: bool
    #: The `attempt_question_snapshots` row this came from, or None for the
    #: legacy live fallback. It is what a delivered-mask URL is keyed by, so a
    #: region question's picture can be resolved from the DELIVERY rather than
    #: from a rectangle the coach may have moved since.
    snapshot_id: int | None = None
    #: True when that row froze region geometry. False for a delivery captured
    #: before it was recorded - which must fall back to the live region, since
    #: nothing about what it received was ever written down.
    has_delivered_region: bool = False
    #: The playbook page this question was built from, as a coach reads it -
    #: ("Defensive Playbook", 12). Both frozen at delivery: a page number could
    #: be looked up live and stay honest, but a playbook can be RENAMED, and a
    #: rename must not rewrite an export of a Peira that finished months ago.
    #:
    #: None on a delivery captured before these were recorded. The caller falls
    #: back to the live document and says so - see `playbook_reference`.
    delivered_document_title: str | None = None
    delivered_page_number: int | None = None
    #: None for every question not delivered with a recorded clip, which is
    #: all of them before this feature existed. Declared last because the
    #: fields above it have no defaults and a dataclass will not allow a
    #: defaulted field to precede them.
    clip: DeliveredClip | None = None

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

    def selected_texts(
        self, option_ids, fallbacks: dict[int, str] | None = None
    ) -> list[str]:
        """The chosen options' DELIVERED wording, IN DELIVERED ORDER.

        THE ORDER IS THE QUESTION'S, NOT THE PLAYER'S. `answer_selected_options`
        has no order column - order is not a property of a set, and exact-set
        grading must never depend on the sequence a player happened to tap. So
        display order has to be decided somewhere, and the only choice that
        means anything to a reader is the order the options appeared in on the
        player's screen. Insertion order would make the same answer print
        differently for two players who tapped the same boxes in a different
        sequence, and would make Results, CSV and PDF agree only by accident.

        `fallbacks` is a DEFENSIVE COMPATIBILITY PATH, not part of normal
        behaviour: an id the delivered record never saw, resolved against the
        live row rather than blanked. Since 4a-bis a resumed attempt is served
        its own delivered options, so a player cannot be shown - or submit - an
        id the snapshot never saw; what remains reachable is a legacy attempt
        or a hand-made API call. Blanking there would erase a real answer to
        protect a record that does not describe it. Those come last, since a
        delivered record has no position to put them in.
        """
        chosen = set(option_ids)
        texts = [o.text for o in self.options if o.id in chosen]

        known = {o.id for o in self.options}
        for option_id in option_ids:
            if option_id in known:
                continue
            fallback = (fallbacks or {}).get(option_id)
            if fallback is not None:
                texts.append(fallback)
        return texts

    @property
    def correct_option_texts(self) -> list[str]:
        """Every correct option, in delivered order."""
        return [o.text for o in self.options if o.is_correct_answer]

    @property
    def correct_option_text(self) -> str | None:
        """The answer key, as one line.

        A SET QUESTION HAS A SET ANSWER. Returning only the first correct
        option here told a player who had correctly ticked Mike AND Nickel that
        the correct answer was "Mike" - which reads as a grading mistake, on the
        one surface that exists to explain their grade.

        Single choice keeps the old behaviour EXACTLY, first-correct included:
        that shape is validated to have exactly one correct option, so joining
        would change nothing except on data authoring already refuses.
        """
        if self.allows_multiple_answers:
            texts = self.correct_option_texts
            return SELECTION_SEPARATOR.join(texts) if texts else None
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
        allows_multiple_answers=bool(data.get("allows_multiple_answers")),
        image=(
            DeliveredImage(
                image_url=image.get("image_url"),
                canvas_width=image.get("canvas_width"),
                annotations=list(image.get("annotations") or []),
                image_id=image.get("image_id"),
            )
            if isinstance(image, dict) and image.get("image_url")
            else None
        ),
        clip=_clip_from_snapshot(data.get("clip")),
        from_snapshot=True,
        snapshot_id=row.id,
        has_delivered_region=bool(data.get("region")),
        delivered_document_title=(data.get("region") or {}).get("document_title"),
        delivered_page_number=(data.get("region") or {}).get("page_number"),
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
        allows_multiple_answers=bool(question.allows_multiple_answers),
        image=(
            DeliveredImage(
                image_url=question.image.image_url,
                canvas_width=question.image.canvas_width,
                annotations=list(question.image.annotations or []),
                image_id=question.image.id,
            )
            if question.image is not None
            else None
        ),
        clip=(
            DeliveredClip(
                storage_key=question.clip.storage_key,
                content_type=question.clip.content_type,
                poster_key=question.clip.poster_key,
                duration_ms=question.clip.duration_ms,
                width=question.clip.width,
                height=question.clip.height,
                clip_id=question.clip.id,
            )
            if question.clip is not None
            else None
        ),
        from_snapshot=False,
    )


def _clip_from_snapshot(raw) -> DeliveredClip | None:
    """Reads a clip out of a snapshot blob, tolerating every older shape.

    Snapshots written before this feature have no `clip` key at all, and that
    is not a defect - it is the honest record that the attempt was delivered
    no clip. Returning None rather than reaching for the live question is what
    keeps a finished attempt describing itself.
    """
    if not isinstance(raw, dict):
        return None
    key = raw.get("storage_key")
    if not key:
        return None
    return DeliveredClip(
        storage_key=key,
        content_type=raw.get("content_type") or "video/mp4",
        poster_key=raw.get("poster_key"),
        duration_ms=raw.get("duration_ms"),
        width=raw.get("width"),
        height=raw.get("height"),
        clip_id=raw.get("clip_id"),
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


PLAYBOOK_REFERENCE_SEPARATOR = " - "


def playbook_reference(delivered: DeliveredQuestion, live_question=None) -> str | None:
    """"Defensive Playbook - Page 12", or None if this is not a playbook question.

    THE ONE PLACE THAT TURNS A DELIVERY INTO WORDS A COACH READS. A CSV cell
    cannot hold a picture, so it holds the thing a coach can act on instead:
    enough to open the right playbook at the right page. Deliberately no id,
    coordinate, URL or token - none of those help anyone holding a spreadsheet.

    THE DELIVERED VALUES WIN, and the title is why. `PATCH /documents/<id>`
    renames a playbook, so resolving it live would rewrite the export of a
    Peira that finished months ago. The page number would have been safe either
    way - a DocumentPage is immutable - but both are frozen together so a
    reader never has to combine one frozen value with one live lookup.

    `live_question` is a COMPATIBILITY FALLBACK for a delivery captured before
    those fields existed, and only that. It is the same concession
    `from_snapshot` marks elsewhere: nothing about what those attempts received
    was written down, and the choice is between today's title and no reference
    at all. Only the title can be stale there, and it is not claimed otherwise.
    """
    title = delivered.delivered_document_title
    page = delivered.delivered_page_number

    if title is None or page is None:
        region = (
            live_question.regions[0]
            if live_question is not None and live_question.regions
            else None
        )
        if region is None or region.document_page is None:
            return None
        page = page if page is not None else region.document_page.page_number
        title = title if title is not None else region.document_page.source_document.title

    if title is None or page is None:
        return None
    return f"{title}{PLAYBOOK_REFERENCE_SEPARATOR}Page {page}"


def selection_texts(delivered: DeliveredQuestion, answer) -> list[str]:
    """What this answer SELECTED, as delivered wording in delivered order.

    THE SOURCE DEPENDS ON THE DELIVERED FORMAT, and reading the wrong one is
    exactly the bug this exists to fix. A multi-select answer stores its set in
    `answer_selected_options` and leaves `selected_option_id` NULL; every
    surface that resolved the column alone therefore printed "No answer" over a
    player who had ticked three boxes.

    Branching on the DELIVERED `allows_multiple_answers` - not today's - means a
    single-choice answer follows the identical path it always did, down to the
    live-option fallback, so nothing about existing results can move.

    THIS IS THE ONLY WAY TO TURN A RECORDED SELECTION INTO WORDS. The
    single-option helper this replaced was deliberately deleted rather than
    left beside it: it looked like the right thing to call, and calling it is
    precisely how a future surface would print "No answer" over three ticked
    boxes again.
    """
    if answer is None:
        return []

    if not delivered.allows_multiple_answers:
        if answer.selected_option_id is None:
            return []
        option_ids = [answer.selected_option_id]
    else:
        option_ids = [row.option_id for row in answer.selected_options]

    # ONLY the single-choice column has a live row to fall back on. A
    # multi-select selection has no such column, and needs none: the format
    # shipped after Phase 1, so every answer that has one also has a delivered
    # snapshot to resolve it against.
    fallbacks = (
        {answer.selected_option_id: answer.selected_option.option_text}
        if answer.selected_option is not None
        else {}
    )
    return delivered.selected_texts(option_ids, fallbacks=fallbacks)


def selection_text(delivered: DeliveredQuestion, answer) -> str | None:
    """The same selections as one line. None when nothing was selected.

    None rather than "" so callers keep expressing "unanswered" the way they
    already do - the CSV's existing unanswered semantics are untouched, and no
    fake value is invented for an empty set.
    """
    texts = selection_texts(delivered, answer)
    return SELECTION_SEPARATOR.join(texts) if texts else None


def to_player_payload(
    delivered: DeliveredQuestion,
    masked_image_url: str | None = None,
    clip_url: str | None = None,
    clip_poster_url: str | None = None,
) -> dict:
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
        # HOW MANY ANSWERS MAY BE PICKED - not which. Carries no correctness
        # information, so it is safe mid-quiz; without it the client cannot
        # know whether to render one choice or several.
        "allows_multiple_answers": delivered.allows_multiple_answers,
        "options": [
            # id + text ONLY. No correctness flag, in any branch.
            {"id": o.id, "option_text": o.text}
            for o in delivered.options
        ],
        "image": (
            {
                # The DELIVERED identity, so the client binds a new drawing to
                # the picture this attempt actually received rather than to
                # whatever the live question points at today.
                "id": delivered.image.image_id,
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
    if clip_url is not None:
        # A SIGNED, SHORT-LIVED URL, passed in rather than derived, for the
        # same reason `masked_image_url` is: minting a token needs the access
        # code this player is using, and this function is deliberately
        # identity-free. Dimensions travel with it so the player's layout can
        # reserve the right box before a byte of video arrives.
        payload["clip"] = {
            "url": clip_url,
            "poster_url": clip_poster_url,
            "content_type": delivered.clip.content_type if delivered.clip else "video/mp4",
            "width": delivered.clip.width if delivered.clip else None,
            "height": delivered.clip.height if delivered.clip else None,
        }
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
        # AS DELIVERED, so the expanded view reads the answer the way the player
        # gave it. Without this the browser cannot tell a set answer from a
        # single choice, and resolving `selected_option_id` - NULL on every
        # multi-select answer - showed "No answer" over three ticked boxes.
        "allows_multiple_answers": delivered.allows_multiple_answers,
        "options": [
            {"id": o.id, "option_text": o.text, "is_correct_answer": o.is_correct_answer}
            for o in delivered.options
        ],
        "image": (
            {
                "id": delivered.image.image_id,
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
