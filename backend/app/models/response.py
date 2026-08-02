"""Player attempt and per-question answer models."""

import enum

from app.extensions import db


class AttemptStatus(str, enum.Enum):
    """IN_PROGRESS from the moment a player picks their name, until the
    final submit locks it to SUBMITTED. No third state - a reset (coach
    action) deletes the row outright rather than reverting it, so there's
    no "was retaken" history to represent."""

    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"


class PlayerAttempt(db.Model):
    """One player's attempt at a quiz, under a specific access code.

    Created the moment a player picks their name (status=IN_PROGRESS, see
    POST /play/start), not at final submission - this is what lets answers
    autosave somewhere durable before the player is done. `submit_quiz`
    flips it to SUBMITTED and stamps `submitted_at`, after which the
    /play/answers and /play/submit routes both refuse further writes to it
    (the hard-lock is enforced there, not by a DB trigger - see PR notes).
    """

    __tablename__ = "player_attempts"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    access_code_id = db.Column(
        db.Integer, db.ForeignKey("access_codes.id"), nullable=False, index=True
    )
    player_name = db.Column(db.String(255), nullable=False, index=True)
    status = db.Column(
        db.Enum(AttemptStatus), nullable=False, default=AttemptStatus.IN_PROGRESS
    )
    started_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=db.func.now())
    submitted_at = db.Column(db.DateTime(timezone=True), nullable=True)

    quiz = db.relationship("Quiz", back_populates="attempts")
    access_code = db.relationship("AccessCode", back_populates="attempts")
    answers = db.relationship("Answer", back_populates="attempt", cascade="all, delete-orphan")

    __table_args__ = (
        db.UniqueConstraint(
            "access_code_id", "player_name", name="uq_one_attempt_per_player_per_activation"
        ),
    )

    def to_dict(self, include_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "access_code_id": self.access_code_id,
            "player_name": self.player_name,
            "status": self.status.value,
            "started_at": self.started_at.isoformat(),
            "submitted_at": self.submitted_at.isoformat() if self.submitted_at else None,
        }
        if include_answers:
            data["answers"] = [a.to_dict() for a in self.answers]
        return data


class Answer(db.Model):
    """A player's answer to a single question within an attempt."""

    __tablename__ = "answers"

    id = db.Column(db.Integer, primary_key=True)
    attempt_id = db.Column(
        db.Integer,
        db.ForeignKey("player_attempts.id", ondelete="CASCADE"),
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
    # Most-recently-graded-at, not first-graded-at - overwritten on every
    # re-grade, same as is_correct/coach_feedback. The full history of every
    # grading event (who, what changed, when) lives in GradeAuditLog instead;
    # this column is just "when did the current grade get set."
    graded_at = db.Column(db.DateTime(timezone=True), nullable=True)
    # ondelete=SET NULL: matches Quiz.coach_id/Folder.coach_id/Group.coach_id
    # - a coach leaving the org shouldn't delete or block deleting the grades
    # they made, just lose the "who" attribution on them.
    graded_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    attempt = db.relationship("PlayerAttempt", back_populates="answers")
    question = db.relationship("Question", back_populates="answers")
    selected_option = db.relationship("QuestionOption")
    graded_by = db.relationship("Coach")

    __table_args__ = (
        db.UniqueConstraint(
            "attempt_id", "question_id", name="uq_one_answer_per_question_per_attempt"
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
            "graded_by_username": self.graded_by.username if self.graded_by else None,
        }
