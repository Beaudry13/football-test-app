"""Organization request schemas."""

from marshmallow import Schema, fields, validate


class OrganizationUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class PlayerPinSecuritySchema(Schema):
    """The organization's own Player PIN Security switch. One boolean, and
    nothing else: turning protection on or off never issues, changes or deletes
    a credential."""

    enabled = fields.Bool(required=True)


class MemberRoleUpdateSchema(Schema):
    role = fields.Str(required=True, validate=validate.OneOf(["admin", "member"]))


class QuizOwnerUpdateSchema(Schema):
    """Explicit ownership transfer. The target coach is re-resolved inside the
    admin's own organization by the route, so this only has to be a number."""

    coach_id = fields.Int(required=True)
