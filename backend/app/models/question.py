"""Question and question-option models."""

import enum

from sqlalchemy.dialects.postgresql import JSONB

from app.extensions import db


class QuestionType(str, enum.Enum):
    """The native Postgres enum `questiontype` stores MEMBER NAMES, not these
    values - 'WRITTEN', not 'written'. Any hand-written SQL touching this
    column must use the left-hand side.

    WRITTEN is labelled "Short Answer" in the coach UI. The stored value keeps
    its original name deliberately: renaming it would be a second one-way enum
    change plus a data migration across every existing answer, to alter one
    word a coach reads.
    """

    TRUE_FALSE = "true_false"
    MULTIPLE_CHOICE = "multiple_choice"
    WRITTEN = "written"
    # Requires an image and is answered by drawing on it. Enforced at
    # activation rather than creation - a question must exist before an image
    # can be uploaded to it, so requiring one at creation would make the type
    # impossible to create. See routes/access_codes.py.
    DRAW_RESPONSE = "draw_response"
    # Free text matched against `expected_answers` and scored AT ANSWER TIME.
    #
    # The difference from WRITTEN is not the shape of the answer - both are
    # typed text - it is WHO GRADES IT, and that distinction is already
    # load-bearing in three places (MANUALLY_GRADED_TYPES below, the exporter,
    # and the player analytics). Making it a property of the type keeps those
    # three agreeing; inferring it from "does expected_answers happen to be
    # non-empty" would make each of them re-derive the same rule separately.
    # See docs/DESIGN-playbook-quiz.md §11 and §11a.
    FILL_BLANK = "fill_blank"


#: Types whose answer a coach grades by hand, rather than the server scoring
#: it from a selected option. Named once so the several places that ask
#: "does this need grading" cannot drift apart - the same hazard CLAUDE.md
#: records for the CORRECT/INCORRECT vocabulary.
#:
#: FILL_BLANK is deliberately ABSENT: it is auto-graded, which is its entire
#: reason for existing. A coach masking forty play names is not going to hand
#: grade forty recall answers.
MANUALLY_GRADED_TYPES = frozenset({QuestionType.WRITTEN, QuestionType.DRAW_RESPONSE})

#: Types Peira can mark right or wrong by itself, the instant they are
#: answered. DERIVED from MANUALLY_GRADED_TYPES rather than listed separately,
#: so a new question type joins exactly one of the two sets and the other
#: follows - two hand-maintained lists would eventually disagree about a type
#: and Practice Mode would claim to know an answer it cannot grade.
AUTO_GRADABLE_TYPES = frozenset(QuestionType) - MANUALLY_GRADED_TYPES

#: Types answered by typing rather than by choosing an option. Introduced
#: because several places asked `question_type == "written"` when what they
#: actually meant was "the answer is text, so read answer_text rather than
#: selected_option" - a question FILL_BLANK would silently have answered
#: wrongly, showing every player a blank answer in the PDF export.
TEXT_ANSWER_TYPES = frozenset({QuestionType.WRITTEN, QuestionType.FILL_BLANK})

#: Types that require no option rows. A DRAW_RESPONSE converted from multiple
#: choice may still carry inert ones (migration d2b5f8a41c32); none of these
#: types ever requires them, and authoring one never creates them.
OPTIONLESS_TYPES = frozenset(
    {QuestionType.WRITTEN, QuestionType.DRAW_RESPONSE, QuestionType.FILL_BLANK}
)


