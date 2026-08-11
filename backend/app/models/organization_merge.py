"""Permanent record of every organization merge.

WHY THE SOURCE IS SNAPSHOTTED, NOT REFERENCED
----------------------------------------------
A merge DELETES the source organization, so a foreign key to it could not
survive the very operation this row exists to describe. `source_organization_id`
is kept as a plain integer for historical correlation and the NAME is copied,
because six months later "which organization was absorbed into this one" must
still be answerable from this table alone.

The same reasoning applies to `performed_by_email`: a coach can leave, and the
FK is ON DELETE SET NULL, so the address is snapshotted rather than joined.

APPEND-ONLY
-----------
Rows are never updated or deleted. `grade_audit_logs` set the precedent - an
administrative history that can be edited is not a history.
"""

from app.extensions import db
from app.models.mixins import utcnow


class OrganizationMerge(db.Model):
    __tablename__ = "organization_merges"

    id = db.Column(db.Integer, primary_key=True)

    # Deliberately NOT a foreign key - this organization no longer exists.
    source_organization_id = db.Column(db.Integer, nullable=False)
    source_organization_name = db.Column(db.String(255), nullable=False)

    # This one survives, so it can be a real reference.
    destination_organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )
    destination_organization_name = db.Column(db.String(255), nullable=False)

    performed_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )
    performed_by_email = db.Column(db.String(255), nullable=False)
    performed_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    #: The fingerprint the operator previewed and the execution re-verified.
    #: Stored so a later reader can tell WHICH state of the world was approved.
    fingerprint = db.Column(db.String(64), nullable=False)

    #: {table: rows_moved}
    counts_moved = db.Column(db.JSON, nullable=False, default=dict)
    #: [{coach_id, email, previous_role, new_role}] - the explicit decision
    #: taken for every source coach, which is the security-relevant part.
    coach_role_decisions = db.Column(db.JSON, nullable=False, default=list)
    invitations_revoked = db.Column(db.Integer, nullable=False, default=0)
    #: Warnings the operator was shown and acknowledged, kept verbatim so the
    #: record reflects what they actually agreed to rather than what the code
    #: would compute today.
    collision_warnings = db.Column(db.JSON, nullable=False, default=list)
    duplicate_player_warnings = db.Column(db.JSON, nullable=False, default=list)

    outcome = db.Column(db.String(32), nullable=False, default="SUCCESS")
    notes = db.Column(db.Text, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source_organization_id": self.source_organization_id,
            "source_organization_name": self.source_organization_name,
            "destination_organization_id": self.destination_organization_id,
            "destination_organization_name": self.destination_organization_name,
            "performed_by_coach_id": self.performed_by_coach_id,
            "performed_by_email": self.performed_by_email,
            "performed_at": self.performed_at.isoformat(),
            "fingerprint": self.fingerprint,
            "counts_moved": self.counts_moved,
            "coach_role_decisions": self.coach_role_decisions,
            "invitations_revoked": self.invitations_revoked,
            "collision_warnings": self.collision_warnings,
            "duplicate_player_warnings": self.duplicate_player_warnings,
            "outcome": self.outcome,
            "notes": self.notes,
        }
