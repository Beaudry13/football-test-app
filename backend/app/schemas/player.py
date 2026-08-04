"""Master-roster Player request schemas."""

from marshmallow import Schema, fields, validate


# photo_url is deliberately absent from both schemas below - it must never
# be settable to an arbitrary client-supplied string (that would let a
# coach point a Player at an unvalidated remote URL). The only way it's
# ever set is POST /players/<id>/photo, which uploads through
# services/file_storage.py and stores the resulting server-generated URL.
class PlayerCreateSchema(Schema):
    first_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    last_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    jersey_number = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=4)
    )
    position = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=10)
    )


class PlayerUpdateSchema(Schema):
    first_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    last_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    jersey_number = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=4)
    )
    position = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=10)
    )


class PlayerBulkCreateSchema(Schema):
    players = fields.List(
        fields.Nested(PlayerCreateSchema), required=True, validate=validate.Length(min=1)
    )


class GroupMembersAddSchema(Schema):
    player_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1))


class ImportPreviewSchema(Schema):
    raw_text = fields.Str(required=True, validate=validate.Length(min=1))
    # {"first_name": "First Name" | None, "last_name": ..., "full_name": ...,
    #  "jersey_number": ..., "position": ...} - source column header per
    # field, to override auto-detection. Omitted/None re-runs detection.
    column_mapping = fields.Dict(required=False, allow_none=True, load_default=None)


class ImportRowSchema(Schema):
    first_name = fields.Str(required=False, allow_none=True, load_default="")
    last_name = fields.Str(required=False, allow_none=True, load_default="")
    jersey_number = fields.Str(required=False, allow_none=True, load_default=None)
    position = fields.Str(required=False, allow_none=True, load_default=None)
    action = fields.Str(
        required=False, load_default="create", validate=validate.OneOf(["create", "update", "skip"])
    )
    existing_player_id = fields.Int(required=False, allow_none=True, load_default=None)


class ImportConfirmSchema(Schema):
    rows = fields.List(fields.Nested(ImportRowSchema), required=True, validate=validate.Length(min=1))
