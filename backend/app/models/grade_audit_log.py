"""Append-only record of every grading action, for accountability once more
than one coach in an organization can grade the same quiz's answers."""

from app.extensions import db


class GradeAuditLog(db.Model):
    """One row per call to PATCH /answers/<id>/grade - unconditionally, even
    when a coach re-confirms an unchanged grade, since that's still a
    meaningful "who touched this last" event. Immutable once written: rows
    are never updated or deleted (other than cascading with their Answer),
    so there's no updated_at - `changed_at` is the one timestamp that matters.
    """

    __tablename__ = "grade_audit_logs"

    id = db.Column(db.Integer, primary_key=True)
    answer_id = db.Column(
        db.Integer, db.ForeignKey("answers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # ondelete=SET NULL: matches Answer.graded_by_coach_id - a coach leaving
    # the org shouldn't delete the audit trail, just lose the "who" on it.
    coach_id = db.Column(db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True)
    previous_is_correct = db.Column(db.Boolean, nullable=True)
    previous_coach_feedback = db.Column(db.Text, nullable=True)
    new_is_correct = db.Column(db.Boolean, nullable=False)
    new_coach_feedback = db.Column(db.Text, nullable=True)
    changed_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=db.func.now())

    answer = db.relationship("Answer")
    coach = db.relationship("Coach")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "answer_id": self.answer_id,
            "coach_id": self.coach_id,
            "coach_username": self.coach.username if self.coach else None,
            "previous_is_correct": self.previous_is_correct,
            "previous_coach_feedback": self.previous_coach_feedback,
            "new_is_correct": self.new_is_correct,
            "new_coach_feedback": self.new_coach_feedback,
            "changed_at": self.changed_at.isoformat(),
        }
