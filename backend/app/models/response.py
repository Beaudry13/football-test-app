"""Player attempt and per-question answer models."""

import enum

from app.extensions import db
from app.models.assessment_mode import DEFAULT_MODE, GRADED, PRACTICE


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
    # Display snapshot, not identity, once player_id is set - see player_id
    # below. Always populated (even for a canonical attempt) so every
    # existing name-based display path keeps working unchanged.
    player_name = db.Column(db.String(255), nullable=False, index=True)
    # Canonical identity (nullable - added for the master-roster migration).
    # NULL means a legacy, name-only attempt exactly as before this column
    # existed. Uniqueness is enforced by two partial indexes instead of one
    # plain UniqueConstraint (see the migration): one on
    # (access_code_id, player_name) WHERE player_id IS NULL, preserving the
    # original name-collision rule for legacy attempts, and one on
    # (access_code_id, player_id) WHERE player_id IS NOT NULL, which is what
    # lets two different canonical Players who happen to share a display
    # name (e.g. two "Chris Smith"s) both attempt the same activation
    # without colliding - the old single name-based constraint could not
    # allow that.
    player_id = db.Column(
        db.Integer, db.ForeignKey("players.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status = db.Column(
        db.Enum(AttemptStatus), nullable=False, default=AttemptStatus.IN_PROGRESS
    )
    # Copied from the access code when the attempt is created, and never
    # written again. Denormalised deliberately: if mode lived only on the
    # access code, a coach editing that code would RETROACTIVELY reclassify
    # every attempt made under it - moving real graded results out of
    # official analytics, or practice results in. Freezing it here is what
    # makes "an attempt's mode is immutable" true rather than aspirational.
    #: The question order this attempt started with, as a list of question
    #: ids. NULL means the quiz's authored order - which is what every graded
    #: attempt and every pre-existing row uses, so no backfill was needed.
    #:
    #: Frozen at creation and never rewritten, even when the quiz changes
    #: underneath it. Reconciliation against the live quiz happens at read
    #: time (services/attempts.presented_question_ids) so this column stays a
    #: historical record of what the player was actually given.
    question_order = db.Column(db.JSON, nullable=True)
    mode = db.Column(
        db.String(16), nullable=False, server_default=DEFAULT_MODE, default=DEFAULT_MODE
    )
    started_at = db.Column(db.DateTime(timezone=True), nullable=False, server_default=db.func.now())
    submitted_at = db.Column(db.DateTime(timezone=True), nullable=True)

    @property
    def is_practice(self) -> bool:
        return self.mode == PRACTICE

    @property
    def counts_officially(self) -> bool:
        """Whether this attempt may influence grades, reports or analytics.

        The single source of that truth lives in services/attempt_scope; this
        mirrors it for a loaded object so callers holding an attempt do not
        have to re-derive the rule."""
        return self.mode == GRADED

    quiz = db.relationship("Quiz", back_populates="attempts")
    access_code = db.relationship("AccessCode", back_populates="attempts")
    answers = db.relationship("Answer", back_populates="attempt", cascade="all, delete-orphan")
    player = db.relationship("Player")

    __table_args__ = (
        db.Index(
            "uq_legacy_attempt_by_name",
            "access_code_id",
            "player_name",
            unique=True,
            # GRADED only. Practice is deliberately unconstrained: unlimited
            # retakes fall out of the index rather than needing an attempt
            # counter. Graded keeps exactly-once semantics untouched.
            postgresql_where=db.text("player_id IS NULL AND mode = 'GRADED'"),
        ),
        db.Index(
            "uq_canonical_attempt_by_player",
            "access_code_id",
            "player_id",
            unique=True,
            postgresql_where=db.text("player_id IS NOT NULL AND mode = 'GRADED'"),
        ),
    )

    @property
    def display_name(self) -> str:
        """The name coach-facing Results/Grading views should show: the
        linked canonical Player's *current* full_name, when this attempt
        has one and that Player still exists - falling back to the
        historical `player_name` snapshot for a legacy (player_id IS NULL)
        attempt, or for a canonical Player that's since been deleted.

        `player_name` itself is never rewritten - it stays the immutable,
        backward-compatible snapshot taken at attempt time; this property
        is purely a read-time display choice layered on top of it.
        """
        if self.player_id is not None and self.player is not None:
            return self.player.full_name
        return self.player_name

    def to_dict(self, include_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "access_code_id": self.access_code_id,
            "player_name": self.player_name,
            "display_name": self.display_name,
            "player_id": self.player_id,
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
    # PRACTICE ONLY. When the player pressed "Check Answer" and was shown the
    # verdict and the coach's explanation. Stamped explicitly rather than
    # inferred from "an answer row exists", because a Draw Response answer row
    # is created by the first autosaved brush stroke - long before the player
    # has checked anything - and because a page reload must not re-open a
    # question whose explanation has already been read. Always NULL on a
    # graded attempt: nothing is revealed there, so nothing locks.
    checked_at = db.Column(db.DateTime(timezone=True), nullable=True)
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
    drawing = db.relationship(
        "AnswerDrawing", back_populates="answer", uselist=False, cascade="all, delete-orphan"
    )

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
            # Metadata only by default - the stroke blob is large and every
            # bulk answer load (analytics, dashboard, CSV) only needs to
            # know whether a drawing exists. Callers that actually render it
            # ask for the strokes explicitly.
            "drawing": self.drawing.to_dict() if self.drawing else None,
        }
