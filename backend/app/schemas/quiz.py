"""Quiz request schemas."""

from marshmallow import Schema, fields, validate

from app.models.quiz import QUIZ_KIND, QUIZ_KINDS


class QuizCreateSchema(Schema):
    title = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    description = fields.Str(required=False, allow_none=True, load_default=None)
    one_question_at_a_time = fields.Bool(required=False, load_default=True)
    require_all_answers = fields.Bool(required=False, load_default=False)
    #: QUIZ, or REP for a Situational Rep. Set once, at creation.
    kind = fields.Str(required=False, load_default=QUIZ_KIND, validate=validate.OneOf(QUIZ_KINDS))


class QuizUpdateSchema(Schema):
    title = fields.Str(required=False, validate=validate.Length(min=1, max=255))
    description = fields.Str(required=False, allow_none=True)
    one_question_at_a_time = fields.Bool(required=False)
    require_all_answers = fields.Bool(required=False)
    # null moves the quiz to "Uncategorized"
    folder_id = fields.Int(required=False, allow_none=True)
