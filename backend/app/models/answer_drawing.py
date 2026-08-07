"""A player's drawing on top of a question's image.

Why a separate table rather than columns on Answer: `answers` is the hottest
table in the app (every autosave upserts it; analytics, the dashboard, CSV and
the PDF all bulk-load it) and should stay narrow. A drawing is large and rare,
so it lives beside the answer and is fetched only where it is actually
rendered.

WHY ONE JSON COLUMN AND NOT A COLUMN PER FIELD
----------------------------------------------
The client's DrawingDocument is already a versioned envelope: it carries its
own `format` and `version`, the coordinate space the strokes were authored in,
and an immutable reference to the source image including the version of that
image. Splitting those back out into columns here would store the same facts
twice, and the copy outside the envelope is the one that drifts silently when
the format gains a field.

So the envelope is stored whole, and this table adds only what genuinely does
not belong inside it: a link to the answer, a concurrency counter, and a
pointer to external storage for the flattened preview.

See docs/DESIGN-draw-response-phase-3.md §5, and
frontend/src/components/drawing/types.ts for the document itself.
"""

from sqlalchemy.dialects.postgresql import JSONB

from app.extensions import db


class AnswerDrawing(db.Model):
    __tablename__ = "answer_drawings"

    id = db.Column(db.Integer, primary_key=True)
    # CASCADE: a coach resetting an attempt deletes its answers, and the
    # drawings must go with them rather than being orphaned.
    answer_id = db.Column(
        db.Integer,
        db.ForeignKey("answers.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )

    # The whole DrawingDocument. JSONB rather than JSON so it stays queryable
    # (how many strokes, which region) without a schema change.
    document = db.Column(JSONB, nullable=False)

    # Bumped on every write. The client sends the revision it last saw and is
    # refused with a 409 if it is behind, so a phone that spent five minutes
    # out of signal cannot silently overwrite a drawing the player has since
    # redone somewhere else. Autosave makes that race routine rather than
    # exotic - this is the same reasoning as the upsert in attempts.py.
    revision = db.Column(db.Integer, nullable=False, default=1, server_default="1")

    # Phase 6, for the PDF export. Stays NULL until then. Unlike the fields
    # that were folded into `document`, this genuinely is a column: it points
    # at an object in external storage, not at anything the envelope knows.
    preview_url = db.Column(db.String(1024), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=db.func.now(), onupdate=db.func.now()
    )

    answer = db.relationship("Answer", back_populates="drawing")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "answer_id": self.answer_id,
            "document": self.document,
            "revision": self.revision,
            "preview_url": self.preview_url,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


def document_has_strokes(document: dict | None) -> bool:
    """Whether a stored document represents a real answer.

    An envelope with no strokes is not an answer - it is just the image the
    player was shown. Defined here, next to the storage, so the submit guard
    and the answer-presence rule cannot disagree about it. Mirrors
    `hasDrawnAnswer` in the frontend's drawingDocument.ts.
    """
    if not isinstance(document, dict):
        return False
    strokes = document.get("strokes")
    return isinstance(strokes, list) and len(strokes) > 0
