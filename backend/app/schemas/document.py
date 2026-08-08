"""Source-document request schemas."""

from marshmallow import Schema, fields, validate


class DocumentUpdateSchema(Schema):
    """Only the title is editable. Everything else about a source document is
    immutable by design - see models/source_document.py and design doc §9."""

    title = fields.Str(required=True, validate=validate.Length(min=1, max=255))
