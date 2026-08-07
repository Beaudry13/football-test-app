"""Question and question-option models."""

import enum

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


#: Types whose answer a coach grades by hand, rather than the server scoring
#: it from a selected option. Named once so the several places that ask
#: "does this need grading" cannot drift apart - the same hazard CLAUDE.md
#: records for the CORRECT/INCORRECT vocabulary.
MANUALLY_GRADED_TYPES = frozenset({QuestionType.WRITTEN, QuestionType.DRAW_RESPONSE})


class Question(db.Model):
    __tablename__ = "questions"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    question_text = db.Column(db.Text, nullable=False)
    question_type = db.Column(db.Enum(QuestionType), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

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
                if self.question_type is QuestionType.DRAW_RESPONSE
                else [o.to_dict(include_correct_answers) for o in self.options]
            ),
            "image": self.image.to_dict() if self.image else None,
            # Lets the editor show "Needs an image" without re-deriving the
            # rule, and lets the activation guard explain itself.
            "needs_image": self.question_type is QuestionType.DRAW_RESPONSE and self.image is None,
        }
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
