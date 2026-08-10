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
        # Empty is allowed: the modern UI's legacy section is
        # removal-only, and clearing the last legacy row is a real thing a
        # coach needs to do. Canonical members are untouched by this editor
        # either way (see _replace_group_players / _replace_roster).
        validate=validate.Length(min=0),
    )
