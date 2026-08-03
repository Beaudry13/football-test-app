"""Quiz model."""

from app.extensions import db
from app.models.mixins import TimestampMixin


class Quiz(TimestampMixin, db.Model):
    __tablename__ = "quizzes"

    id = db.Column(db.Integer, primary_key=True)
    # organization_id is the tenancy scope (who can *see* this quiz);
    # coach_id is the creator (who can *edit* it, alongside org admins).
    # See app/utils/auth.py::get_visible_quiz / get_editable_quiz.
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, nullable=True)
    one_question_at_a_time = db.Column(db.Boolean, nullable=False, default=True)
    # When true, /play/submit rejects a submission that leaves any question
    # unanswered - enforced server-side (see submit_quiz), not just by the
    # player-facing Submit button's own client-side check.
    require_all_answers = db.Column(db.Boolean, nullable=False, default=False)
    folder_id = db.Column(
        db.Integer, db.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, index=True
    )

    organization = db.relationship("Organization", back_populates="quizzes")
    coach = db.relationship("Coach", back_populates="quizzes", foreign_keys=[coach_id])
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
    attempts = db.relationship(
        "PlayerAttempt", back_populates="quiz", cascade="all, delete-orphan"
    )

    def to_dict(
        self,
        include_questions: bool = False,
        include_correct_answers: bool = False,
        is_active: bool | None = None,
        completed_count: int | None = None,
        roster_size: int | None = None,
        average_score_percent: float | None = None,
    ) -> dict:
        data = {
            "id": self.id,
            "organization_id": self.organization_id,
            "coach_id": self.coach_id,
            # Lets the dashboard label quizzes made by a teammate without a
            # second round-trip per card.
            "created_by_username": self.coach.username if self.coach else None,
            "title": self.title,
            "description": self.description,
            "one_question_at_a_time": self.one_question_at_a_time,
            "require_all_answers": self.require_all_answers,
            "folder_id": self.folder_id,
            "question_count": len(self.questions),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
        if include_questions:
            data["questions"] = [
                q.to_dict(include_correct_answers=include_correct_answers) for q in self.questions
            ]
        # Only set by list_quizzes, which batch-computes these for every quiz
        # in a fixed number of queries - omitted elsewhere (e.g. get_quiz)
        # rather than forcing every other caller to pay for the same
        # computation when nothing else needs it.
        if is_active is not None:
            data["is_active"] = is_active
        if completed_count is not None:
            data["completed_count"] = completed_count
        if roster_size is not None:
            data["roster_size"] = roster_size
        if average_score_percent is not None:
            data["average_score_percent"] = average_score_percent
        return data
