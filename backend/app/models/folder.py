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
    # Nullable = root folder. Nesting is unlimited in depth.
    #
    # Settable only at creation (see routes/folders.py) - never changed by the
    # rename route, and there is no reparent route - which is what makes
    # "can't become its own parent" and "can't create a cycle" true by
    # construction rather than needing extra guard logic: a folder's parent is
    # fixed the moment it exists, and it can't reference an id (its own) that
    # doesn't exist yet. That argument does not depend on how deep the tree
    # goes, which is why lifting the old two-level cap needed no new guard -
    # but introducing folder-MOVING would break it and would need one.
    # ondelete="RESTRICT": the DB itself refuses to delete a folder that still
    # has subfolders, backing up the same check in delete_folder().
    parent_folder_id = db.Column(
        db.Integer, db.ForeignKey("folders.id", ondelete="RESTRICT"), nullable=True, index=True
    )

    organization = db.relationship("Organization", back_populates="folders")
    coach = db.relationship("Coach", back_populates="folders", foreign_keys=[coach_id])
    # No cascade here - deleting a folder must not delete its quizzes, they
    # fall back to folder_id=NULL ("Uncategorized") via the FK's
    # ondelete="SET NULL" (see Quiz.folder_id).
    quizzes = db.relationship("Quiz", back_populates="folder")
    subfolders = db.relationship(
        "Folder", back_populates="parent_folder", foreign_keys=[parent_folder_id]
    )
    parent_folder = db.relationship(
        "Folder", back_populates="subfolders", remote_side=[id], foreign_keys=[parent_folder_id]
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "coach_id": self.coach_id,
            "name": self.name,
            "parent_folder_id": self.parent_folder_id,
            "quiz_count": len(self.quizzes),
            "subfolder_count": len(self.subfolders),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
