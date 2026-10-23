"""Install request schemas (routes/installs.py)."""

from marshmallow import Schema, ValidationError, fields, validate

from app.models.install import ITEM_KINDS


class _Title(fields.Str):
    """A title, trimmed; blank after trimming is refused."""

    def _deserialize(self, value, attr, data, **kwargs):
        text = super()._deserialize(value, attr, data, **kwargs).strip()
        if not text:
            raise ValidationError("Give it a name.")
        return text


class InstallCreateSchema(Schema):
    title = _Title(required=True, validate=validate.Length(max=120))
    position_group = fields.Str(load_default=None, allow_none=True, validate=validate.Length(max=40))


class InstallPatchSchema(Schema):
    title = _Title(validate=validate.Length(max=120))
    position_group = fields.Str(allow_none=True, validate=validate.Length(max=40))
    archived = fields.Bool()
    #: True: this is the current install (any other stops being); false: none is.
    current = fields.Bool()


class InstallItemSchema(Schema):
    kind = fields.Str(required=True, validate=validate.OneOf(ITEM_KINDS))
    ref_id = fields.Int(required=True, strict=True)
    section_id = fields.Int(load_default=None, allow_none=True, strict=True)


class _LayoutSection(Schema):
    #: An existing section's id; absent or null for a new one.
    id = fields.Int(load_default=None, allow_none=True, strict=True)
    title = _Title(required=True, validate=validate.Length(max=80))
    item_ids = fields.List(fields.Int(strict=True), load_default=list)


class InstallLayoutSchema(Schema):
    """The whole order at once: the items before any section, then each
    section (in order) with its items (in order). Sections left out are gone;
    every item must be placed exactly once."""

    loose = fields.List(fields.Int(strict=True), load_default=list)
    sections = fields.List(fields.Nested(_LayoutSection), load_default=list)


class InstallDuplicateSchema(Schema):
    title = _Title(required=True, validate=validate.Length(max=120))
    #: Asked, never assumed: the copy replaces the current install only when he says so.
    make_current = fields.Bool(load_default=False)
