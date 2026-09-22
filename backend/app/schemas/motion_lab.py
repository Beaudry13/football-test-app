"""Motion Lab request schemas.

These check the ENVELOPE (name, schema version, revision, folder). The
document inside is checked structurally by services/motion_documents.py, which
knows the authored model's shape; marshmallow would only be restating it.
"""

from marshmallow import Schema, ValidationError, fields, validate, validates_schema

_NAME = validate.Length(min=1, max=255)


class _Name(fields.Str):
    """A name, trimmed; blank after trimming is refused."""

    def _deserialize(self, value, attr, data, **kwargs):
        text = super()._deserialize(value, attr, data, **kwargs).strip()
        if not text:
            raise ValidationError("Name cannot be blank.")
        return text


class PlayCreateSchema(Schema):
    name = _Name(required=True, validate=_NAME)
    document = fields.Dict(required=True)
    schema_version = fields.Int(required=True, strict=True)
    folder_id = fields.Int(load_default=None, allow_none=True, strict=True)


class PlaySaveSchema(Schema):
    """PUT: the editor's autosave. The whole authored play, and the revision it
    was edited from - a save naming an older revision is refused, never merged."""

    name = _Name(required=True, validate=_NAME)
    document = fields.Dict(required=True)
    schema_version = fields.Int(required=True, strict=True)
    base_revision = fields.Int(required=True, strict=True, validate=validate.Range(min=1))


class PlayPatchSchema(Schema):
    """PATCH: Library housekeeping - rename, or file into a folder."""

    name = _Name(validate=_NAME)
    folder_id = fields.Int(allow_none=True, strict=True)

    @validates_schema
    def _something(self, data, **kwargs):
        if not data:
            raise ValidationError("Nothing to change.")


class PlayCopySchema(Schema):
    name = _Name(validate=_NAME)
    folder_id = fields.Int(allow_none=True, strict=True)


class LookCreateSchema(Schema):
    name = _Name(required=True, validate=_NAME)
    document = fields.Dict(required=True)
    schema_version = fields.Int(required=True, strict=True)


class LookSaveSchema(Schema):
    name = _Name(required=True, validate=_NAME)
    document = fields.Dict(required=True)
    schema_version = fields.Int(required=True, strict=True)
    base_revision = fields.Int(required=True, strict=True, validate=validate.Range(min=1))
