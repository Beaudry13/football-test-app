from marshmallow import Schema, fields, validate


class RetestCreateSchema(Schema):
    """What a coach's confirmation screen sends when it says "Create retest".

    Every list here is a NARROWING of what the server already computed, never a
    widening. The server derives the eligible players and the missed questions
    from the recorded answers; these fields can only select a subset of that,
    and anything outside it is refused. A client cannot ask Peira to copy an
    arbitrary question or target a player who did not miss anything.
    """

    concept_id = fields.Int(required=True)
    #: Omitted means "every question the rule found". Present means "these,
    #: from that set" - the coach unticked one on the confirmation.
    question_ids = fields.List(fields.Int(), required=False, load_default=None, allow_none=True)
    #: Canonical players. The normal case.
    player_ids = fields.List(fields.Int(), required=False, load_default=list)
    #: Free-text roster entries, which have no Player row to point at. Kept so
    #: a legacy roster is not silently undeliverable.
    player_names = fields.List(
        fields.Str(validate=validate.Length(min=1, max=255)), required=False, load_default=list
    )
    title = fields.Str(required=False, allow_none=True, load_default=None,
                       validate=validate.Length(min=1, max=255))
