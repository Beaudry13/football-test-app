"""Roster request schemas."""

from marshmallow import Schema, fields, validate


class RosterUpsertSchema(Schema):
    players = fields.List(
        fields.Str(validate=validate.Length(min=1, max=255)),
        required=True,
        validate=validate.Length(min=1),
    )
