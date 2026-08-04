"""Master-roster Player request schemas."""

from marshmallow import Schema, fields, validate


class PlayerCreateSchema(Schema):
    first_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    last_name = fields.Str(required=True, validate=validate.Length(min=1, max=100))
    jersey_number = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=4)
    )
    position = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=10)
    )
    photo_url = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=500)
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
    photo_url = fields.Str(
        required=False, allow_none=True, load_default=None, validate=validate.Length(max=500)
    )


class PlayerBulkCreateSchema(Schema):
    players = fields.List(
        fields.Nested(PlayerCreateSchema), required=True, validate=validate.Length(min=1)
    )


class GroupMembersAddSchema(Schema):
    player_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1))
