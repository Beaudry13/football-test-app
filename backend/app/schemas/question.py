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
    canvas_width = fields.Int(required=False, allow_none=True, load_default=None)


def validate_options_for_type(question_type: str, options: list[dict]) -> None:
    """Raises ApiError(422) - same status as marshmallow validation failures,
    since this is the same class of error (semantically invalid payload),
    just enforced in Python because it's a cross-field business rule."""
    if question_type in (QuestionType.WRITTEN.value, QuestionType.DRAW_RESPONSE.value):
        # Neither is answered by picking from a list. A Draw Response question
        # may still HAVE option rows - one converted from multiple choice by
        # migration d2b5f8a41c32 keeps them, inert - but it never requires
        # them, and authoring one never creates them.
        return

    if question_type == QuestionType.TRUE_FALSE.value:
        if len(options) != 2:
            raise ApiError("True/false questions must have exactly 2 options", status_code=422)
    elif question_type == QuestionType.MULTIPLE_CHOICE.value:
        if len(options) < 2:
            raise ApiError("Multiple choice questions need at least 2 options", status_code=422)

    correct_count = sum(1 for option in options if option.get("is_correct_answer"))
    if correct_count != 1:
        raise ApiError("Exactly one option must be marked as the correct answer", status_code=422)
