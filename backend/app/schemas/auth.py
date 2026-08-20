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


class RegisterWithBetaInviteSchema(Schema):
    """Creating a NEW organization from a beta invite.

    `organization` is required here and absent from RegisterWithInviteSchema
    above, and that difference is the whole distinction between the two invite
    types: an organization invite puts a coach into a program that already
    exists, this one lets them start their own.

    `invite_code` is generous about length because `beta_invites.normalise`
    forgives case, spaces, the PEIRA prefix and the group dashes - a coach
    retyping one off a text message must not be rejected by a validator before
    the service ever sees it.
    """

    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    organization = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    invite_code = fields.Str(required=True, validate=validate.Length(min=1, max=64))
