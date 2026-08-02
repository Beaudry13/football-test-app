"""Coach-scoped quiz folder, for dashboard organization."""

from app.extensions import db
from app.models.mixins import TimestampMixin


class Folder(TimestampMixin, db.Model):
    __tablename__ = "folders"

    id = db.Column(db.Integer, primary_key=True)
    # Folders are org-shared: organization_id scopes visibility *and* editing
    # (any member can rename/delete). coach_id is creator attribution only.
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name = db.Column(db.String(255), nullable=False)

    organization = db.relationship("Organization", back_populates="folders")
    coach = db.relationship("Coach", back_populates="folders", foreign_keys=[coach_id])
    # No cascade here - deleting a folder must not delete its quizzes, they
    # fall back to folder_id=NULL ("Uncategorized") via the FK's
    # ondelete="SET NULL" (see Quiz.folder_id).
    quizzes = db.relationship("Quiz", back_populates="folder")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "coach_id": self.coach_id,
            "name": self.name,
            "quiz_count": len(self.quizzes),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
