"""Coach-scoped quiz folder, for dashboard organization."""

from app.extensions import db
from app.models.mixins import TimestampMixin

#: Which part of PEIRA a folder belongs to. ONE folder system, two separate
#: trees: a quiz folder is only ever seen by Quizzes and holds quizzes; a
#: motion folder is only ever seen by Motion Lab and holds plays. Every
#: pre-existing folder is "quizzes" (the migration's server default), and the
#: quiz routes read that area only - so quiz folders behave exactly as before.
#:
#: Kept apart on purpose rather than one mixed tree: visible_folders decides a
#: coach's quiz folders from the quizzes they own, so a folder holding only
#: plays would vanish from their view. Merging the trees later is easy;
#: splitting a mixed one is not.
FOLDER_AREA_QUIZZES = "quizzes"
FOLDER_AREA_MOTION = "motion"
FOLDER_AREAS = (FOLDER_AREA_QUIZZES, FOLDER_AREA_MOTION)


class Folder(TimestampMixin, db.Model):
    __tablename__ = "folders"
    __table_args__ = (
        # varchar + CHECK rather than a native enum - see CLAUDE.md #8.
        db.CheckConstraint("area IN ('quizzes', 'motion')", name="ck_folders_area"),
    )

    id = db.Column(db.Integer, primary_key=True)
    area = db.Column(
        db.String(16),
        nullable=False,
        default=FOLDER_AREA_QUIZZES,
        server_default=FOLDER_AREA_QUIZZES,
        index=True,
    )
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
            "area": self.area,
            # No quiz_count/subfolder_count here on purpose. They used to be
            # serialised and were read by nothing: both counted DIRECT
            # children only, and quiz_count counted the whole organization's
            # quizzes rather than the requesting coach's - so wiring either
            # into Coach View would have reported a teammate's work. Folder
            # totals are computed client-side from data already scoped for
            # the viewer (frontend/src/pages/folderTotals.ts), which is the
            # only place that can know whose quizzes are being counted.
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
