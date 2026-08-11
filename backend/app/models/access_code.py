"""Time-limited access code for players to join a quiz."""

from datetime import datetime, timedelta, timezone

from app.extensions import db
from app.models.assessment_mode import DEFAULT_MODE, PRACTICE

# Which saved group(s), if any, have access under a given activation. Plain
# association table (no extra columns) - a code with no linked groups falls
# back to its quiz's own Roster (see app.services.access_codes.effective_roster_names).
access_code_groups = db.Table(
    "access_code_groups",
    db.metadata,
    db.Column(
        "access_code_id",
        db.Integer,
        db.ForeignKey("access_codes.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    db.Column(
        "group_id", db.Integer, db.ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    ),
)


class AccessCode(db.Model):
    __tablename__ = "access_codes"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    code = db.Column(db.String(16), nullable=False, unique=True, index=True)
    activated_at = db.Column(db.DateTime(timezone=True), nullable=False)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    # How this assignment is being used. See models/assessment_mode.
    mode = db.Column(
        db.String(16), nullable=False, server_default=DEFAULT_MODE, default=DEFAULT_MODE
    )

    quiz = db.relationship("Quiz", back_populates="access_codes")
    attempts = db.relationship("PlayerAttempt", back_populates="access_code")
    groups = db.relationship("Group", secondary=access_code_groups)

    #: Shuffle the question order for each new PRACTICE attempt.
    #:
    #: Assignment intent, like `mode` - it says what future attempts should
    #: do, never what a particular attempt DID. The order a player actually
    #: received is frozen on their attempt, so toggling this afterwards cannot
    #: reorder work already in progress.
    #:
    #: Ignored entirely for GRADED, which always uses the authored order.
    randomize_questions = db.Column(
        db.Boolean, nullable=False, default=False, server_default=db.false()
    )

    @property
    def is_practice(self) -> bool:
        return self.mode == PRACTICE

    def is_valid(self) -> bool:
        if not self.is_active:
            return False
        return datetime.now(timezone.utc) < self.expires_at

    @staticmethod
    def default_expiry(hours: int) -> datetime:
        return datetime.now(timezone.utc) + timedelta(hours=hours)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "code": self.code,
            "activated_at": self.activated_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "is_active": self.is_active,
            "is_valid": self.is_valid(),
            "groups": [{"id": g.id, "name": g.name} for g in self.groups],
            "mode": self.mode,
            "is_practice": self.is_practice,
            "randomize_questions": self.randomize_questions,
        }
