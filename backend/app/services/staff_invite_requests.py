"""Submitting, approving and declining staff invite requests.

WHAT MAKES THIS SAFE IS WHAT IT WILL NOT ACCEPT
------------------------------------------------
`submit` takes a COACH, not an organization id. The organization is read from
that coach's own row and can never arrive from a request body. A client that
sends `organization_id` is not rejected with an error - the field simply does
not exist anywhere in this path, which is stronger than validating it.

That is the duplicate-organization fix and the isolation guarantee at once:
the invited coach never types a program name, so they cannot invent a fifth
spelling of one that exists, and the requester cannot aim a request at an
organization they are not in.

APPROVAL IS WHERE THE CREDENTIAL IS BORN
-----------------------------------------
Submitting creates no token and grants no permission - see the model. Only
`approve` mints an `OrganizationInvite`, and it is the ordinary single-use one
the product already has, for the organization the request was tied to at
submission time. `services/invites.claim` then applies unchanged: the invited
coach joins THAT organization as a MEMBER and is never asked to name it.

WHEN THIS EVENTUALLY BECOMES A PERMISSION
------------------------------------------
The intended end state is that a trusted organization can issue its own
invites without waiting for anybody. Nothing here has to change for that: the
approval step is a separate function on a separate row, so "trusted orgs skip
it" is a caller-side decision about whether to call `approve` immediately,
not a rewrite of how a request is recorded. Keeping mint-the-token OUT of
`submit` is precisely what leaves that door open.

DECISIONS ARE CONDITIONAL UPDATES
----------------------------------
Approving and declining race each other, and approving twice would mint two
invites for one request - two people admitted where one was vouched for. So
each decision is a conditional UPDATE that only fires on a still-pending row
and reports whether it won, the same rule as both invite types.
"""

from __future__ import annotations

from sqlalchemy import text as sa_text, update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.extensions import db
from app.models import Coach, OrganizationInvite, StaffInviteRequest
from app.services.invites import INVITE_TTL_DAYS, generate_invite_code

#: What a coach is told when they ask. One message whether or not this is the
#: first time they have asked for this person - a second identical request is
#: a coach wondering whether the first one worked, not something to scold.
#:
#: IT PROMISES NOTHING PEIRA DOES NOT DO. Peira sends no email; a person reads
#: the request, decides, and passes the invite on by hand. Saying "we'll email
#: them" described a feature that does not exist, and a coach who believed it
#: would sit waiting for a message nothing was going to send. Naming the delay
#: is also the more useful sentence: it tells them not to ask again in an hour.
REQUEST_RECEIVED = "Thanks - we review these by hand, so it won't be instant."


def normalise_email(raw: str) -> str:
    """Trim and lower-case, and nothing cleverer.

    Deliberately not stripping dots or `+tags` - those are Gmail conventions
    rather than email ones, and applying them everywhere would merge two
    genuinely different addresses at providers that keep them apart. Same rule
    as services/access_requests, and for the same reason.
    """
    return (raw or "").strip().lower()


def submit(coach: Coach, name: str, email: str) -> None:
    """Record that `coach` wants this person in THEIR organization.

    Returns nothing, and creates nothing that can be redeemed. The
    organization comes from `coach`; there is no parameter for it.

    ON CONFLICT DO NOTHING because a double click is a genuine race and a
    coach who did nothing wrong must not meet an IntegrityError. The partial
    unique index only covers PENDING rows, so a person who was declined can be
    asked for again later - a decision is not a permanent ban.
    """
    db.session.execute(
        pg_insert(StaffInviteRequest)
        .values(
            organization_id=coach.organization_id,
            requested_by_coach_id=coach.id,
            name=(name or "").strip(),
            email=normalise_email(email),
            requested_at=StaffInviteRequest.now(),
        )
        # INFERENCE, NOT `constraint=`. The uniqueness is a PARTIAL index, and
        # `ON CONFLICT ON CONSTRAINT` cannot name one - the predicate has to be
        # restated here so Postgres can match the same index.
        .on_conflict_do_nothing(
            index_elements=["organization_id", "email"],
            index_where=sa_text("approved_at IS NULL AND declined_at IS NULL"),
        )
    )
    db.session.commit()


def pending() -> list[StaffInviteRequest]:
    """Everything still waiting on a decision, oldest first."""
    return (
        StaffInviteRequest.query.filter(
            StaffInviteRequest.approved_at.is_(None),
            StaffInviteRequest.declined_at.is_(None),
        )
        .order_by(StaffInviteRequest.requested_at)
        .all()
    )


def approve(request: StaffInviteRequest, approved_by: Coach | None = None) -> str | None:
    """Mint the invite this request was asking for. Returns its code, or None.

    None means somebody else already decided this request between reading it
    and here - and NO INVITE WAS CREATED. Approving twice would admit two
    people where one was vouched for, so the conditional UPDATE below decides,
    and the invite is only committed once that UPDATE has won.

    The returned code is the plaintext an operator sends on. It is not stored
    anywhere else by this module; the invite row holds it because that is how
    `OrganizationInvite` already works.
    """
    invite = OrganizationInvite(
        # THE ORGANIZATION COMES FROM THE REQUEST, which got it from the
        # requesting coach. It is never chosen at approval time - an operator
        # picking an organization here is exactly how somebody ends up in the
        # wrong program.
        organization_id=request.organization_id,
        code=generate_invite_code(),
        created_by_coach_id=approved_by.id if approved_by is not None else None,
        created_at=StaffInviteRequest.now(),
        expires_at=OrganizationInvite.default_expiry(INVITE_TTL_DAYS),
    )
    db.session.add(invite)
    db.session.flush()

    result = db.session.execute(
        sa_update(StaffInviteRequest)
        .where(
            StaffInviteRequest.id == request.id,
            StaffInviteRequest.approved_at.is_(None),
            StaffInviteRequest.declined_at.is_(None),
        )
        .values(approved_at=StaffInviteRequest.now(), approved_invite_id=invite.id)
    )
    if result.rowcount != 1:
        # Losing must leave no invite behind: an unattached single-use
        # invitation is a live credential nobody is accountable for.
        db.session.rollback()
        return None

    db.session.commit()
    return invite.code


def decline(request: StaffInviteRequest) -> bool:
    """Record that this request was not granted. True if this call decided it.

    Nothing is deleted and nothing is emailed. Declining is not a ban - the
    pending-only unique index means the same person can be asked for again.
    """
    result = db.session.execute(
        sa_update(StaffInviteRequest)
        .where(
            StaffInviteRequest.id == request.id,
            StaffInviteRequest.approved_at.is_(None),
            StaffInviteRequest.declined_at.is_(None),
        )
        .values(declined_at=StaffInviteRequest.now())
    )
    db.session.commit()
    return result.rowcount == 1
