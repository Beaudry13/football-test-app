"""Organization request schemas."""

from marshmallow import Schema, fields, validate


class OrganizationUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class MemberRoleUpdateSchema(Schema):
    role = fields.Str(required=True, validate=validate.OneOf(["admin", "member"]))
