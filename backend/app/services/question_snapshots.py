"""Delivered-question snapshots: writing them, and keeping them readable.

Two responsibilities, deliberately together because they are two halves of one
guarantee:

1. **Capture** - at `POST /play/start`, record what every question in this
   attempt's frozen order actually contained. One definition: *starting an
   attempt freezes what that attempt received.*
2. **Preserve** - when a coach later replaces or removes an image a snapshot
   points at, copy the old object first so the snapshot keeps pointing at real
   bytes.

Phase 1 is WRITE + PRESERVE ONLY. Nothing here is read for product behaviour
yet; scores, grading, Results, exports and analytics are untouched.
"""

from copy import deepcopy

from app.extensions import db
from app.models import Answer, AttemptQuestionSnapshot, Question
from app.models.question import OPTIONLESS_TYPES
from app.services.attempts import delivery_question_ids

#: Bumped only if the SHAPE of `snapshot` changes incompatibly. Stored on every
#: row so a future reader can tell an old shape from a new one WITHOUT guessing
#: from which keys happen to be present - the alternative is sniffing, and
#: sniffing is how "delivered content not recorded" turns into a wrong answer.
#: v2 adds `concept`. Everything v1 recorded is recorded identically - the
#: version moves because a reader must be able to tell "this attempt had no
#: concept" (v2, concept null) from "this attempt predates concepts entirely"
#: (v1, key absent) WITHOUT sniffing for the key. Those two are different
#: facts and only the version distinguishes them.
SNAPSHOT_VERSION = 2


class SnapshotError(RuntimeError):
    """A snapshot that could not be written completely.

    Raised rather than returning a partial result on purpose: a NEW attempt
    must never become "legacy" because a write failed halfway. The caller's
    only correct response is to roll the whole attempt back.
    """


