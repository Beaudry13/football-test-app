"""Group request schemas."""

from marshmallow import Schema, fields, validate


class GroupCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class GroupUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class GroupPlayersUpsertSchema(Schema):
    players = fields.List(
        fields.Str(validate=validate.Length(min=1, max=255)),
        required=True,
        validate=validate.Length(min=1),
    )
