"""Roster models: one roster per quiz, containing a list of players.

Players are normalized into their own table (rather than a raw JSON list)
so a player's name can be validated against the roster at submission time
and so per-player history can be queried efficiently later.
"""

from app.extensions import db


class Roster(db.Model):
    __tablename__ = "rosters"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(
        db.Integer, db.ForeignKey("quizzes.id"), nullable=False, unique=True, index=True
    )
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    quiz = db.relationship("Quiz", back_populates="roster")
    players = db.relationship(
        "RosterPlayer",
        back_populates="roster",
        cascade="all, delete-orphan",
        order_by="RosterPlayer.position",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "players": [p.to_dict() for p in self.players],
        }


class RosterPlayer(db.Model):
    """One slot on a quiz's direct Roster.

    `player_id` is the canonical link (nullable, added for the master-roster
    migration) - same dual-read/dual-write treatment as GroupPlayer.player_id
    (see that model's docstring): set means canonical (player_name is just a
    display snapshot), NULL means legacy free-text, and both kinds can
    coexist on the same roster during the transition.
    """

    __tablename__ = "roster_players"

    id = db.Column(db.Integer, primary_key=True)
    roster_id = db.Column(db.Integer, db.ForeignKey("rosters.id"), nullable=False, index=True)
    player_name = db.Column(db.String(255), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    player_id = db.Column(
        db.Integer, db.ForeignKey("players.id", ondelete="CASCADE"), nullable=True, index=True
    )

    roster = db.relationship("Roster", back_populates="players")
    player = db.relationship("Player")

    __table_args__ = (
        db.Index(
            "uq_roster_players_roster_player",
            "roster_id",
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