def build_snapshot(question: Question) -> dict:
    """The minimum trustworthy record of what a player was shown.

    WHAT IS IN HERE, AND WHY THESE
    -------------------------------
    Everything needed to answer "what was this question, and what counted as
    right, at the moment it was delivered": the text, the type, the options
    with their correctness, and - for a typed-answer question - the accepted
    answers and the matching mode that graded them - and, since v2, the
    concept it was tagged with.

    WHAT IS DELIBERATELY OUT
    ------------------------
    - `answer_explanation`. Post-answer teaching material. It is already freely
      editable by design (see routes/questions.py), improving it changes
      nobody's score, and freezing it would quietly make a coach's better
      explanation invisible to the very players who needed it.
    - `position`. The delivered position is a COLUMN on the row, because it is
      a property of the delivery, not of the question.
    - timestamps, quiz_id, and every other Question column. This is not a copy
      of the row; do not grow it into one.
    (Region geometry USED to be on this list, on the reasoning that a
    regenerable asset needs no snapshot. It is now recorded - see the `region`
    key below for why that reasoning was wrong.)
    """
    image = question.image
    # V1 permits exactly one region per question; the schema allows more.
    region = question.regions[0] if question.regions else None
    return {
        "version": SNAPSHOT_VERSION,
        "question_text": question.question_text,
        "question_type": question.question_type.value,
        # Withheld for the optionless types for exactly the reason
        # Question.to_dict withholds them: a Draw Response converted from
        # multiple choice may still carry inert option rows (migration
        # d2b5f8a41c32), and recording them would claim the player was offered
        # choices they never saw. Asking OPTIONLESS_TYPES rather than
        # re-listing the types keeps the two from drifting.
        "options": (
            []
            if question.question_type in OPTIONLESS_TYPES
            else [
                {
                    "id": option.id,
                    "text": option.option_text,
                    "is_correct_answer": option.is_correct_answer,
                }
                for option in question.options
            ]
        ),
        #: WHAT THIS QUESTION WAS ABOUT WHEN IT WAS DELIVERED.
        #:
        #: The name travels with the id, and that redundancy is the point. A
        #: coach who renames "Cover 3" to "Cover 3 (base)" in November must not
        #: change what September's analysis says the player was asked about,
        #: and a concept that is later archived must still read. Resolving the
        #: id against the live table at read time would do exactly the thing
        #: this whole snapshot exists to prevent.
        #:
        #: None where the question was untagged - "General" is a rendering
        #: choice, not a stored value, so nothing here has to be invented.
        "concept": (
            {"id": question.concept.id, "name": question.concept.name}
            if question.concept is not None
            else None
        ),
        "expected_answers": question.expected_answers or [],
        "answer_matching": question.answer_matching,
        #: Recorded so a coach flipping "select all that apply" later cannot
        #: change how an attempt already underway behaves.
        "allows_multiple_answers": bool(question.allows_multiple_answers),
        # None when the question has no uploaded still. `annotations` and
        # `canvas_width` travel WITH the url because they are meaningless
        # apart from it: annotations are coordinates in the space
        # `canvas_width` names, against that specific image.
        "image": (
            {
                # THE DELIVERED IMAGE'S IDENTITY, recorded as a historical
                # fact rather than a live foreign key. After a coach replaces
                # the picture this id names a QuestionImage row that no longer
                # exists - which is exactly right: it is what the player's
                # client called the image it was given, and it is what a
                # Draw Response document's `source.image_id` was bound to.
                #
                # Recorded here rather than in a second versioning system,
                # because the snapshot ALREADY answers "what did this attempt
                # receive"; the drawing binding is one more field of that same
                # answer. See docs/DESIGN-draw-response-phase-4.md.
                "image_id": image.id,
                "image_url": image.image_url,
                "canvas_width": image.canvas_width,
                "annotations": image.annotations or [],
            }
            if image is not None
            else None
        ),
        # WHAT THIS ATTEMPT'S MASK WAS A FUNCTION OF, frozen.
        #
        # None for a question that is not built from a playbook page.
        #
        # GEOMETRY, NOT PIXELS, and that is the whole design. A mask is
        # rendered from an IMMUTABLE page raster plus a rectangle; freezing the
        # rectangle therefore freezes the render, with no stored object, no
        # storage lifecycle and no orphan to sweep. It also keeps this module's
        # existing stance - masks are derived and regenerable - and changes
        # only what they are derived FROM: this record instead of the live row.
        #
        # This used to be deliberately EXCLUDED, on the reasoning that a
        # regenerable asset needs no snapshot. That reasoning was wrong, and
        # measurably so (see tests/test_region_delivery_invariant.py): the
        # regeneration read the LIVE rectangle, so a coach moving it changed
        # the picture under an attempt already in progress.
        #
        # `document_page_id` is recorded as a historical fact rather than a
        # live foreign key, exactly as `image_id` above is. The page itself is
        # immutable and cannot be deleted while any region references it.
        "region": (
            {
                "document_page_id": region.document_page_id,
                "x": region.x,
                "y": region.y,
                "width": region.width,
                "height": region.height,
                # The role decides what the render MEANS - a FOCUS or CROP
                # region hides nothing - so a mask cannot be reproduced
                # without it.
                "role": region.role,
                "shape": region.shape,
                # WHAT THE COACH CALLS THIS PAGE, frozen at delivery.
                #
                # `page_number` could be looked up live and stay honest - a
                # DocumentPage is immutable. THE TITLE CANNOT: `PATCH
                # /documents/<id>` renames a playbook, so resolving it live
                # would let a rename rewrite an export of a Peira that finished
                # months ago. Both are recorded together rather than only the
                # unsafe one, so a reader never has to combine one frozen value
                # with one live lookup and reason about which is which.
                #
                # These are for a HUMAN to read - the CSV prints
                # "Defensive Playbook - Page 12". No id, no coordinate and no
                # token belongs in that string.
                "document_title": (
                    region.document_page.source_document.title
                    if region.document_page is not None
                    else None
                ),
                "page_number": (
                    region.document_page.page_number
                    if region.document_page is not None
                    else None
                ),
            }
            if region is not None
            else None
        ),
    }


def snapshot_image_url(snapshot: dict) -> str | None:
    """The stored object a snapshot depends on, or None if it depends on none.

    One accessor, so the preservation code below and any future reader agree
    about where in the blob that url lives.
    """
    image = (snapshot or {}).get("image")
    if not isinstance(image, dict):
        return None
    return image.get("image_url")


