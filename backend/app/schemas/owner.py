"""Platform-owner request schemas."""

from marshmallow import Schema, fields, validate


class MergePreviewSchema(Schema):
    """Preview takes the same shape as execute minus the safety fields, so an
    operator can iterate on role decisions and watch the consequences update
    before committing to anything."""

    source_organization_id = fields.Int(required=True)
    destination_organization_id = fields.Int(required=True)
    #: {coach_id: "ADMIN"|"MEMBER"}. Absent means everyone defaults to MEMBER,
    #: which is the safe outcome - see organization_merge.coach_role_plan.
    coach_roles = fields.Dict(
        keys=fields.Str(),
        values=fields.Str(validate=validate.OneOf(["ADMIN", "MEMBER"])),
        required=False,
        load_default=None,
        allow_none=True,
    )


class MergeExecuteSchema(MergePreviewSchema):
    """The destructive call.

    `fingerprint` is required and unguessable-by-accident: it comes from a
    preview, and the service refuses if the organizations have changed since.
    The two acknowledgement booleans default to FALSE so a client that forgets
    them is refused rather than silently proceeding past a warning.
    """

    fingerprint = fields.Str(required=True, validate=validate.Length(min=64, max=64))
    acknowledge_collisions = fields.Bool(required=False, load_default=False)
    acknowledge_duplicate_players = fields.Bool(required=False, load_default=False)
