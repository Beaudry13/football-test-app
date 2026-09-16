"""Motion Lab plays and looks - organization-owned coaching content.

STORE COACH INTENT, DERIVE FOOTBALL BEHAVIOUR
---------------------------------------------
A play's `document` is exactly what a coach authored: who is on the field,
where they line up, the anchors of each path, timing, speed, the ball action
and any second action, engagements, the situation and the path filter. Every
schedule, release time, ball frame and facing is recomputed by the Motion Lab
engine in the browser each time the play opens. Nothing derived is stored,
and services/motion_documents.py refuses any key the authored model does not
have - so derived state cannot creep in later by accident.

The envelope is the frontend's own `Play` model (frontend/src/motion-lab/
engine/play.ts) minus the fields that are columns here (id, name, created /
updated time). `schema_version` is that model's SCHEMA_VERSION.

WHY ONE JSONB COLUMN, not a table per player/path: the document is read and
written whole, is small (a few KB), and the engine - not the database - is
what gives it meaning. Same reasoning as AnswerDrawing.document.

ORGANIZATION-OWNED AND COLLABORATIVE
------------------------------------
`organization_id` decides who may see AND edit: any coach in the organization,
like folders, groups and playbooks - not the quiz creator-or-admin rule. A
coaching staff builds plays together. `created_by_coach_id` is attribution
only, SET NULL so a coach leaving does not take the organization's plays.

`revision` is the concurrency counter: bumped on every content write, and a
write naming an older revision is refused (409) rather than silently
overwriting a teammate's newer version.
"""

from sqlalchemy.dialects.postgresql import JSONB

from app.extensions import db
from app.models.mixins import TimestampMixin


class MotionPlay(TimestampMixin, db.Model):
    __tablename__ = "motion_plays"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    created_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name = db.Column(db.String(255), nullable=False)
    #: Coach intent only - see the module docstring.
    document = db.Column(JSONB, nullable=False)
    schema_version = db.Column(db.Integer, nullable=False)
    revision = db.Column(db.Integer, nullable=False, default=1, server_default="1")
    #: Library filing. Must be a folder with area "motion". SET NULL: deleting
    #: a folder returns its plays to the Library root, never deletes them.
    folder_id = db.Column(
        db.Integer, db.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Where a copy came from. PROVENANCE ONLY - never a live link: editing the
    #: original changes nothing in the copy, and deleting it just clears this.
    copied_from_play_id = db.Column(
        db.Integer, db.ForeignKey("motion_plays.id", ondelete="SET NULL"), nullable=True
    )

    created_by = db.relationship("Coach", foreign_keys=[created_by_coach_id])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "document": self.document,
            "schema_version": self.schema_version,
            "revision": self.revision,
            "folder_id": self.folder_id,
            "copied_from_play_id": self.copied_from_play_id,
            "created_by_coach_id": self.created_by_coach_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class MotionLook(TimestampMixin, db.Model):
    """A saved starting arrangement - players, sides, labels, alignments.

    A look is NOT a play: its document holds players with no paths, and no
    ball, engagements or situation. Loading one into a play makes an
    independent copy of the arrangement; the look itself never changes.
    """

    __tablename__ = "motion_looks"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    created_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name = db.Column(db.String(255), nullable=False)
    document = db.Column(JSONB, nullable=False)
    schema_version = db.Column(db.Integer, nullable=False)
    revision = db.Column(db.Integer, nullable=False, default=1, server_default="1")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "document": self.document,
            "schema_version": self.schema_version,
            "revision": self.revision,
            "created_by_coach_id": self.created_by_coach_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