def capture_attempt_snapshots(attempt) -> None:
    """Record every question this attempt was delivered. Does NOT commit.

    Called from `/play/start` inside the same transaction that creates the
    attempt, so the two are atomic: there is no state in which an attempt
    exists but its delivery was not recorded.

    UNANSWERED QUESTIONS ARE INCLUDED, and that is the point. This is written
    at delivery, not on first view, because a question the player never opened
    is still a question they were given - and it is still in the denominator.

    Raises SnapshotError if the frozen order names a question the quiz cannot
    produce. That should be impossible at start (the order is derived from the
    live quiz microseconds earlier); it raises rather than skipping because
    silently dropping one would produce exactly the partial record this design
    forbids.
    """
    quiz = attempt.quiz
    if quiz is None:
        raise SnapshotError(f"Attempt {attempt.id} has no quiz to snapshot")

    # THE LIVE QUIZ, deliberately: a new attempt receives the quiz as it stands
    # now. `presented_question_ids` is NOT used here - it now reads the
    # snapshot, which does not exist yet at capture time, and asking it would
    # be circular. The split is what keeps "what a new attempt is given" and
    # "what an existing attempt is shown" from ever being the same question
    # again.
    delivered_ids = delivery_question_ids(attempt, quiz)
    questions_by_id = {question.id: question for question in quiz.questions}

    for position, question_id in enumerate(delivered_ids):
        question = questions_by_id.get(question_id)
        if question is None:
            raise SnapshotError(
                f"Question {question_id} was delivered to attempt {attempt.id} "
                "but could not be read back to snapshot it"
            )
        db.session.add(
            AttemptQuestionSnapshot(
                attempt_id=attempt.id,
                question_id=question.id,
                position=position,
                snapshot=build_snapshot(question),
            )
        )


# ---------------------------------------------------------------------------
# Historical image preservation
# ---------------------------------------------------------------------------
#
# THE TRAP THIS CLOSES
# --------------------
# `_reject_if_already_answered` does not guard the image routes, and both
# `POST .../image` and `DELETE .../image` called `storage.delete_image`
# unconditionally. A coach replacing an image after delivery therefore
# physically destroyed the object a snapshot points at. That is the Duplicate
# Quiz bug (fixed in 0f146bd) wearing a different costume, and it is fixed the
# same way: give history its own object.
#
# COPY-ON-WRITE AT REPLACE/DELETE TIME, NOT AT DELIVERY. Snapshotting bytes
# eagerly would copy an image PER ATTEMPT - a cost paid every time a team takes
# a quiz. Copying when a delivered image is edited pays it only when a coach
# actually edits one, which is rare.
#
# ONE COPY SERVES EVERY AFFECTED SNAPSHOT. Copying per snapshot would be both
# wasteful and dangerous: a partial failure could leave some attempts on the
# old asset and some on a copy, which is one of the four states this must never
# reach.


class _PreservationGuard:
    """Handle yielded by `historical_image_preserved`.

    `track` registers an object the CALLER created inside the block (the
    replacement image, say) so that a transaction failure removes it too.
    Without this the rollback would undo the database half and leak the bytes.
    """

    def __init__(self) -> None:
        self.new_objects: list[str] = []

    def track(self, image_url: str) -> None:
        self.new_objects.append(image_url)


def _repoint_snapshots_onto_a_copy(question: Question, storage, live_url: str) -> list[str]:
    """Copy `live_url` and move every snapshot that depends on it to the copy.

    Returns the objects created (zero or one), for cleanup if the caller's
    transaction then fails. Does not commit.

    Only snapshots pointing at the CURRENT live url are touched. One that was
    already moved to an earlier copy is left alone - its evidence is already
    safe, and repointing it again would abandon a perfectly good object.
    """
    rows = [
        row
        for row in AttemptQuestionSnapshot.query.filter_by(question_id=question.id).all()
        if snapshot_image_url(row.snapshot) == live_url
    ]
    if not rows:
        return []

    # Raises StorageError, which the caller turns into a refusal. Doing this
    # FIRST is the whole safety property: if the copy cannot be made, the
    # coach's destructive operation never starts, and the original is
    # untouched.
    preserved_url = storage.copy_image(live_url)

    for row in rows:
        # Reassigned wholesale rather than mutated in place: SQLAlchemy does
        # not track mutation inside a plain JSONB value, so an in-place edit
        # would be silently dropped at flush - the snapshot would keep pointing
        # at an object we are about to delete.
        updated = deepcopy(row.snapshot)
        updated["image"]["image_url"] = preserved_url
        row.snapshot = updated

    return [preserved_url]


