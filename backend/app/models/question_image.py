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
            "updated_at": self.updated_at.isoformat(),
        }
