"""Coach registration/login request schemas."""

from marshmallow import Schema, fields, validate


class RegisterSchema(Schema):
    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    organization = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class LoginSchema(Schema):
    email = fields.Email(required=True)
    password = fields.Str(required=True)
