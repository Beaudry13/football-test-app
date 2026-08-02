"""Coach registration/login request schemas."""

from marshmallow import Schema, fields, validate


class RegisterSchema(Schema):
    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    organization = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class RegisterWithInviteSchema(Schema):
    """Joining an existing organization: the org comes from the invite, so
    there's no `organization` field to supply (or to spoof)."""

    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    invite_code = fields.Str(required=True, validate=validate.Length(min=1, max=64))


class LoginSchema(Schema):
    email = fields.Email(required=True)
    password = fields.Str(required=True)
