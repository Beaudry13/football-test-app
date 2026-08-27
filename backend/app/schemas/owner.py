"""Platform-owner request schemas."""

from marshmallow import Schema, fields, validate

from app.services import beta_invites


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


class BetaInviteCreateSchema(Schema):
    """What the owner supplies when issuing a coach invitation.

    DELIBERATELY NOT AN EMAIL FIELD. `label` is the owner's own note - "Coach
    Smith - Madeira" - and answers "who was this for" in the list before the
    invite is redeemed, which is the only window where nothing else can answer
    it. Binding an invite to an address instead would add a failure mode with
    no security gain: the token is the credential, and a coach who signs up
    from a different address would be told their invitation is invalid.

    The PROGRAM NAME is not asked for here either. A beta invite CREATES an
    organization, and its name is supplied during registration by the coach who
    will run it - asking the owner to guess it first would either be
    overwritten or become a name the coach is stuck with.
    """

    label = fields.Str(
        required=False, allow_none=True, load_default=None,
        validate=validate.Length(max=200),
    )
    #: Days from now. Null issues one that never expires - not offered in the
    #: dashboard, but kept so a long-lived invite is a deliberate act.
    expires_in_days = fields.Int(
        required=False, allow_none=True,
        load_default=beta_invites.DEFAULT_EXPIRY_DAYS,
        validate=validate.Range(min=1, max=365),
    )
