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
    """One membership slot in a Group.

    `player_id` is the canonical link (nullable, added for the master-roster
    migration): when set, `player_name` is just a display snapshot taken at
    add-time, not the source of truth - see Player.full_name for the live
    value. A row with `player_id` NULL is a legacy free-text entry, exactly
    as this table worked before Player existed; both kinds can coexist in
    the same group during the transition. A partial unique index (see the
    migration) prevents the same Player from being added twice to one
    group, but only applies where player_id IS NOT NULL - legacy name rows
    keep relying on the application-level dedupe in
    services/player_names.py, same as always.
    """

    __tablename__ = "group_players"

    id = db.Column(db.Integer, primary_key=True)
    group_id = db.Column(db.Integer, db.ForeignKey("groups.id"), nullable=False, index=True)
    player_name = db.Column(db.String(255), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    player_id = db.Column(
        db.Integer, db.ForeignKey("players.id", ondelete="CASCADE"), nullable=True, index=True
    )

    group = db.relationship("Group", back_populates="players")
    player = db.relationship("Player")

    __table_args__ = (
        db.Index(
            "uq_group_players_group_player",
            "group_id",
            "player_id",
            unique=True,
            postgresql_where=db.text("player_id IS NOT NULL"),
        ),
    )

    def to_dict(self) -> dict:
        data = {"id": self.id, "player_name": self.player_name, "position": self.position}
        if self.player_id is not None and self.player is not None:
            data["player"] = self.player.to_dict()
        return data
