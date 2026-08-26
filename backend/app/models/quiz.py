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
    #: THE QUIZ THIS ONE WAS BUILT TO RE-ASK, when it was.
    #:
    #: Lineage only - it changes nothing about how this quiz is delivered,
    #: scored or shown. It exists so "did they do better after I retaught it?"
    #: is answerable later without guessing from titles or timestamps, which
    #: is the one thing that cannot be reconstructed after the fact.
    #:
    #: SET NULL: deleting the original must not delete the retest or block the
    #: delete. The retest then honestly reads "a retest of something no longer
    #: here" rather than pretending it was never one.
    retest_of_quiz_id = db.Column(
        db.Integer, db.ForeignKey("quizzes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: The quiz this one re-asked, as an object. remote_side is required on a
    #: self-referential many-to-one: without it SQLAlchemy cannot tell which
    #: side of quizzes.id is the "one", and reads the pair backwards.
    #:
    #: Only the IMMEDIATE parent is modelled. A retest of a retest points at
    #: the round before it, which is what "what changed since the last check?"
    #: needs; the root stays reachable by walking up, and flattening to it here
    #: would destroy the ordering nothing else records.
    retest_of = db.relationship(
        "Quiz", remote_side=[id], foreign_keys=[retest_of_quiz_id], uselist=False
    )
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
        #: WHY THIS DRAFT EXISTS, for the ordinary editor a retest opens in.
        #:
        #: Present only on a retest; absent entirely on every other quiz, which
        #: is the client's signal to render nothing. Every value is read from
        #: THIS quiz's own rows - its parent link, the concept its copied
        #: questions carry, the roster Peira seeded - so none of it is a guess
        #: reconstructed about the past.
        #:
        #: `stopped_in_parent` is deliberately a PRESENT-TENSE fact: how many
        #: questions in this concept are stopped in the parent right now, and
        #: therefore are not here. It is NOT a record of what was skipped at
        #: creation - that number was never stored, and inventing it from
        #: today's retired_at would be a claim about history this cannot
        #: support. Said in the present tense it is simply true whenever read.
        if self.retest_of_quiz_id is not None:
            parent = self.retest_of
            concepts = {q.concept for q in self.questions if q.concept is not None}
            concept = next(iter(concepts)) if len(concepts) == 1 else None
            stopped = 0
            if parent is not None and concept is not None:
                stopped = sum(
                    1
                    for q in parent.questions
                    if q.concept_id == concept.id and q.retired_at is not None
                )
            data["retest_of"] = {
                "id": self.retest_of_quiz_id,
                "title": parent.title if parent is not None else None,
                "concept_name": concept.name if concept is not None else None,
                "player_count": len(self.roster.players) if self.roster is not None else 0,
                "stopped_in_parent": stopped,
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
