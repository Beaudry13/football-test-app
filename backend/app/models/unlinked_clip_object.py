"""A clip object that no live question points at any more.

WHY A RECORD IS NEEDED AT ALL
-----------------------------
Replacing or removing a clip deletes the `question_clips` row and DELIBERATELY
leaves the stored object behind, because a delivered snapshot may still name
its `storage_key` and history outranks reclaiming a megabyte. The consequence
is that the moment the row goes, **the key disappears from the database
entirely** - it survives only inside whichever snapshots happen to mention it.

So there is no way to ask "which stored clips does nothing reference?". The
live tables can only ever list keys that ARE referenced; an orphan is by
definition absent from all of them. Without this table the only way to find one
is to enumerate the bucket, and that is the dangerous approach - see below.

WHY NOT LIST THE BUCKET INSTEAD
-------------------------------
Private storage holds five different kinds of object and `new_storage_key`
labels them only by extension. `.mp4` happens to be unique to clip video, but
**`.webp` is produced by four different features**: a clip poster, a rendered
document page, a page thumbnail, and a masked playbook region. Worse, a page
raster is referenced by delivered snapshots through its page ID rather than its
key, so "no row names this key" is not the same question as "nothing needs
these bytes".

A collector reading a bucket listing therefore has to enumerate every producer
correctly, forever, and the cost of getting it wrong once is deleting a coach's
playbook. This table removes that entire class of mistake by construction: the
collector only ever considers objects Peira itself recorded as clip objects, so
it cannot reach a page, a mask, or a PDF even if it is wrong about everything
else.

THIS IS A CANDIDATE LIST, NOT A DELETE LIST
-------------------------------------------
A row here means "no live question pointed at this at the moment it was
unlinked". It does NOT mean the object is unreferenced - a delivered snapshot
very often still names it, which is the whole reason the object was left alone.
Reachability is re-decided at collection time against the live tables AND the
snapshots, never assumed from this row. See `services/clip_gc.py`.

WHAT IS DELIBERATELY MISSING: A BACKFILL
----------------------------------------
Clip objects orphaned before this table existed are not in it and cannot be
found without the bucket listing this design rejects. They stay forever. That
is a false negative - we keep bytes a little longer than necessary - which is
the acceptable direction of this trade, and it costs almost nothing because
Record Clip had been live for days rather than months when this shipped.
"""

from app.extensions import db


class UnlinkedClipObject(db.Model):
    __tablename__ = "unlinked_clip_objects"

    id = db.Column(db.Integer, primary_key=True)

    #: The opaque private-storage key. NOT unique, on purpose: a duplicate row
    #: is harmless (the collector de-duplicates and re-checks reachability
    #: anyway), whereas a unique violation would turn a coach's ordinary
    #: "remove this clip" into a 500. Retention bias applies to the coach's
    #: workflow too.
    storage_key = db.Column(db.String(512), nullable=False, index=True)

    #: "video" or "poster". A plain string rather than a native Postgres enum:
    #: adding a member to one of those cannot happen in the same transaction
    #: that created it, and no operational value here is worth that migration
    #: hazard. Nothing branches on this except operator-facing reporting.
    kind = db.Column(db.String(16), nullable=False)

    #: Carried so an operator reading the audit knows what the bytes were
    #: without fetching them.
    content_type = db.Column(db.String(128), nullable=True)

    #: Context only, and it is allowed to dangle. SET NULL rather than CASCADE:
    #: a deleted question is one of the ways an object becomes unlinked in the
    #: first place, so cascading would erase exactly the rows that deletion
    #: created.
    question_id = db.Column(
        db.Integer, db.ForeignKey("questions.id", ondelete="SET NULL"), nullable=True
    )

    #: When the last live row stopped pointing at the object. THE GRACE PERIOD
    #: IS MEASURED FROM HERE.
    unlinked_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )

    #: NULL = still a candidate. Set when the object has actually been deleted
    #: from storage. The row is never deleted for it - same reasoning as
    #: `question_exclusions.restored_at`: what was reclaimed, and when, is the
    #: only audit trail this operation leaves, and it is also what makes the
    #: collector idempotent rather than merely re-runnable.
    collected_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - operator convenience
        state = "collected" if self.collected_at else "candidate"
        return f"<UnlinkedClipObject {self.kind} {self.storage_key[:12]}... {state}>"
