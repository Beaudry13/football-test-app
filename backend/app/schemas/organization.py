"""Organization request schemas."""

from marshmallow import Schema, fields, validate


class OrganizationUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class MemberRoleUpdateSchema(Schema):
    role = fields.Str(required=True, validate=validate.OneOf(["admin", "member"]))


class QuizOwnerUpdateSchema(Schema):
    """Explicit ownership transfer. The target coach is re-resolved inside the
    admin's own organization by the route, so this only has to be a number."""

    coach_id = fields.Int(required=True)
