"""An INSTALL: what the coach is installing this week - "Week 7 - West
Virginia", "Spring install 4", "Safeties - Week 7".

ORGANIZATION, NOT FOOTBALL. An install refers to football that already
exists - a Motion Lab play, a quiz or Rep, a concept - and copies none of it.
Removing an item, archiving the install or deleting it never touches the
football. Deleting the football removes its item from every install (CASCADE):
an install cannot point at something that is gone.

SOURCE STAYS SOURCE. A play item always opens the play as Motion Lab holds it
now. A quiz or Rep item opens that quiz or Rep, whose questions keep their own
pictures and whose players' answers keep their delivered snapshots - an
install never changes what a player was asked.

ONE LEVEL. Items may sit in a section ("Base", "3rd down", "Red zone") or
before any section; sections do not nest. Order is `position`, within the
section (or the unsectioned items).

OWN, LIKE EVERY QUIZ LIST: an install belongs to the coach who made it, in his
organization (Coach View).

`position_group` is the room it is for, when it is one ("family:Safeties", the
same keys the roster's position filter uses) - so a concept in it can say how
many of THAT room still miss it. Null for a whole-team install.
"""

from app.extensions import db
from app.models.mixins import TimestampMixin

#: What an item can refer to. A Rep is a quiz with kind REP: one kind covers both.
ITEM_KINDS = ("play", "quiz", "concept")


class Install(TimestampMixin, db.Model):
    __tablename__ = "installs"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title = db.Column(db.String(120), nullable=False)
    position_group = db.Column(db.String(40), nullable=True)
    #: Archived installs get out of the way without disappearing.
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)

    sections = db.relationship(
        "InstallSection",
        backref="install",
        cascade="all, delete-orphan",
        order_by="InstallSection.position",
    )
    items = db.relationship(
        "InstallItem",
        backref="install",
        cascade="all, delete-orphan",
        order_by="InstallItem.position",
    )


class InstallSection(db.Model):
    __tablename__ = "install_sections"

    id = db.Column(db.Integer, primary_key=True)
    install_id = db.Column(
        db.Integer, db.ForeignKey("installs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title = db.Column(db.String(80), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)


class InstallItem(db.Model):
    __tablename__ = "install_items"
    __table_args__ = (
        # One reference to a piece of football per install (NULLs never collide).
        db.UniqueConstraint("install_id", "motion_play_id", name="uq_install_items_play"),
        db.UniqueConstraint("install_id", "quiz_id", name="uq_install_items_quiz"),
        db.UniqueConstraint("install_id", "concept_id", name="uq_install_items_concept"),
        db.CheckConstraint(
            "(kind = 'play' AND motion_play_id IS NOT NULL AND quiz_id IS NULL AND concept_id IS NULL)"
            " OR (kind = 'quiz' AND quiz_id IS NOT NULL AND motion_play_id IS NULL AND concept_id IS NULL)"
            " OR (kind = 'concept' AND concept_id IS NOT NULL AND motion_play_id IS NULL AND quiz_id IS NULL)",
            name="ck_install_items_one_reference",
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    install_id = db.Column(
        db.Integer, db.ForeignKey("installs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_id = db.Column(
        db.Integer, db.ForeignKey("install_sections.id", ondelete="SET NULL"), nullable=True, index=True
    )
    position = db.Column(db.Integer, nullable=False, default=0)
    kind = db.Column(db.String(16), nullable=False)
    motion_play_id = db.Column(
        db.Integer, db.ForeignKey("motion_plays.id", ondelete="CASCADE"), nullable=True, index=True
    )
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id", ondelete="CASCADE"), nullable=True, index=True)
    concept_id = db.Column(
        db.Integer, db.ForeignKey("concepts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    play = db.relationship("MotionPlay")
    quiz = db.relationship("Quiz")
    concept = db.relationship("Concept")

    @property
    def ref_id(self) -> int:
        return {"play": self.motion_play_id, "quiz": self.quiz_id, "concept": self.concept_id}[self.kind]