class historical_image_preserved:  # noqa: N801 - used as a context manager
    """Run a destructive image operation without destroying delivered evidence.

    Wraps the caller's database work so the ordering can never be got wrong:

        1. copy the live object and repoint affected snapshots   (before)
        2. the caller's own database changes                     (the block)
        3. COMMIT
        4. only now, delete the superseded live object           (after)

    Each of the four bad states the design names is excluded by that order:

    * *snapshot updated but copy missing* - the copy happens before the
      repoint, and a failed copy aborts the whole operation.
    * *original deleted before preservation succeeded* - the live object is
      deleted after the commit, never before it.
    * *orphaned copies after a DB failure* - a failed transaction removes every
      object this block created, including the copy.
    * *some snapshots on the old asset and some on the copy* - all of them are
      repointed inside one transaction, onto one copy.

    Storage is not transactional, so step 4 leaves the one residue that cannot
    be designed away: a crash between the commit and the delete leaks an
    unreferenced object. That is the deliberately chosen direction - a leaked
    object costs pennies, a destroyed one costs the evidence.
    """

    def __init__(self, question: Question, storage):
        self.question = question
        self.storage = storage
        self.live_url = question.image.image_url if question.image is not None else None
        self.guard = _PreservationGuard()
        self._copies: list[str] = []

    def __enter__(self) -> _PreservationGuard:
        if self.live_url is not None:
            self._copies = _repoint_snapshots_onto_a_copy(
                self.question, self.storage, self.live_url
            )
        return self.guard

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is not None:
            self._undo()
            return False

        try:
            db.session.commit()
        except Exception:
            self._undo()
            raise

        if self.live_url is not None:
            self.storage.delete_image(self.live_url)
        return False

    def _undo(self) -> None:
        # Database FIRST, so nothing can observe a row pointing at an asset
        # that is about to disappear - the same ordering the duplicate-quiz
        # rollback uses, and for the same reason.
        db.session.rollback()
        for url in self._copies + self.guard.new_objects:
            try:
                self.storage.delete_image(url)
            except Exception:  # noqa: BLE001 - cleanup must never mask the real error
                pass


def has_been_delivered(question) -> bool:
    """Whether any attempt was RECORDED as receiving this question.

    THE PHASE 4C WARNING TRIGGER, and the reason Phase 1 exists.

    Deliberately NOT "does an answer row exist". A question can be delivered
    and skipped - the player saw it, scrolled past it and submitted - which
    leaves a snapshot and no answer. Asking about answers would tell that coach
    their correction affects nobody, which is false: it is exactly the question
    somebody looked at and could not do.

    Cheap by construction: an EXISTS against the indexed `question_id`, never a
    load of the snapshot rows themselves.
    """
    return (
        db.session.query(
            AttemptQuestionSnapshot.query.filter_by(question_id=question.id).exists()
        ).scalar()
        or False
    )


def has_history(question) -> bool:
    """Whether editing this question could disturb anything already recorded.

    BROADER THAN `has_been_delivered`, ON PURPOSE, and the two are not
    interchangeable:

      * `has_been_delivered` drives the coach WARNING. Snapshot-based, because
        that is what truthfully answers "did a player receive this".
      * `has_history` drives the ENFORCEMENT below it, and additionally counts
        raw answer rows.

    The gap between them is legacy attempts. A pre-Phase-1 attempt has answers
    and NO snapshot, so a snapshot-only guard would treat a question answered
    last year as pristine and let an unsafe edit through. Locks must fail
    closed; warnings must be honest. That is why there are two.
    """
    return has_been_delivered(question) or (
        db.session.query(Answer.query.filter_by(question_id=question.id).exists()).scalar()
        or False
    )


def delivered_question_ids_for_quiz(quiz_id: int) -> set[int]:
    """Which of a quiz's questions have been delivered, in ONE query.

    The set form exists so the coach's quiz payload can flag every question
    without asking per question - `has_been_delivered` in a loop is an N+1 on
    the screen a coach opens most.
    """
    rows = (
        db.session.query(AttemptQuestionSnapshot.question_id)
        .join(Question, Question.id == AttemptQuestionSnapshot.question_id)
        .filter(Question.quiz_id == quiz_id)
        .distinct()
        .all()
    )
    return {question_id for (question_id,) in rows}
