"""Coach registration/login request schemas."""

from marshmallow import Schema, fields, pre_load, validate


class RegisterWithInviteSchema(Schema):
    """Joining an existing organization: the org comes from the invite, so
    there's no `organization` field to supply (or to spoof)."""

    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    invite_code = fields.Str(required=True, validate=validate.Length(min=1, max=64))


class LoginSchema(Schema):
    email = fields.Email(required=True)
    password = fields.Str(required=True)


class RegisterWithBetaInviteSchema(Schema):
    """Creating a NEW organization from a beta invite.

    `organization` is required here and absent from RegisterWithInviteSchema
    above, and that difference is the whole distinction between the two invite
    types: an organization invite puts a coach into a program that already
    exists, this one lets them start their own.

    `invite_code` is generous about length because `beta_invites.normalise`
    forgives case, spaces, the PEIRA prefix and the group dashes - a coach
    retyping one off a text message must not be rejected by a validator before
    the service ever sees it.
    """

    username = fields.Str(required=True, validate=validate.Length(min=3, max=80))
    email = fields.Email(required=True)
    password = fields.Str(required=True, validate=validate.Length(min=8, max=128))
    organization = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    invite_code = fields.Str(required=True, validate=validate.Length(min=1, max=64))


class RequestAccessSchema(Schema):
    """Asking to be let into the beta.

    THREE FIELDS, AND `team` IS GENUINELY OPTIONAL. A coach who has not named
    their program yet, or who is asking on behalf of one, must not be stopped
    at the door by a field that only helps the owner recognise them later.

    No message box, no "how did you hear about us", no phone number. Every
    field here is one somebody fills in before they have any reason to trust
    the product, and the owner can ask anything else in the reply.
    """

    name = fields.Str(required=True, validate=validate.Length(min=1, max=120))
    email = fields.Email(required=True)
    team = fields.Str(load_default=None, allow_none=True, validate=validate.Length(max=200))

    @pre_load
    def strip_whitespace(self, data, **_kwargs):
        """Trim before validating, not after.

        An address pasted out of an email client arrives as
        `"  coach@example.com  "`, and `fields.Email` rejects it - so a coach
        would be told their perfectly good address was invalid. Stripping
        afterwards is too late; the validator has already refused it.
        """
        if not isinstance(data, dict):
            return data
        return {k: v.strip() if isinstance(v, str) else v for k, v in data.items()}


class RequestStaffInviteSchema(Schema):
    """A coach asking for one of their staff to be let into their organization.

    TWO FIELDS. The organization, the requester's identity and the time all
    come from the authenticated account - see services/staff_invite_requests.
    There is deliberately no `organization` field to send, which is what makes
    a near-duplicate program impossible on this path rather than merely
    discouraged.

    No title, no phone, no staff role, no message. The coach is saying one
    thing, and a form that asks for more makes them hesitate over columns
    nobody reads.
    """

    name = fields.Str(required=True, validate=validate.Length(min=1, max=120))
    email = fields.Email(required=True)

    @pre_load
    def strip_whitespace(self, data, **_kwargs):
        """Trim before validating - an address pasted out of a mail client
        arrives with spaces around it, and `fields.Email` refuses that."""
        if not isinstance(data, dict):
            return data
        return {k: v.strip() if isinstance(v, str) else v for k, v in data.items()}
