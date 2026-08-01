"""Folder request schemas."""

from marshmallow import Schema, fields, validate


class FolderCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))


class FolderUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
