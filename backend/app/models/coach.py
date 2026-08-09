"""Coach account model."""

import enum

from app.extensions import bcrypt, db
from app.models.mixins import TimestampMixin


class CoachRole(str, enum.Enum):
    """ADMIN can manage the organization (invite, remove members, rename)
    and can edit any quiz in it. MEMBER can edit only quizzes they created,
    though shared folders/groups are editable by everyone."""

    ADMIN = "admin"
    MEMBER = "member"


class Coach(TimestampMixin, db.Model):
    __tablename__ = "coaches"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    role = db.Column(db.Enum(CoachRole), nullable=False, default=CoachRole.MEMBER)
    # The ONLY piece of onboarding state that is stored. Every checklist step
    # is derived from real data on each request (see services/onboarding.py);
    # dismissal is a preference, so there is nothing to derive it from.
    # Nullable timestamp rather than a boolean so "when did they give up on
    # the checklist" stays answerable without a second column.
    onboarding_dismissed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    # The id of the newest release this coach has seen in What's New, or NULL
    # if they have never opened it. HELP state, not onboarding state - the
    # rule that every onboarding step stays derived is untouched.
    #
    # A string compared by equality, deliberately: a timestamp would make
    # unread depend on release dates being ordering-safe (backdate a release
    # and it silently reads as seen), and a per-release join table would
    # answer a question nobody asks, since the panel shows every release at
    # once and reading one is reading all. NULL meaning "never opened" is
    # also what makes existing coaches see the indicator with no backfill.
    whats_new_seen_version = db.Column(db.String(32), nullable=True)

    organization = db.relationship("Organization", back_populates="coaches")
    # No delete cascade on any of these: quizzes, folders, and groups belong
    # to the *organization*, not to the coach who happened to create them.
    # When a coach leaves, their work stays with the team and the creator
    # reference is nulled out (FKs use ondelete="SET NULL").
    quizzes = db.relationship("Quiz", back_populates="coach", foreign_keys="Quiz.coach_id")
    folders = db.relationship("Folder", back_populates="coach", foreign_keys="Folder.coach_id")
    groups = db.relationship("Group", back_populates="coach", foreign_keys="Group.coach_id")

    def set_password(self, raw_password: str) -> None:
        self.password_hash = bcrypt.generate_password_hash(raw_password).decode("utf-8")

    def check_password(self, raw_password: str) -> bool:
        return bcrypt.check_password_hash(self.password_hash, raw_password)

    def is_admin(self) -> bool:
        return self.role == CoachRole.ADMIN

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            # Kept as a plain string for the frontend's benefit - it was a
            # free-text column before organizations existed, and every client
            # surface that showed it still just wants the display name.
            "organization": self.organization.name if self.organization else None,
            "organization_id": self.organization_id,
            "role": self.role.value,
            "created_at": self.created_at.isoformat(),
        }
