"""Request schemas for "don't count this question"."""

from marshmallow import Schema, fields, validate


class ExclusionCreateSchema(Schema):
    """Excluding one question from scoring.

    `access_code_id` is REQUIRED to be present but may be null, and that is
    deliberate rather than sloppy: null means QUIZ-WIDE, which rewrites every
    historical use of the quiz, so a client must state the scope explicitly
    rather than have it defaulted by omission. `load_default` would let a
    forgotten field silently become the destructive choice.
    """

    access_code_id = fields.Int(required=True, allow_none=True)
    reason = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=500)
    )
