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
    answer_matching = db.Column(db.String(32), nullable=True)

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

    def to_dict(self, include_correct_answers: bool = False) -> dict:
        data = {
            "id": self.id,
            "quiz_id": self.quiz_id,
            "question_text": self.question_text,
            "question_type": self.question_type.value,
            "position": self.position,
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
        }
        # THE ANSWER. Gated by exactly the same flag that hides which option is
        # correct, because it is exactly the same secret: shipping this to a
        # player would hand them the answer to a question whose whole purpose
        # is that they cannot see it.
        if include_correct_answers:
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
