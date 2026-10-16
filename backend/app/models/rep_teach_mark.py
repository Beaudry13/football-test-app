"""A Rep's football problem, marked taught (Situational Rep: TEACH -> RETEST).

WHY IT IS STORED
----------------
Once a coach has taught a problem, its next step is Retest. That guidance has
to be the same on every device and for every coach who opens the Rep - not
only in the browser that happened to open Teach, which is where it lived
(localStorage) before this table.

ONE ROW PER REP AND PROBLEM. `concept_key` is the concept's id as text, or
"general" for the untagged decisions - the same key the Rep page groups its
problems by. Teaching it again moves `taught_at` and `taught_by_coach_id`
forward; there is no history to keep beyond "last taught, by whom".

PURELY ADDITIVE. No row means "not taught yet", which is every Rep that existed
before this table. Deleting the Rep deletes its marks (CASCADE); a deleted
coach or concept leaves the mark with a NULL reference rather than losing it.
"""

from app.extensions import db

GENERAL_KEY = "general"


def concept_key(concept_id: int | None) -> str:
    return str(concept_id) if concept_id is not None else GENERAL_KEY


class RepTeachMark(db.Model):
    __tablename__ = "rep_teach_marks"
    __table_args__ = (
        db.UniqueConstraint("quiz_id", "concept_key", name="uq_rep_teach_marks_quiz_concept"),
    )

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(
        db.Integer, db.ForeignKey("quizzes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    concept_key = db.Column(db.String(32), nullable=False)
    concept_id = db.Column(
        db.Integer, db.ForeignKey("concepts.id", ondelete="SET NULL"), nullable=True
    )
    taught_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )
    taught_at = db.Column(db.DateTime(timezone=True), nullable=False)

    taught_by = db.relationship("Coach", foreign_keys=[taught_by_coach_id])

    def to_dict(self) -> dict:
        return {
            "at": self.taught_at.isoformat(),
            "by": self.taught_by.username if self.taught_by is not None else None,
        }
