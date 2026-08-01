"""Question request schemas.

Cross-field business rules (how many options a question type needs, that
exactly one is correct, etc.) are enforced in the route layer via
`validate_options_for_type` rather than here, since marshmallow's
conditional validation across a polymorphic payload gets unreadable fast.
"""

from marshmallow import Schema, fields, validate

from app.errors import ApiError
from app.models import QuestionType

QUESTION_TYPE_VALUES = [t.value for t in QuestionType]


class QuestionOptionSchema(Schema):
    option_text = fields.Str(required=True, validate=validate.Length(min=1, max=500))
    is_correct_answer = fields.Bool(required=False, load_default=False)


class QuestionCreateSchema(Schema):
    question_text = fields.Str(required=True, validate=validate.Length(min=1))
    question_type = fields.Str(required=True, validate=validate.OneOf(QUESTION_TYPE_VALUES))
    options = fields.List(fields.Nested(QuestionOptionSchema), required=False, load_default=list)
    position = fields.Int(required=False, load_default=None)


class QuestionUpdateSchema(Schema):
    question_text = fields.Str(required=False, validate=validate.Length(min=1))
    question_type = fields.Str(required=False, validate=validate.OneOf(QUESTION_TYPE_VALUES))
    options = fields.List(fields.Nested(QuestionOptionSchema), required=False)


class QuestionReorderSchema(Schema):
    question_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1))


class AnnotationsUpdateSchema(Schema):
    annotations = fields.List(fields.Dict(), required=True)


def validate_options_for_type(question_type: str, options: list[dict]) -> None:
    if question_type == QuestionType.WRITTEN.value:
        return

    if question_type == QuestionType.TRUE_FALSE.value:
        if len(options) != 2:
            raise ApiError("True/false questions must have exactly 2 options")
    elif question_type == QuestionType.MULTIPLE_CHOICE.value:
        if len(options) < 2:
            raise ApiError("Multiple choice questions need at least 2 options")

    correct_count = sum(1 for option in options if option.get("is_correct_answer"))
    if correct_count != 1:
        raise ApiError("Exactly one option must be marked as the correct answer")
