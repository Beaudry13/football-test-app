"""Question image + annotation-layer model.

`annotations` stores the ordered list of annotation-tool layers (lines,
arrows, shapes, text callouts, styling) as JSON. The frontend drawing tool
owns the shape of each layer object; the backend treats it as an opaque,
schema-validated blob so new annotation types don't require a migration.
"""

from app.extensions import db


class QuestionImage(db.Model):
    __tablename__ = "question_images"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(
        db.Integer, db.ForeignKey("questions.id"), nullable=False, unique=True, index=True
    )
    image_url = db.Column(db.String(1024), nullable=False)
    annotations = db.Column(db.JSON, nullable=False, default=list)
    # The canvas pixel width the annotation tool used when `annotations` was
    # last saved. NULL means "predates this column" - the frontend treats
    # that as the original 900px cap. Pinning this per-image (rather than
    # deriving it at render time) means a later change to the tool's default
    # canvas size can never shift where an already-saved shape's coordinates
    # land.
    canvas_width = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=db.func.now(), onupdate=db.func.now()
    )

    question = db.relationship("Question", back_populates="image")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question_id": self.question_id,
            "image_url": self.image_url,
            "annotations": self.annotations,
            "canvas_width": self.canvas_width,
            "updated_at": self.updated_at.isoformat(),
        }
