"""Player response and per-question answer models."""

from app.extensions import db


class PlayerResponse(db.Model):
    """One player's full attempt at a quiz, submitted under a specific access code."""

    __tablename__ = "player_responses"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    access_code_id = db.Column(
        db.Integer, db.ForeignKey("access_codes.id"), nullable=False, index=True
    )
    player_name = db.Column(db.String(255), nullable=False, index=True)
    submitted_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    quiz = db.relationship("Quiz", back_populates="responses")
    access_code = db.relationship("AccessCode", back_populates="responses")
    answers = db.relationship(
        "Answer", back_populates="player_response", cascade="all, delete-orphan"
    )

    __table_args__ = (
        db.UniqueConstraint(
            "access_code_id", "player_name", name="uq_one_response_per_player_per_activation"
        ),
    )

    def to_dict(self, include_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "access_code_id": self.access_code_id,
            "player_name": self.player_name,
            "submitted_at": self.submitted_at.isoformat(),
        }
        if include_answers:
            data["answers"] = [a.to_dict() for a in self.answers]
        return data


class Answer(db.Model):
    """A player's answer to a single question within a response."""

    __tablename__ = "answers"

    id = db.Column(db.Integer, primary_key=True)
    player_response_id = db.Column(
        db.Integer,
        db.ForeignKey("player_responses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # ondelete=CASCADE: deleting a question (or its quiz) also clears any answers to it.
    question_id = db.Column(
        db.Integer, db.ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    answer_text = db.Column(db.Text, nullable=True)
    # ondelete=SET NULL: if a coach edits a question's options after players have
    # answered, don't let that delete fail or destroy the recorded answer/grade.
    selected_option_id = db.Column(
        db.Integer, db.ForeignKey("question_options.id", ondelete="SET NULL"), nullable=True
    )
    is_correct = db.Column(db.Boolean, nullable=True)
    coach_feedback = db.Column(db.Text, nullable=True)
    graded_at = db.Column(db.DateTime(timezone=True), nullable=True)

    player_response = db.relationship("PlayerResponse", back_populates="answers")
    question = db.relationship("Question", back_populates="answers")
    selected_option = db.relationship("QuestionOption")

    __table_args__ = (
        db.UniqueConstraint(
            "player_response_id", "question_id", name="uq_one_answer_per_question_per_response"
        ),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question_id": self.question_id,
            "answer_text": self.answer_text,
            "selected_option_id": self.selected_option_id,
            "is_correct": self.is_correct,
            "coach_feedback": self.coach_feedback,
            "graded_at": self.graded_at.isoformat() if self.graded_at else None,
        }
