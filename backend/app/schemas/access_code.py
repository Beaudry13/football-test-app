"""Access code activation request schema."""

from marshmallow import Schema, fields


class ActivateQuizSchema(Schema):
    # Saved Group(s) to grant access under this activation, in addition to
    # (or instead of) the quiz's own Roster - see
    # app.services.access_codes.effective_roster_names.
    group_ids = fields.List(fields.Int(), required=False, load_default=list)
