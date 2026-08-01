"""Coach account model."""

from app.extensions import bcrypt, db
from app.models.mixins import TimestampMixin


class Coach(TimestampMixin, db.Model):
    __tablename__ = "coaches"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    organization = db.Column(db.String(255), nullable=False)

    quizzes = db.relationship("Quiz", back_populates="coach", cascade="all, delete-orphan")

    def set_password(self, raw_password: str) -> None:
        self.password_hash = bcrypt.generate_password_hash(raw_password).decode("utf-8")

    def check_password(self, raw_password: str) -> bool:
        return bcrypt.check_password_hash(self.password_hash, raw_password)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "organization": self.organization,
            "created_at": self.created_at.isoformat(),
        }
