"""Request validation for Competition Mode."""

from marshmallow import Schema, fields, validate

from app.models.competition import QUESTION_TIME_CHOICES


class CreateCompetitionSchema(Schema):
    """Eligibility scope and timing, set once when the lobby opens.

    An empty/absent `group_ids` means the whole active master roster - the
    common case, and the one a coach gets by doing nothing.
    """

    group_ids = fields.List(fields.Integer(), load_default=list)
    question_time_seconds = fields.Integer(
        load_default=None, allow_none=True, validate=validate.OneOf(QUESTION_TIME_CHOICES)
    )


class JoinCompetitionSchema(Schema):
    """Identity is a canonical player id and nothing else.

    No nickname, no typed name. A free-text field would let a player invent an
    identity the coach's results cannot be attributed to - the same rule the
    master roster established for /play.
    """

    player_id = fields.Integer(required=True)

    #: Sent only when a client already holds a seat and is retrying - a flaky
    #: network can lose the response to a successful join. Absent on a genuine
    #: first join. Never required, because a first-time player has nothing yet.
    reconnect_token = fields.Str(load_default=None, allow_none=True)
