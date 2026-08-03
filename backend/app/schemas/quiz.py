"""Quiz request schemas."""

from marshmallow import Schema, fields, validate


class QuizCreateSchema(Schema):
    title = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    description = fields.Str(required=False, allow_none=True, load_default=None)
    one_question_at_a_time = fields.Bool(required=False, load_default=True)
    require_all_answers = fields.Bool(required=False, load_default=False)


class QuizUpdateSchema(Schema):
    title = fields.Str(required=False, validate=validate.Length(min=1, max=255))
    description = fields.Str(required=False, allow_none=True)
    one_question_at_a_time = fields.Bool(required=False)
    require_all_answers = fields.Bool(required=False)
    # null moves the quiz to "Uncategorized"
    folder_id = fields.Int(required=False, allow_none=True)
