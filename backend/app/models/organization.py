"""Organization (tenant) and its coach invitations.

An Organization is the tenancy boundary: a coaching staff sharing one
workspace. Every coach belongs to exactly one, and quizzes/folders/groups
carry an `organization_id` that scopes what a coach can see. See
`app/utils/auth.py` for the helpers that enforce it.
"""

from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models.mixins import TimestampMixin


class Organization(TimestampMixin, db.Model):
    __tablename__ = "organizations"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)

    coaches = db.relationship("Coach", back_populates="organization")
    quizzes = db.relationship("Quiz", back_populates="organization")
    folders = db.relationship("Folder", back_populates="organization")
    groups = db.relationship("Group", back_populates="organization")
    players = db.relationship("Player", back_populates="organization")
    invites = db.relationship(
        "OrganizationInvite",
        back_populates="organization",
        cascade="all, delete-orphan",
        foreign_keys="OrganizationInvite.organization_id",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class OrganizationInvite(db.Model):
    """A single-use invitation for a coach to join an organization.

    Accepting one stamps `accepted_at`/`accepted_by_coach_id`, which is also
    what makes it unusable a second time (see `is_usable`).
    """

    __tablename__ = "organization_invites"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    # Long random token, not the short player access-code alphabet: this
    # grants access to an entire organization's data and is clicked from a
    # link rather than hand-typed, so there's no reason to trade entropy for
    # typability. See app/services/invites.py.
    code = db.Column(db.String(64), nullable=False, unique=True, index=True)
    # Both coach references are SET NULL on delete: removing a coach from the
    # org must not be blocked by, or destroy, the invite history they touched.
    created_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )
    created_at = db.Column(db.DateTime(timezone=True), nullable=False)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    accepted_at = db.Column(db.DateTime(timezone=True), nullable=True)
    accepted_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )
    is_revoked = db.Column(db.Boolean, nullable=False, default=False)

    organization = db.relationship(
        "Organization", back_populates="invites", foreign_keys=[organization_id]
    )
    created_by = db.relationship("Coach", foreign_keys=[created_by_coach_id])
    accepted_by = db.relationship("Coach", foreign_keys=[accepted_by_coach_id])

    def is_usable(self) -> bool:
        if self.is_revoked or self.accepted_at is not None:
            return False
        return datetime.now(timezone.utc) < self.expires_at

    @staticmethod
    def default_expiry(days: int) -> datetime:
        return datetime.now(timezone.utc) + timedelta(days=days)

    def to_dict(self, include_code: bool = False) -> dict:
        data = {
            "id": self.id,
            "organization_id": self.organization_id,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "accepted_at": self.accepted_at.isoformat() if self.accepted_at else None,
            "is_revoked": self.is_revoked,
            "is_usable": self.is_usable(),
            "created_by": self.created_by.username if self.created_by else None,
            "accepted_by": self.accepted_by.username if self.accepted_by else None,
        }
        if include_code:
            data["code"] = self.code
        return data
