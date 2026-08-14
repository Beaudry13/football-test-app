"""A coach's decision that one question should not count toward scoring.

WHAT THIS IS FOR
----------------
A coach finds, after players have already taken a quiz, that a question was
broken - the wrong option was marked correct, the image did not load, the
wording was ambiguous. Before this table their only options were to leave a
result they knew was wrong, or to reset the attempts and lose the evidence.

THE ROW IS ITS OWN AUDIT RECORD. Who excluded it, when, optionally why, and
whether it was put back. It is deliberately NOT folded into `GradeAuditLog`,
which is answer-scoped: an exclusion is a statement about a QUESTION for a
COHORT, and most of the answers it affects were never re-graded.

REVERSIBLE, NEVER DELETED. Restoring sets `restored_at`; the row stays. A
coach who excludes a question by mistake needs the record of both decisions,
not a clean slate.

SCOPE - THE PART THAT MATTERS
-----------------------------
`access_code_id` NULL means quiz-wide; a value means THAT ASSIGNMENT ONLY.
Assignment scope is the default in the product, because a bad Monday delivery
must not rewrite Tuesday's results. Both may be active at once, and a question
covered by either is simply excluded - restoring one does not make it count
while the other still applies. Two partial unique indexes enforce "at most one
active exclusion of each kind"; see the migration for why one index cannot.

WHAT THIS TABLE DOES **NOT** DO
-------------------------------
It does not delete, hide or alter a player's answer. Exclusion is applied when
a score is COMPUTED - the answer rows and the delivered-question snapshots stay
exactly as they were, which is what makes it reversible and auditable.
"""

from app.extensions import db


class QuestionExclusion(db.Model):
    __tablename__ = "question_exclusions"

    id = db.Column(db.Integer, primary_key=True)
    # CASCADE, decided deliberately rather than by default. A question that has
    # been ANSWERED cannot be hard-deleted today (_reject_if_already_answered),
    # and if one can legitimately disappear then its answers cascade away with
    # it - leaving an exclusion row that points at no evidence and cannot be
    # correlated with anything. SET NULL would preserve a record saying
    # "somebody excluded something once", which is not history worth keeping,
    # and would slip past both partial unique indexes.
    question_id = db.Column(
        db.Integer,
        db.ForeignKey("questions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: NULL = quiz-wide. A value scopes the exclusion to one assignment.
    #: CASCADE because deleting an assignment deletes its attempts, so a
    #: per-assignment exclusion has nothing left to scope.
    access_code_id = db.Column(
        db.Integer,
        db.ForeignKey("access_codes.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    # SET NULL, matching quizzes.coach_id and answers.graded_by_coach_id: a
    # coach leaving the organization must not delete the record of what they
    # did, only the attribution for it.
    coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )
    #: Optional free text, for the coach and the audit trail. NEVER shown to a
    #: player - see routes/play.py, which does not include it in any payload.
    reason = db.Column(db.Text, nullable=True)
    excluded_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )
    #: NULL means ACTIVE. Set to restore; the row is never deleted for it.
    restored_at = db.Column(db.DateTime(timezone=True), nullable=True)

    question = db.relationship("Question")
    access_code = db.relationship("AccessCode")
    coach = db.relationship("Coach")

    __table_args__ = (
        # TWO partial unique indexes, not one. `UNIQUE (question_id,
        # access_code_id) WHERE restored_at IS NULL` would NOT constrain
        # quiz-wide rows at all: Postgres treats NULLs as distinct, so any
        # number of rows with access_code_id NULL satisfy it. Each rule is
        # therefore stated where it can actually be enforced.
        #
        # Declared here as well as in the migration so the test suite's
        # create_all() builds the same constraints the deployed schema has -
        # otherwise a duplicate-prevention test would pass against a schema
        # that has no duplicate prevention.
        db.Index(
            "uq_active_exclusion_per_assignment",
            "question_id",
            "access_code_id",
            unique=True,
            postgresql_where=db.text("restored_at IS NULL AND access_code_id IS NOT NULL"),
        ),
        db.Index(
            "uq_active_quiz_wide_exclusion",
            "question_id",
            unique=True,
            postgresql_where=db.text("restored_at IS NULL AND access_code_id IS NULL"),
        ),
    )

    @property
    def is_active(self) -> bool:
        return self.restored_at is None

    @property
    def is_quiz_wide(self) -> bool:
        return self.access_code_id is None

    def to_dict(self, include_reason: bool = False) -> dict:
        """Coach-facing by default WITHOUT the reason.

        `include_reason` is opt-in rather than opt-out for the same reason
        `include_correct_answers` is: the default serialisation of this row
        must never be the thing that leaks a coach's private note into a
        player-facing payload.
        """
        data = {
            "id": self.id,
            "question_id": self.question_id,
            "access_code_id": self.access_code_id,
            "scope": "quiz" if self.is_quiz_wide else "assignment",
            "excluded_at": self.excluded_at.isoformat(),
            "restored_at": self.restored_at.isoformat() if self.restored_at else None,
            "is_active": self.is_active,
            "excluded_by_username": self.coach.username if self.coach else None,
        }
        if include_reason:
            data["reason"] = self.reason
        return data
