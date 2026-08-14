"""What one attempt was actually delivered, question by question.

WHY THIS TABLE EXISTS
---------------------
`answers.is_correct` is a STORED column, but nothing recorded WHAT the player
saw when that grade was earned. `answers` carries `question_id` and
`selected_option_id` pointing at LIVE rows, so editing a question makes Results
show an old answer against a question the player never saw, and deleting one
cascades the answer away entirely.

WHY A SIBLING TABLE RATHER THAN A COLUMN ON `answers`
-----------------------------------------------------
`Answer` rows are created in exactly one place - `upsert_answer`, called when a
player actually answers. **An unanswered question has no Answer row at all.** A
snapshot hanging off `answers` therefore could not describe a skipped question,
and a skipped question is precisely what a later "don't count this question"
has to be able to talk about: exclusion changes the DENOMINATOR, and the
denominator counts unanswered questions.

WHAT IS AND IS NOT IN `snapshot`
--------------------------------
The minimum trustworthy set, defined once in
`services/question_snapshots.build_snapshot`. Deliberately NOT a copy of every
Question column - see that module for what is excluded and why.

NO BACKFILL, EVER. Attempts that predate this table have no rows, and that is
the honest answer: manufacturing snapshots from today's questions would invent
a history that never happened. Callers must read "no rows" as "delivered
content not recorded", never as "delivered nothing".
"""

from sqlalchemy.dialects.postgresql import JSONB

from app.extensions import db


class AttemptQuestionSnapshot(db.Model):
    __tablename__ = "attempt_question_snapshots"

    id = db.Column(db.Integer, primary_key=True)
    attempt_id = db.Column(
        db.Integer,
        db.ForeignKey("player_attempts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # ondelete=SET NULL, NOT CASCADE. The whole point of the row is to outlive
    # the question: a deleted question must leave its delivered content behind,
    # not take the evidence with it. `snapshot` stays complete and readable
    # after this goes NULL.
    question_id = db.Column(
        db.Integer,
        db.ForeignKey("questions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # The position AS DELIVERED - the index in this attempt's frozen order, not
    # `questions.position`. A randomized practice attempt and the quiz's
    # authored order disagree, and this column records the one the player saw.
    position = db.Column(db.Integer, nullable=False)
    snapshot = db.Column(JSONB, nullable=False)
    captured_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )

    attempt = db.relationship("PlayerAttempt", back_populates="question_snapshots")

    __table_args__ = (
        # One snapshot per question per attempt. Postgres treats NULLs as
        # distinct here, which is exactly what is needed: two questions deleted
        # after delivery both land on question_id NULL for the same attempt and
        # must both survive rather than colliding.
        db.UniqueConstraint(
            "attempt_id", "question_id", name="uq_one_snapshot_per_question_per_attempt"
        ),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "attempt_id": self.attempt_id,
            "question_id": self.question_id,
            "position": self.position,
            "snapshot": self.snapshot,
            "captured_at": self.captured_at.isoformat(),
        }
