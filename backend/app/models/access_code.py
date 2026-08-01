"""Time-limited access code for players to join a quiz."""

from datetime import datetime, timedelta, timezone

from app.extensions import db


class AccessCode(db.Model):
    __tablename__ = "access_codes"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    code = db.Column(db.String(16), nullable=False, unique=True, index=True)
    activated_at = db.Column(db.DateTime(timezone=True), nullable=False)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    quiz = db.relationship("Quiz", back_populates="access_codes")
    responses = db.relationship("PlayerResponse", back_populates="access_code")

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
        }
