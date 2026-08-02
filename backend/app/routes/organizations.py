"""Organization membership and invitations.

Every route resolves the organization from the authenticated coach rather
than from a URL parameter - there is no way to name another organization in
a request, so there's nothing to authorize against and nothing to leak.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Coach, CoachRole, OrganizationInvite
from app.schemas.organization import MemberRoleUpdateSchema, OrganizationUpdateSchema
from app.services.invites import INVITE_TTL_DAYS, generate_invite_code
from app.utils.auth import current_coach, require_admin
from app.utils.validation import load_json_body

organizations_bp = Blueprint("organizations", __name__)


def _member_dict(coach: Coach) -> dict:
    return {
        "id": coach.id,
        "username": coach.username,
        "email": coach.email,
        "role": coach.role.value,
    }


def _admin_count(organization_id: int) -> int:
    return Coach.query.filter_by(organization_id=organization_id, role=CoachRole.ADMIN).count()


def _get_org_member(coach_id: int, organization_id: int) -> Coach:
    member = Coach.query.filter_by(id=coach_id, organization_id=organization_id).first()
    if member is None:
        raise ApiError("Member not found", status_code=404)
    return member


@organizations_bp.get("")
@jwt_required()
def get_organization():
    coach = current_coach()
    members = (
        Coach.query.filter_by(organization_id=coach.organization_id)
        .order_by(Coach.username)
        .all()
    )
    return jsonify(
        {
            **coach.organization.to_dict(),
            "members": [_member_dict(m) for m in members],
        }
    )


@organizations_bp.patch("")
@jwt_required()
def rename_organization():
    coach = require_admin()
    data = load_json_body(OrganizationUpdateSchema())

    coach.organization.name = data["name"]
    db.session.commit()
    return jsonify(coach.organization.to_dict())


@organizations_bp.get("/invites")
@jwt_required()
def list_invites():
    coach = require_admin()
    invites = (
        OrganizationInvite.query.filter_by(organization_id=coach.organization_id)
        .order_by(OrganizationInvite.created_at.desc())
        .all()
    )
    # Codes are omitted from the list: an invite link is shown once, when it's
    # created. Re-reading a code later isn't needed and widens where a live
    # credential can be observed.
    return jsonify([i.to_dict() for i in invites])


@organizations_bp.post("/invites")
@jwt_required()
def create_invite():
    coach = require_admin()

    invite = OrganizationInvite(
        organization_id=coach.organization_id,
        code=generate_invite_code(),
        created_by_coach_id=coach.id,
        created_at=datetime.now(timezone.utc),
        expires_at=OrganizationInvite.default_expiry(INVITE_TTL_DAYS),
        is_revoked=False,
    )
    db.session.add(invite)
    db.session.commit()

    # The only response that carries the code - the client shows it as a
    # copyable join link immediately.
    return jsonify(invite.to_dict(include_code=True)), 201


@organizations_bp.delete("/invites/<int:invite_id>")
@jwt_required()
def revoke_invite(invite_id: int):
    coach = require_admin()
    invite = OrganizationInvite.query.filter_by(
        id=invite_id, organization_id=coach.organization_id
    ).first()
    if invite is None:
        raise ApiError("Invite not found", status_code=404)

    invite.is_revoked = True
    db.session.commit()
    return "", 204


@organizations_bp.patch("/members/<int:coach_id>")
@jwt_required()
def update_member_role(coach_id: int):
    admin = require_admin()
    data = load_json_body(MemberRoleUpdateSchema())
    member = _get_org_member(coach_id, admin.organization_id)

    new_role = CoachRole(data["role"])
    # Demoting the last admin would leave the org unable to invite, promote,
    # or manage anyone ever again.
    if (
        member.role == CoachRole.ADMIN
        and new_role == CoachRole.MEMBER
        and _admin_count(admin.organization_id) <= 1
    ):
        raise ApiError("An organization must keep at least one admin", status_code=422)

    member.role = new_role
    db.session.commit()
    return jsonify(_member_dict(member))


@organizations_bp.delete("/members/<int:coach_id>")
@jwt_required()
def remove_member(coach_id: int):
    admin = require_admin()
    member = _get_org_member(coach_id, admin.organization_id)

    if member.id == admin.id:
        raise ApiError("You cannot remove yourself from the organization", status_code=422)
    if member.role == CoachRole.ADMIN and _admin_count(admin.organization_id) <= 1:
        raise ApiError("An organization must keep at least one admin", status_code=422)

    # Quizzes, folders, and groups this coach created stay with the
    # organization; their coach_id is nulled by the FK's ON DELETE SET NULL.
    db.session.delete(member)
    db.session.commit()
    return "", 204
