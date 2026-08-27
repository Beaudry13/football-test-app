"""An invitation to create a Peira account during the closed beta.

THREE DIFFERENT CODES NOW EXIST, AND THEY MUST NOT BE CONFUSED
--------------------------------------------------------------
* `AccessCode` - a PLAYER types six characters to take one quiz. Short-lived,
  hand-typed from a sideline card, scoped to one Peira.
* `OrganizationInvite` - a coach invites another coach INTO AN ORGANIZATION
  THAT ALREADY EXISTS. The redeemer becomes a MEMBER of that org.
* `BetaInvite` (this) - lets somebody who has no Peira account create one, and
  with it their OWN organization, as its ADMIN.

They are separate models on purpose. The two invite types differ in who issues
them, what the redeemer becomes, and what the redeemer must supply - an
organization invite must NOT ask for an organization name, and a beta invite
MUST. Folding them into one table would leave half the columns meaningless
depending on a null check, and the failure mode of getting that wrong is a
stranger silently joining somebody's program.

WHAT THIS IS NOT
----------------
It is not a subscription, an entitlement or a plan. It answers exactly one
question - HOW DID THIS COACH GET INTO THE BETA - and it answers it once, at
signup. Anything that needs to know what a coach is currently allowed to do
must not read this table; that is a different concept and will need a
different one. Keeping the two apart is what stops billing, when it arrives,
from having to rewrite account identity.

THE TOKEN IS A CREDENTIAL, SO IT IS NOT STORED
-----------------------------------------------
Only a SHA-256 of the token is kept. A database leak therefore hands out no
usable invitations. The consequence is deliberate and worth stating: an invite
cannot be re-read after it is created. If the owner loses one, they revoke it
and issue another - which is cheaper than the alternative, where a stolen
backup is a set of live account-creation grants.

`token_prefix` exists so a human can still tell two invites apart in a list
without the full token being recoverable.
"""

from datetime import datetime, timezone

from app.extensions import db


class BetaInvite(db.Model):
    __tablename__ = "beta_invites"

    id = db.Column(db.Integer, primary_key=True)

    #: SHA-256 of the issued token. Looked up by hash, so the plaintext never
    #: needs to exist in the database at all. Unique because two invites
    #: hashing the same would mean the same token was issued twice.
    token_hash = db.Column(db.String(64), nullable=False, unique=True, index=True)
    #: The first few characters of the token, for telling invites apart in a
    #: list. NOT enough to redeem with - see the module docstring.
    token_prefix = db.Column(db.String(16), nullable=False)

    #: The owner's own note - "Coach Smith - Madeira". Answers "who was this
    #: one for" BEFORE it is redeemed, which is the only window where nothing
    #: else can answer it.
    label = db.Column(db.String(200), nullable=True)

    created_at = db.Column(
        db.DateTime(timezone=True), nullable=False, server_default=db.func.now()
    )
    #: SET NULL, matching OrganizationInvite: a coach leaving must not delete
    #: the record of invitations they issued.
    created_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    #: Redemption. Both are set together, in one conditional UPDATE - see
    #: services/beta_invites.redeem.
    redeemed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    redeemed_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    #: When this stops working on its own. NULL means it never does, which is
    #: what every invite issued before expiry existed still means - see
    #: migration d4c1e8b7a903. New invites get a deadline so an unsent or
    #: forgotten invitation does not stay live indefinitely.
    expires_at = db.Column(db.DateTime(timezone=True), nullable=True)

    #: Cancelling one issued by mistake. A timestamp rather than a boolean
    #: because "when did we stop trusting this" is worth more than "is it
    #: off", and costs the same.
    revoked_at = db.Column(db.DateTime(timezone=True), nullable=True)

    created_by = db.relationship("Coach", foreign_keys=[created_by_coach_id])
    redeemed_by = db.relationship("Coach", foreign_keys=[redeemed_by_coach_id])

    def is_expired(self) -> bool:
        """Past its deadline. NULL expires_at never expires.

        This entry used to read "THERE IS DELIBERATELY NO EXPIRY", on the
        argument that an invite handed to a named coach should not quietly die
        on a timer. That was reversed deliberately (owner decision, Aug 2026):
        an invitation is a live grant to create an account, and one that is
        mislaid or forwarded should stop being spendable without the owner
        having to remember to revoke it. Revocation remains the way to end one
        EARLY, and still leaves a record of the decision.

        Invites issued before the deadline existed keep NULL and keep the old
        behaviour, because retroactively killing invitations already sent to
        real coaches would be the exact surprise this is meant to avoid.
        """
        return self.expires_at is not None and self.expires_at <= self.now()

    def is_usable(self) -> bool:
        """Not revoked, not already redeemed, not past its deadline."""
        return (
            self.revoked_at is None
            and self.redeemed_at is None
            and not self.is_expired()
        )

    def to_dict(self) -> dict:
        """Owner-facing. Deliberately carries NO token - not even the hash."""
        return {
            "id": self.id,
            "token_prefix": self.token_prefix,
            "label": self.label,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "redeemed_at": self.redeemed_at.isoformat() if self.redeemed_at else None,
            "redeemed_by_coach_id": self.redeemed_by_coach_id,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
            "is_usable": self.is_usable(),
            #: One word for the owner's list, decided here so the dashboard and
            #: the CLI cannot disagree about what "expired" means.
            "status": self.status(),
        }

    def status(self) -> str:
        """Redeemed / Revoked / Expired / Pending, in that order of precedence.

        REDEEMED WINS OVER EXPIRED. An invite that was used and then sat past
        its deadline was still used, and reporting it as expired would lose the
        fact that a coach is on the platform because of it. Revoked likewise
        outranks expired: the owner ended it, and that decision is the more
        informative one.
        """
        if self.redeemed_at is not None:
            return "redeemed"
        if self.revoked_at is not None:
            return "revoked"
        if self.is_expired():
            return "expired"
        return "pending"

    @staticmethod
    def now() -> datetime:
        return datetime.now(timezone.utc)
