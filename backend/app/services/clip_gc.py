"""Reclaiming clip objects that nothing can reach any more.

THE PROBLEM THIS SOLVES, AND THE ONE IT MUST NOT CAUSE
------------------------------------------------------
Replacing or removing a clip leaves its stored object behind on purpose: a
delivered snapshot freezes the clip's STORAGE KEY, so a finished attempt can
still resolve to the exact bytes that player was shown. That protection is
correct and nothing here weakens it. What was missing is the other half - once
NOTHING references an object any more, it is still never reclaimed.

The naive collector is "delete every stored clip not named by a
`question_clips` row". That deletes the evidence of every past attempt, because
the whole point of the design is that history references keys the live tables
no longer do. It is the one mistake this module exists to make impossible.

THE SAFETY RULE, STATED ONCE
----------------------------
An object is collectable only when ALL of these hold:

  1. it was recorded as unlinked (`unlinked_clip_objects`), so we know it is a
     clip object and not a playbook page that shares its file extension;
  2. no live `question_clips` row names it, as video OR as poster;
  3. no `attempt_question_snapshots` row names it, as video OR as poster;
  4. it has been unlinked for longer than the grace period;
  5. it has not already been collected.

(2) and (3) are re-derived at collection time, never inherited from the
tombstone. A row in `unlinked_clip_objects` is a CANDIDATE, and most candidates
are not collectable - a delivered clip is unlinked the moment a coach replaces
it, and stays referenced by every attempt that received it.

ASYMMETRIC BY DESIGN. Missing an orphan costs a megabyte. Deleting a
referenced object destroys the record of what a player was actually shown,
which nothing can rebuild. Every ambiguity here therefore resolves to KEEP:

* a snapshot whose JSON cannot be read contributes no keys, and nothing infers
  deletability from that silence either
* a key nothing recorded as a clip object is not a candidate at all
* a storage delete that fails leaves `collected_at` NULL, so the next run
  simply tries again rather than recording a reclamation that did not happen

WHY NOT ENUMERATE THE BUCKET
----------------------------
See the header of `models/unlinked_clip_object.py`. Short version: `.webp` is
produced by four different features, and one of them is referenced by ID rather
than by key, so a listing-based collector has to be exhaustively right about
every producer forever or it deletes a coach's playbook. Anchoring on what
Peira itself recorded removes that failure mode structurally.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from app.extensions import db
from app.models import AttemptQuestionSnapshot, QuestionClip, UnlinkedClipObject

#: HOW LONG AN UNLINKED OBJECT IS KEPT BEFORE IT CAN BE COLLECTED.
#:
#: This is NOT protecting against a transactional race. Reachability is
#: re-checked at collection time against committed rows, so a snapshot written
#: while a coach was removing a clip is seen either way and the object is kept.
#:
#: It is protecting against PEOPLE. A coach removes the wrong clip, or resets
#: an attempt and then wants the film back; nothing in the product restores
#: either, but while the bytes still exist an operator can. Thirty days spans a
#: coach noticing at the next film session rather than only within the same
#: week, and at roughly 0.15-2 MB per clip the storage that buys is negligible.
#: Seven days would expire before a coach who opens Peira on game weeks had
#: looked twice.
GRACE_PERIOD_DAYS = 30

KIND_VIDEO = "video"
KIND_POSTER = "poster"

#: Clip posters are always WebP - see `clip_storage.POSTER_CONTENT_TYPE`. Held
#: here so a tombstone can record what the bytes were without the poster's own
#: content type having been stored on the clip row (it never was: the media
#: route answers posters with a constant).
POSTER_CONTENT_TYPE = "image/webp"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Recording an unlink
# --------------------------------------------------------------------------


def _tombstones_for(clip: QuestionClip) -> list[UnlinkedClipObject]:
    """Both objects a clip owns. The poster is not optional to record - a
    poster orphan is smaller but is still an orphan, and leaving it out would
    make "collect clip storage" quietly mean "collect half of it"."""
    rows = [
        UnlinkedClipObject(
            storage_key=clip.storage_key,
            kind=KIND_VIDEO,
            content_type=clip.content_type,
            question_id=clip.question_id,
        )
    ]
    if clip.poster_key:
        rows.append(
            UnlinkedClipObject(
                storage_key=clip.poster_key,
                kind=KIND_POSTER,
                content_type=POSTER_CONTENT_TYPE,
                question_id=clip.question_id,
            )
        )
    return rows


def _record_unlinked_clips(session, flush_context, instances) -> None:
    """Tombstone every `QuestionClip` about to be deleted in this flush.

    ONE HOOK RATHER THAN FOUR CALL SITES, and that is deliberate. A clip row
    stops being live in four places today - replacing a clip, removing it,
    deleting the question, deleting the quiz - and only the first two are
    explicit; the other two arrive through `cascade="all, delete-orphan"`
    without any clip code running. Listing them by hand would mean a future
    fifth path silently stops being recorded.

    `before_flush` is the sanctioned place to add objects to a session;
    `before_delete` fires mid-flush, where adding is not allowed.

    A MISSED TOMBSTONE IS SAFE. It means the object is never collected, which
    is the retention side of the trade. That is why this hook is allowed to be
    quiet rather than defensive.
    """
    new_rows: list[UnlinkedClipObject] = []
    for instance in session.deleted:
        if isinstance(instance, QuestionClip) and instance.storage_key:
            new_rows.extend(_tombstones_for(instance))
    for row in new_rows:
        session.add(row)


_LISTENER_ATTACHED = False


def register_clip_unlink_tracking() -> None:
    """Attach the tombstone hook. Idempotent - the test suite builds many apps
    against one shared session factory, and attaching twice would write two
    rows per unlink."""
    global _LISTENER_ATTACHED
    if _LISTENER_ATTACHED:
        return
    event.listen(db.session, "before_flush", _record_unlinked_clips)
    _LISTENER_ATTACHED = True


# --------------------------------------------------------------------------
# Deciding what is reachable
# --------------------------------------------------------------------------


def referenced_clip_keys() -> set[str]:
    """Every clip object key anything can still legitimately reach.

    TWO SOURCES, AND THE SECOND IS THE ONE THAT MATTERS:

    * `question_clips` - what a coach's quizzes point at right now. Includes
      duplicated quizzes and retests, which carry their OWN copied objects
      (`copy_clip_object`), so a duplicate protects its own bytes rather than
      the original's.
    * `attempt_question_snapshots` - what finished and in-progress attempts
      were actually DELIVERED. This is the history the whole leave-it-in-place
      rule exists to protect.

    Both video and poster keys are collected from both.
    """
    keys: set[str] = set()

    for storage_key, poster_key in db.session.query(
        QuestionClip.storage_key, QuestionClip.poster_key
    ).all():
        if storage_key:
            keys.add(storage_key)
        if poster_key:
            keys.add(poster_key)

    # Read in Python rather than with a JSONB path expression. The snapshot
    # column is a plain JSONB blob whose shape has already changed once
    # (`decision_point_ms` was added to it without a migration), and a query
    # that silently returns nothing when the shape moves would look exactly
    # like "no attempt references this" - the single most dangerous wrong
    # answer this module can produce. This runs from a maintenance tool rather
    # than a request, so the cost is affordable - but the rows are STREAMED,
    # because reading whole blobs is not a reason to hold every attempt's
    # delivered content in memory at once.
    snapshots = db.session.query(AttemptQuestionSnapshot.snapshot).yield_per(500)
    for (snapshot,) in snapshots:
        if not isinstance(snapshot, dict):
            continue
        clip = snapshot.get("clip")
        if not isinstance(clip, dict):
            continue
        for field in ("storage_key", "poster_key"):
            value = clip.get(field)
            if isinstance(value, str) and value:
                keys.add(value)

    return keys


@dataclass(frozen=True)
class OrphanCandidate:
    """One collectable object, with enough context for an operator to judge it."""

    id: int
    storage_key: str
    kind: str
    content_type: str | None
    unlinked_at: datetime | None


@dataclass(frozen=True)
class CollectionPlan:
    """What a run would do, computed WITHOUT touching storage.

    Separating this from execution is the point: the plan is what gets audited,
    reviewed and tested, and the executor does nothing but carry it out.
    """

    collectable: list[OrphanCandidate]
    still_referenced: int
    within_grace: int
    already_collected: int

    @property
    def total_candidates(self) -> int:
        return (
            len(self.collectable)
            + self.still_referenced
            + self.within_grace
            + self.already_collected
        )


def plan_collection(
    *, grace_days: int = GRACE_PERIOD_DAYS, now: datetime | None = None
) -> CollectionPlan:
    """Decide what is safe to reclaim. Reads only; changes nothing."""
    moment = now or _now()
    cutoff = moment - timedelta(days=grace_days)
    referenced = referenced_clip_keys()

    collectable: list[OrphanCandidate] = []
    still_referenced = 0
    within_grace = 0
    already_collected = 0
    # A key can legitimately appear on more than one tombstone. Only the first
    # becomes a planned deletion; the rest must not be reported as further
    # reclaimable objects, or an operator reading "3 objects" would be wrong
    # about how much is actually being freed.
    planned_keys: set[str] = set()

    for row in db.session.query(UnlinkedClipObject).order_by(UnlinkedClipObject.id).all():
        if row.collected_at is not None:
            already_collected += 1
            continue
        if row.storage_key in referenced:
            still_referenced += 1
            continue

        unlinked_at = row.unlinked_at
        if unlinked_at is not None and unlinked_at.tzinfo is None:
            # Postgres hands these back aware; a hand-built row in a test may
            # not. Treat naive as UTC rather than crashing the comparison,
            # because crashing mid-plan leaves an operator with no answer.
            unlinked_at = unlinked_at.replace(tzinfo=timezone.utc)
        if unlinked_at is None or unlinked_at > cutoff:
            # A row with no timestamp cannot prove it is past grace, so it
            # waits. Retention bias, applied to our own bookkeeping.
            within_grace += 1
            continue

        if row.storage_key in planned_keys:
            already_collected += 1
            continue
        planned_keys.add(row.storage_key)

        collectable.append(
            OrphanCandidate(
                id=row.id,
                storage_key=row.storage_key,
                kind=row.kind,
                content_type=row.content_type,
                unlinked_at=unlinked_at,
            )
        )

    return CollectionPlan(
        collectable=collectable,
        still_referenced=still_referenced,
        within_grace=within_grace,
        already_collected=already_collected,
    )


# --------------------------------------------------------------------------
# Carrying the plan out
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CollectionResult:
    deleted: list[str]
    failed: list[str]


def execute_collection(
    plan: CollectionPlan, *, now: datetime | None = None
) -> CollectionResult:
    """Delete the planned objects and mark them collected.

    STORAGE FIRST, THEN THE ROW - the opposite ordering to
    `tools/production_cleanup.py`, for a reason worth stating. There the rows
    describe a live product, so a half-finished run must never leave a customer
    pointing at files that are gone. Here the row is only bookkeeping about
    bytes nothing references: marking it collected before the delete succeeded
    would hide the object from every future run, a permanent leak recorded as a
    success. Storage first means the worst case is a row retried next run, and
    deleting an object that is already gone is not an error.

    Each object is committed on its own, so a failure part-way through keeps
    every reclamation already made instead of rolling the run back into a claim
    that does not match storage.
    """
    from app.services.private_storage import get_private_storage

    moment = now or _now()
    storage = get_private_storage()
    deleted: list[str] = []
    failed: list[str] = []

    for candidate in plan.collectable:
        try:
            storage.delete_private(candidate.storage_key)
        except Exception:
            # Reported, never raised. One unreachable object must not cost the
            # operator the rest of the run.
            failed.append(candidate.storage_key)
            continue

        # Every tombstone naming this key, not only the planned one, so a
        # duplicate row does not keep pointing at bytes that are now gone.
        db.session.query(UnlinkedClipObject).filter(
            UnlinkedClipObject.storage_key == candidate.storage_key,
            UnlinkedClipObject.collected_at.is_(None),
        ).update({"collected_at": moment}, synchronize_session=False)
        db.session.commit()
        deleted.append(candidate.storage_key)

    return CollectionResult(deleted=deleted, failed=failed)
