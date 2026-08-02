"""Coach-scoped, reusable player groups (e.g. "Defense", "JV").

Unlike Roster (strictly one-per-quiz), a Group belongs to the coach and can
be attached to any number of access-code activations over time - see
AccessCode.groups. Kept as a separate model rather than folded into Roster
since the two have different lifecycles: a Roster is deleted with its quiz,
a Group is meant to outlive any single quiz.
"""

from app.extensions import db
from app.models.mixins import TimestampMixin


class Group(TimestampMixin, db.Model):
    __tablename__ = "groups"

    id = db.Column(db.Integer, primary_key=True)
    # Org-shared, same as Folder: organization_id scopes visibility and
    # editing; coach_id is creator attribution only. Sharing the season's
    # roster across the staff is the whole point of groups.
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name = db.Column(db.String(255), nullable=False)

    organization = db.relationship("Organization", back_populates="groups")
    coach = db.relationship("Coach", back_populates="groups", foreign_keys=[coach_id])
    players = db.relationship(
        "GroupPlayer",
        back_populates="group",
        cascade="all, delete-orphan",
        order_by="GroupPlayer.position",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "coach_id": self.coach_id,
            "name": self.name,
            "players": [p.to_dict() for p in self.players],
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class GroupPlayer(db.Model):
    __tablename__ = "group_players"

    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey("groups.id"), nullable=False, index=True)
    player_name = db.Column(db.String(255), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)

    group = db.relationship("Group", back_populates="players")

    def to_dict(self) -> dict:
        return {"id": self.id, "player_name": self.player_name, "position": self.position}