class Question(db.Model):
    __tablename__ = "questions"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    question_text = db.Column(db.Text, nullable=False)
    question_type = db.Column(db.Enum(QuestionType), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    # FILL_BLANK only. The list of strings a typed answer is accepted against;
    # several are allowed because real variation is real ("Cover 3", "C3",
    # "Cvr 3") and guessing at it with fuzzy matching would mark "Cover 2"
    # correct for "Cover 3" - one character apart, opposite meanings.
    # See services/answer_matching.py.
    expected_answers = db.Column(JSONB, nullable=True)
    # Optional coaching note, shown to a player in PRACTICE mode only, and
    # only once they have answered. Never shown during a graded attempt -
    # that would hand out the teaching material mid-assessment. Available on
    # every question type, including the manually graded ones, where it is
    # the ONLY feedback Peira can honestly give.
    answer_explanation = db.Column(db.Text, nullable=True)
    answer_matching = db.Column(db.String(32), nullable=True)

    #: "SELECT ALL THAT APPLY" - a behaviour of multiple choice, NOT a new
    #: question type. `question_type` is a native Postgres enum and adding a
    #: member is a one-way, multi-migration operation (CLAUDE.md #8); more to
    #: the point, the options and their `is_correct_answer` flags already model
    #: this perfectly. Only the SELECTION RULE differs.
    #:
    #: FALSE = pick exactly one, which is every question that exists today, so
    #: no backfill was needed.
    allows_multiple_answers = db.Column(
        db.Boolean, nullable=False, default=False, server_default=db.false()
    )

    #: STOP SENDING THIS QUESTION TO NEW ATTEMPTS. NULL = deliverable, which is
    #: why no backfill was needed: every pre-existing row is correct the moment
    #: the column appears.
    #:
    #: THIS IS NOT A SOFT DELETE, AND IT MUST NEVER BE FILTERED AT THE MODEL
    #: LAYER. `Quiz.questions` deliberately still contains retired questions.
    #: Filtering here would rewrite history twice over: a legacy attempt (no
    #: snapshot) falls back to the live quiz, so a retired question would
    #: vanish from a past attempt that received it; and the coach's editor
    #: would lose the row it needs in order to restore it.
    #:
    #: Exactly one place filters: `attempts.deliverable_question_ids`, on the
    #: NEW-attempt path only. See docs/DESIGN-question-retirement.md §4.
    #:
    #: Distinct from Phase 3 exclusions on purpose. Retirement changes WHO GETS
    #: the question in future; exclusion changes WHETHER IT COUNTS for players
    #: who already got it. Neither implies the other.
    retired_at = db.Column(db.DateTime(timezone=True), nullable=True)
    #: Taken from the authenticated session, never from the payload. SET NULL
    #: on coach deletion, mirroring how the codebase treats a departed author
    #: elsewhere - the retirement decision outlives the person who made it.
    retired_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    quiz = db.relationship("Quiz", back_populates="questions")
    options = db.relationship(
        "QuestionOption",
        back_populates="question",
        cascade="all, delete-orphan",
        order_by="QuestionOption.position",
    )
    image = db.relationship(
        "QuestionImage",
        back_populates="question",
        cascade="all, delete-orphan",
        uselist=False,
    )
    # A question gets its picture from EITHER an uploaded still
    # (`image`) OR a document-page region - never both. The schema does not
    # enforce that; the service layer does, and a test asserts it. Unifying
    # the two is the documented long-term target (design doc §4), deliberately
    # not attempted here.
    regions = db.relationship(
        "QuestionRegion",
        back_populates="question",
        cascade="all, delete-orphan",
        order_by="QuestionRegion.position",
        passive_deletes=True,
    )
    # passive_deletes=True: question_id has ON DELETE CASCADE at the DB level, so
    # let Postgres remove dependent answers instead of SQLAlchemy trying (and
    # failing, since the column is NOT NULL) to null them out first.
    answers = db.relationship("Answer", back_populates="question", passive_deletes=True)

    @property
    def is_retired(self) -> bool:
        """Whether this question has been stopped from FUTURE delivery.

        Says nothing about attempts that already received it - they keep it,
        keep their answers, and keep scoring it exactly as before.
        """
        return self.retired_at is not None

    def to_dict(self, include_correct_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "question_text": self.question_text,
            "question_type": self.question_type.value,
            "position": self.position,
            # Gated by the same flag as the correct answers: the explanation
            # is teaching material, and a player taking a graded quiz must
            # not receive it. The play routes decide when to include it - in
            # practice mode, only after the question has been answered.
            "auto_gradable": self.question_type in AUTO_GRADABLE_TYPES,
            # Draw Response questions never require options. A converted one
            # may still carry rows (migration d2b5f8a41c32 keeps them), so they
            # are withheld here rather than deleted - inert, not lost.
            "options": (
                []
                if self.question_type in OPTIONLESS_TYPES
                else [o.to_dict(include_correct_answers) for o in self.options]
            ),
            "image": self.image.to_dict() if self.image else None,
            # Lets the editor show "Needs an image" without re-deriving the
            # rule, and lets the activation guard explain itself.
            "needs_image": self.question_type is QuestionType.DRAW_RESPONSE and self.image is None,
            # V1 permits exactly one region per question, so this is singular
            # in the payload even though the schema stores a list.
            "region": self.regions[0].to_dict() if self.regions else None,
            # Coach-facing state, NOT a reason to hide the row. The editor
            # renders a retired question de-emphasised with a restore action -
            # a retired question a coach cannot see is one they cannot bring
            # back.
            "allows_multiple_answers": self.allows_multiple_answers,
            "is_retired": self.is_retired,
            "retired_at": self.retired_at.isoformat() if self.retired_at else None,
        }
        # THE ANSWER. Gated by exactly the same flag that hides which option is
        # correct, because it is exactly the same secret: shipping this to a
        # player would hand them the answer to a question whose whole purpose
        # is that they cannot see it.
        if include_correct_answers:
            data["answer_explanation"] = self.answer_explanation
            data["expected_answers"] = self.expected_answers or []
            data["answer_matching"] = self.answer_matching
        return data


class QuestionOption(db.Model):
    __tablename__ = "question_options"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(
        db.Integer, db.ForeignKey("questions.id"), nullable=False, index=True
    )
    option_text = db.Column(db.String(500), nullable=False)
    is_correct_answer = db.Column(db.Boolean, nullable=False, default=False)
    position = db.Column(db.Integer, nullable=False, default=0)

    question = db.relationship("Question", back_populates="options")

    def to_dict(self, include_correct_answer: bool = False) -> dict:
        data = {
            "id": self.id,
            "question_id": self.question_id,
            "option_text": self.option_text,
            "position": self.position,
        }
        if include_correct_answer:
            data["is_correct_answer"] = self.is_correct_answer
        return data
