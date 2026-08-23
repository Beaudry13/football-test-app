"""Player-facing (unauthenticated) request schemas."""

from marshmallow import Schema, fields, validate


class ValidateCodeSchema(Schema):
    code = fields.Str(required=True, validate=validate.Length(min=1, max=16))


class AnswerSubmissionSchema(Schema):
    question_id = fields.Int(required=True)
    answer_text = fields.Str(required=False, allow_none=True, load_default=None)
    selected_option_id = fields.Int(required=False, allow_none=True, load_default=None)
    #: "Select all that apply". A SET, sent whole on every save - the server
    #: replaces the stored selection with it rather than merging, so
    #: deselecting is expressible. Ignored on a single-choice question.
    selected_option_ids = fields.List(fields.Int(), required=False, allow_none=True, load_default=None)
    # The whole DrawingDocument, re-sent at submit as the same safety net the
    # text answers already get: autosave may have failed on a flaky
    # connection, and submit is the player's last chance to be heard.
    # Validated for shape in services/drawing_documents.py, not here -
    # marshmallow cannot express "a versioned envelope this client
    # understands" without duplicating that logic.
    drawing = fields.Dict(required=False, allow_none=True, load_default=None)


class SubmitQuizSchema(Schema):
    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    # Present when the player was selected from a canonical master-roster
    # entry (see NameStep/roster_players_v2) - absent for a legacy,
    # name-only roster/group. See services/attempts.py::find_attempt.
    player_id = fields.Int(required=False, allow_none=True, load_default=None)
    answers = fields.List(
        fields.Nested(AnswerSubmissionSchema), required=True, validate=validate.Length(min=1)
    )


class StartAttemptSchema(Schema):
    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    player_id = fields.Int(required=False, allow_none=True, load_default=None)


class SaveAnswerSchema(Schema):
    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    player_id = fields.Int(required=False, allow_none=True, load_default=None)
    question_id = fields.Int(required=True)
    answer_text = fields.Str(required=False, allow_none=True, load_default=None)
    selected_option_id = fields.Int(required=False, allow_none=True, load_default=None)
    #: "Select all that apply". A SET, sent whole on every save - the server
    #: replaces the stored selection with it rather than merging, so
    #: deselecting is expressible. Ignored on a single-choice question.
    selected_option_ids = fields.List(fields.Int(), required=False, allow_none=True, load_default=None)
    #: How long the player had this question in front of them before answering.
    #:
    #: MEASURED BY THE CLIENT, because only the client knows when a question
    #: reached the screen - the server sees a request, which is a different
    #: moment. Sent only where it means something: one-question-at-a-time
    #: delivery. Omitted (NULL) for an all-at-once quiz, where every question
    #: is on screen from page load and this figure would silently include the
    #: time spent on all the earlier ones.
    #:
    #: Bounded, and untrusted like every other client value. Negative is
    #: impossible; the 6-hour ceiling rejects a clock that jumped rather than
    #: recording a player who pondered one question overnight. Only the FIRST
    #: write for an answer is kept (see upsert_answer), so a later correction
    #: cannot overwrite a real measurement.
    time_to_answer_ms = fields.Int(
        required=False,
        allow_none=True,
        load_default=None,
        validate=validate.Range(min=0, max=6 * 60 * 60 * 1000),
    )


class CheckAnswerSchema(Schema):
    """Practice only: "I'm done with this question, show me how I did."

    Carries no answer of its own - whatever is already saved is what gets
    checked, so the verdict can never disagree with what was recorded.
    """

    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    player_id = fields.Int(required=False, allow_none=True, load_default=None)
    question_id = fields.Int(required=True)


class PlayerResultsSchema(Schema):
    code = fields.Str(required=True, validate=validate.Length(min=1, max=16))
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    # When set, disambiguates which of two same-name canonical Players'
    # results to return - without it, a name-only lookup can't tell two
    # "Chris Smith"s apart and would resolve to whichever row the query
    # happens to return first. See routes/play.py::player_results.
    player_id = fields.Int(required=False, allow_none=True, load_default=None)


class SaveDrawingSchema(Schema):
    """Autosave for a Draw Response answer.

    Deliberately separate from SaveAnswerSchema: a drawing payload is orders
    of magnitude larger than a text answer, is debounced differently, and
    carries a revision the text path has no concept of. Folding it in would
    make every keystroke autosave parse a field it never uses.
    """

    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    player_id = fields.Int(required=False, allow_none=True, load_default=None)
    question_id = fields.Int(required=True)
    document = fields.Dict(required=True)
    # The revision the client last saw. Absent on a first save; a stale one
    # is refused with 409 rather than silently overwriting.
    base_revision = fields.Int(required=False, allow_none=True, load_default=None)
