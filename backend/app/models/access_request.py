"""Somebody asking to be let into the beta.

WHAT THIS IS
------------
The other side of `BetaInvite`. An invite is the owner reaching out; this is a
coach putting their hand up. Nothing about it grants anything - recording a
request creates no account, no organization and no entitlement. It is a list
of people to consider, and considering them is a human act.

WHAT IT DELIBERATELY DOES NOT STORE
-----------------------------------
Name, email and an optional team. Not an IP address, not a user agent, not a
referrer, not a message field, not a status column, not a follow-up date.

Every one of those is a CRM feature, and a CRM is a thing that has to be
maintained, backed up and reasoned about under data protection - bought here
with an unknown future benefit. The owner needs to know who asked and how to
reach them. That is three columns.

There is no `status` in particular because it would immediately be wrong: an
invite that gets issued is recorded in `beta_invites`, and a second place
claiming to know whether somebody was accepted is a second place to be stale.

WHY THE EMAIL IS UNIQUE
-----------------------
So asking twice is harmless. A coach who submits the form again - because
nothing appeared to happen, or because they forgot - must get the same calm
answer as the first time and must not create a duplicate row. The FIRST
request time is the one kept: how long somebody has been waiting is the
interesting number, not when they last got impatient.

The address is stored already-normalised (see services/access_requests) so the
uniqueness is real rather than a formality that `Coach@example.com` walks past.
"""

from datetime import datetime, timezone

from app.extensions import db


class AccessRequest(db.Model):
    __tablename__ = "access_requests"

    id = db.Column(db.Integer, primary_key=True)

    #: What they call themselves. Not split into first/last - a name is
    #: whatever somebody types, and coaches are addressed by one string.
    name = db.Column(db.String(120), nullable=False)

    #: Lower-cased and trimmed before it arrives here - see
    #: services/access_requests.normalise_email. UNIQUE, so a second request
    #: from the same person is silently the same request.
    email = db.Column(db.String(255), nullable=False, unique=True, index=True)

    #: Optional, and genuinely optional. A coach who has not named their
    #: program yet, or is asking on behalf of one, must not be blocked at the
    #: door by a field that only helps the owner recognise them.
    team = db.Column(db.String(200), nullable=True)

    requested_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )

    @staticmethod
    def now() -> datetime:
        return datetime.now(timezone.utc)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "team": self.team,
            "requested_at": self.requested_at.isoformat() if self.requested_at else None,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<AccessRequest {self.email}>"
