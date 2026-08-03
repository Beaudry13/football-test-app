"""Folder request schemas."""

from marshmallow import Schema, fields, validate


class FolderCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    # Optional, root by default. Only settable here - never via
    # FolderUpdateSchema - see Folder.parent_folder_id's comment for why.
    parent_folder_id = fields.Int(required=False, allow_none=True, load_default=None)


class FolderUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
