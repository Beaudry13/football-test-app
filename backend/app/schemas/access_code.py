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
    #: Practice-only: shuffle the question order for each new attempt.
    #: Defaults FALSE, so an existing client that never sends it activates
    #: exactly as it does today.
    randomize_questions = fields.Bool(required=False, load_default=False)
    mode = fields.Str(
        required=False,
        load_default=DEFAULT_MODE,
        validate=validate.OneOf(ASSESSMENT_MODES),
    )
    #: When this activation stops working, as an ABSOLUTE INSTANT.
    #:
    #: Optional, and omitting it keeps the historical 24-hour window exactly -
    #: so every existing client, and every existing integration, activates as
    #: it does today. The default lives in config, not here, because it is an
    #: operational value rather than a contract.
    #:
    #: AwareDateTime, so a naive wall-clock is REFUSED rather than guessed at.
    #: The client resolves what the coach picked through the browser's own
    #: timezone database; the server never interprets "9:00 PM".
    expires_at = fields.AwareDateTime(required=False, load_default=None)


class SetExpirySchema(Schema):
    """Change when the CURRENT active code stops working.

    An ABSOLUTE INSTANT, never a wall-clock string. The client converts what
    the coach picked using the browser's own timezone database and sends the
    moment it resolves to; the server compares instants and stores one. A naive
    "2026-08-22 09:00" would have to be guessed at as server-local or UTC, and
    either guess is wrong for somebody - see routes/access_codes.set_expiry.
    """

    expires_at = fields.AwareDateTime(required=True)
