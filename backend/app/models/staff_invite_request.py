"""A coach asking for one of their staff to be let into THEIR organization.

THE THIRD KIND OF ASKING, AND IT IS NOT THE OTHER TWO
-----------------------------------------------------
* `AccessRequest` - a stranger with no account asks to be let into Peira. No
  organization exists yet, so they type a team NAME and somebody decides.
* `BetaInvite` - the owner reaching out to somebody with no account. Redeeming
  it CREATES an organization.
* `StaffInviteRequest` (this) - a coach who already has an account asking for a
  colleague to join the organization they are ALREADY IN.

The difference that matters is where the organization comes from. This one
never asks for it and never accepts it from the client: it is copied from the
requesting coach's own row at submission time. That is the whole mechanism for
stopping "UC" / "Cincinnati" / "University of Cincinnati" / "Cincinnati
Football" becoming four organizations - the second coach through the door
never gets the chance to type a name at all.

A REQUEST IS STRUCTURALLY NOT AN INVITE
---------------------------------------
This table has NO token, and no column that could ever hold one. Nothing here
can be redeemed, because there is nothing here to redeem WITH. Approving a
request creates a separate `OrganizationInvite` row and records its id in
`approved_invite_id`; until somebody does that, the request is a note.

That is deliberately structural rather than a status field reading "pending".
A status is a promise the code has to keep. An absent token is a fact the
schema enforces: no bug in a route, no missed branch and no future refactor
can turn a request into something a stranger can redeem, because the secret
does not exist until a human makes one.

WHY TIMESTAMPS RATHER THAN A STATUS ENUM
-----------------------------------------
Same reason as `BetaInvite`. `approved_at` and `declined_at` record WHEN a
decision happened and are write-once; a `status` column records only the last
thing somebody wrote and cannot say when. Pending is the absence of both,
which is a fact rather than a fourth value to keep in sync.

WHAT THIS DELIBERATELY DOES NOT STORE
--------------------------------------
No title, no phone, no staff role, no message, no justification. The coach is
saying one thing - "this person is on my staff, let them in" - and the only
information that survives contact with that sentence is a name and an address
to send the invite to. Everything else is a form field that makes a coach
hesitate in exchange for a column nobody reads.

No `notes` from the approver either: the decision is the record, and a free
text field is where a CRM starts.
"""

from datetime import datetime, timezone

from app.extensions import db


class StaffInviteRequest(db.Model):
    __tablename__ = "staff_invite_requests"

    __table_args__ = (
        # PENDING ROWS ONLY, and NULLs are why this is stated as a WHERE rather
        # than a plain unique constraint: Postgres treats NULLs as distinct, so
        # a unique index over (organization_id, email, approved_at) would let
        # any number of pending rows coexist. Decided rows drop out of the
        # index entirely, so declining somebody in August cannot stop them
        # being asked for again in September.
        db.Index(
            "uq_pending_staff_invite_request",
            "organization_id",
            "email",
            unique=True,
            postgresql_where=db.text("approved_at IS NULL AND declined_at IS NULL"),
        ),
    )

    id = db.Column(db.Integer, primary_key=True)

    #: THE ORGANIZATION IS NEVER SUPPLIED BY THE CLIENT. It is copied from the
    #: requesting coach's own row, which is why a staff invite cannot create a
    #: near-duplicate program and cannot aim at somebody else's.
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    #: SET NULL rather than CASCADE: a coach leaving must not delete the record
    #: of a colleague they vouched for, especially one already approved.
    requested_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    #: The prospective coach. A name to recognise them by and an address to
    #: send the invite to - see the module docstring for what is absent.
    name = db.Column(db.String(120), nullable=False)
    #: Stored already trimmed and lower-cased, so "one pending request per
    #: person" is real rather than a formality `Coach@example.com` walks past.
    email = db.Column(db.String(255), nullable=False)

    requested_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )

    approved_at = db.Column(db.DateTime(timezone=True), nullable=True)
    #: The invite approval actually minted. THE ONLY LINK BETWEEN A REQUEST AND
    #: A CREDENTIAL, and it points outward - the token itself lives on the
    #: invite, never here.
    approved_invite_id = db.Column(
        db.Integer,
        db.ForeignKey("organization_invites.id", ondelete="SET NULL"),
        nullable=True,
    )
    declined_at = db.Column(db.DateTime(timezone=True), nullable=True)

    organization = db.relationship("Organization")

    @staticmethod
    def now() -> datetime:
        return datetime.now(timezone.utc)

    def is_pending(self) -> bool:
        """Nobody has decided yet. The absence of both decisions, not a value."""
        return self.approved_at is None and self.declined_at is None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "organization_id": self.organization_id,
            "requested_by_coach_id": self.requested_by_coach_id,
            "name": self.name,
            "email": self.email,
            "requested_at": self.requested_at.isoformat() if self.requested_at else None,
            "approved_at": self.approved_at.isoformat() if self.approved_at else None,
            "declined_at": self.declined_at.isoformat() if self.declined_at else None,
            "is_pending": self.is_pending(),
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<StaffInviteRequest {self.email} org={self.organization_id}>"
