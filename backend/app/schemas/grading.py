"""Grading/feedback request schemas."""

from marshmallow import Schema, fields


class GradeAnswerSchema(Schema):
    is_correct = fields.Bool(required=True)
    coach_feedback = fields.Str(required=False, allow_none=True, load_default=None)
