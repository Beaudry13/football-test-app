"""Player-facing (unauthenticated) request schemas."""

from marshmallow import Schema, fields, validate


class ValidateCodeSchema(Schema):
    code = fields.Str(required=True, validate=validate.Length(min=1, max=16))


class AnswerSubmissionSchema(Schema):
    question_id = fields.Int(required=True)
    answer_text = fields.Str(required=False, allow_none=True, load_default=None)
    selected_option_id = fields.Int(required=False, allow_none=True, load_default=None)


class SubmitQuizSchema(Schema):
    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    answers = fields.List(
        fields.Nested(AnswerSubmissionSchema), required=True, validate=validate.Length(min=1)
    )


class PlayerResultsSchema(Schema):
    code = fields.Str(required=True, validate=validate.Length(min=1, max=16))
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
