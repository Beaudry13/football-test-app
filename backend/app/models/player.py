"""Canonical Player: a persistent identity for one real person on an
organization's master roster, independent of any name string used
elsewhere (Roster/Group entries, PlayerAttempt.player_name).

Identity is `id` only - deliberately no unique constraint on name or
jersey number, so two different people who share a name (e.g. two
"Chris Smith"s on the same roster) can coexist as separate records. See
GroupPlayer.player_id / RosterPlayer.player_id / PlayerAttempt.player_id
for how legacy name-string data links to this table during the
transition (all nullable, dual-read/dual-write - see those models'
own docstrings).
"""

from app.extensions import db
from app.models.mixins import TimestampMixin


class Player(TimestampMixin, db.Model):
    __tablename__ = "players"

    id = db.Column(db.Integer, primary_key=True)
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    first_name = db.Column(db.String(100), nullable=False)
    last_name = db.Column(db.String(100), nullable=False)
    jersey_number = db.Column(db.String(4), nullable=True)
    position = db.Column(db.String(10), nullable=True)
    photo_url = db.Column(db.String(500), nullable=True)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    organization = db.relationship("Organization", back_populates="players")

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "full_name": self.full_name,
            "jersey_number": self.jersey_number,
            "position": self.position,
            "photo_url": self.photo_url,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
