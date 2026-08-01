"""Quiz model."""

from app.extensions import db
from app.models.mixins import TimestampMixin


class Quiz(TimestampMixin, db.Model):
    __tablename__ = "quizzes"

    id = db.Column(db.Integer, primary_key=True)
    coach_id = db.Column(db.Integer, db.ForeignKey("coaches.id"), nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, nullable=True)
    one_question_at_a_time = db.Column(db.Boolean, nullable=False, default=True)
    folder_id = db.Column(
        db.Integer, db.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, index=True
    )

    coach = db.relationship("Coach", back_populates="quizzes")
    folder = db.relationship("Folder", back_populates="quizzes")
    questions = db.relationship(
        "Question",
        back_populates="quiz",
        cascade="all, delete-orphan",
        order_by="Question.position",
    )
    roster = db.relationship(
        "Roster", back_populates="quiz", cascade="all, delete-orphan", uselist=False
    )
    access_codes = db.relationship(
        "AccessCode",
        back_populates="quiz",
        cascade="all, delete-orphan",
        order_by="AccessCode.activated_at.desc()",
    )
    responses = db.relationship(
        "PlayerResponse", back_populates="quiz", cascade="all, delete-orphan"
    )

    def to_dict(self, include_questions: bool = False, include_correct_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "coach_id": self.coach_id,
            "title": self.title,
            "description": self.description,
            "one_question_at_a_time": self.one_question_at_a_time,
            "folder_id": self.folder_id,
            "question_count": len(self.questions),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
        if include_questions:
            data["questions"] = [
                q.to_dict(include_correct_answers=include_correct_answers) for q in self.questions
            ]
        return data
