"""A player's drawing on top of a question's image.

Mirrors QuestionImage deliberately - same 1:1 shape, same opaque JSON
stroke blob, same pinned coordinate space - so there is one storage idea in
this codebase for "vector marks over a picture", not two.

Why a separate table rather than columns on Answer: `answers` is the
hottest table in the app (every autosave upserts it; analytics, the
dashboard, CSV and the PDF all bulk-load it) and should stay narrow. A
drawing is large and rare, so it lives beside the answer and is fetched
only where it's actually rendered.

`strokes` is a Fabric object array in exactly the format
question_images.annotations already uses, which is what lets the coach-side
viewer render coach annotations and player strokes as two layers on one
canvas with no second renderer.
"""

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
    strokes = db.Column(db.JSON, nullable=False, default=list)

    # The coordinate space the strokes were authored in. NOT nullable -
    # unlike question_images.canvas_width there is no legacy data to
    # accommodate here, and a stroke array without its space is
    # unrenderable. See frontend canvasSizing.ts for why this must never be
    # changed in place for an existing row.
    canvas_width = db.Column(db.Integer, nullable=False)
    canvas_height = db.Column(db.Integer, nullable=False)

    # A snapshot of the image the player actually drew on. A coach can
    # replace a question's image after players have answered; without this
    # there would be no way to tell that the strokes now float over a
    # different picture.
    source_image_url = db.Column(db.String(1024), nullable=False)

    # Flattened composite (image + any coach annotations + player strokes).
    # A CACHE, never the record: where preview and strokes disagree the
    # strokes win, and the coach-facing view always renders from strokes.
    # This exists so the PDF export can embed a drawing with one call to
    # the image machinery that already exists, instead of needing a
    # server-side Fabric renderer (which does not exist for Python).
    # Nullable and tolerated as missing - a drawing with no preview must
    # degrade to a placeholder, never fail a 50-page report.
    preview_url = db.Column(db.String(1024), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=db.func.now(), onupdate=db.func.now()
    )

    answer = db.relationship("Answer", back_populates="drawing")

    def to_dict(self, include_strokes: bool = False) -> dict:
        """`include_strokes` defaults to False on purpose: the stroke blob is
        large, and the bulk answer loads (analytics, dashboard, CSV) only
        need to know a drawing EXISTS. Only the player's resume and the
        coach's grading view ask for the strokes themselves."""
        data = {
            "id": self.id,
            "answer_id": self.answer_id,
            "canvas_width": self.canvas_width,
            "canvas_height": self.canvas_height,
            "source_image_url": self.source_image_url,
            "preview_url": self.preview_url,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_strokes:
            data["strokes"] = self.strokes
        return data
