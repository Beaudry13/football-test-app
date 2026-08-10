"""Access code activation request schema."""

from marshmallow import Schema, fields, validate

from app.models.assessment_mode import ASSESSMENT_MODES, DEFAULT_MODE


class ActivateQuizSchema(Schema):
    # Saved Group(s) to grant access under this activation, in addition to
    # (or instead of) the quiz's own Roster - see
    # app.services.access_codes.effective_roster_names.
    group_ids = fields.List(fields.Int(), required=False, load_default=list)
    # Defaults to GRADED so every existing client, and every existing
    # integration, keeps producing graded assignments untouched.
    mode = fields.Str(
        required=False,
        load_default=DEFAULT_MODE,
        validate=validate.OneOf(ASSESSMENT_MODES),
    )
