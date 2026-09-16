"""Folder request schemas."""

from marshmallow import Schema, fields, validate

from app.models.folder import FOLDER_AREA_QUIZZES, FOLDER_AREAS


class FolderCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    # Optional, root by default. Only settable here - never via
    # FolderUpdateSchema - see Folder.parent_folder_id's comment for why.
    parent_folder_id = fields.Int(required=False, allow_none=True, load_default=None)
    # Quizzes unless a caller says otherwise, so every existing client is
    # unchanged. Fixed at creation like the parent: there is no route that
    # moves a folder between areas.
    area = fields.Str(load_default=FOLDER_AREA_QUIZZES, validate=validate.OneOf(FOLDER_AREAS))


class FolderUpdateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
