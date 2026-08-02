"""Coach registration and login.

Two registration paths: `/register` starts a brand-new organization with the
registering coach as its admin, and `/register-with-invite` joins an existing
one as a member. There is no way to join an organization without a valid
invite - that's the tenancy boundary.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify
from flask_jwt_extended import create_access_token, jwt_required
from sqlalchemy import or_

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import Coach, CoachRole, Organization
from app.schemas.auth import LoginSchema, RegisterSchema, RegisterWithInviteSchema
from app.services.invites import find_usable_invite
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

auth_bp = Blueprint("auth", __name__)

INVALID_INVITE = "That invitation link is invalid, expired, or has already been used"


def _reject_taken_identity(username: str, email: str) -> None:
    existing = Coach.query.filter(or_(Coach.username == username, Coach.email == email)).first()
    if existing is not None:
        raise ApiError("Username or email is already taken", status_code=409)


@auth_bp.post("/register")
@limiter.limit("10 per hour")
def register():
    data = load_json_body(RegisterSchema())
    _reject_taken_identity(data["username"], data["email"])

    organization = Organization(name=data["organization"])
    db.session.add(organization)
    db.session.flush()  # assign organization.id without committing

    coach = Coach(
        username=data["username"],
        email=data["email"],
        organization_id=organization.id,
        # Whoever creates the organization runs it, and a one-person org with
        # no admin would be unable to ever invite anyone.
        role=CoachRole.ADMIN,
    )
    coach.set_password(data["password"])

    db.session.add(coach)
    db.session.commit()

    token = create_access_token(identity=str(coach.id))
    return jsonify({"coach": coach.to_dict(), "access_token": token}), 201


@auth_bp.post("/register-with-invite")
@limiter.limit("10 per hour")
def register_with_invite():
    data = load_json_body(RegisterWithInviteSchema())

    invite = find_usable_invite(data["invite_code"])
    if invite is None:
        # One message for revoked / expired / already-accepted / nonexistent,
        # so a guessed code can't be probed for which of those it is.
        raise ApiError(INVALID_INVITE, status_code=404)

    _reject_taken_identity(data["username"], data["email"])

    coach = Coach(
        username=data["username"],
        email=data["email"],
        organization_id=invite.organization_id,
        role=CoachRole.MEMBER,
    )
    coach.set_password(data["password"])
    db.session.add(coach)
    db.session.flush()

    invite.accepted_at = datetime.now(timezone.utc)
    invite.accepted_by_coach_id = coach.id
    db.session.commit()

    token = create_access_token(identity=str(coach.id))
    return jsonify({"coach": coach.to_dict(), "access_token": token}), 201


@auth_bp.get("/invites/<invite_code>")
@limiter.limit("20 per minute")
def preview_invite(invite_code: str):
    """Unauthenticated: lets the join page show which organization the link
    is for before asking for a password. Exposes only the org name."""
    invite = find_usable_invite(invite_code)
    if invite is None:
        raise ApiError(INVALID_INVITE, status_code=404)
    return jsonify({"organization_name": invite.organization.name})


@auth_bp.post("/login")
@limiter.limit("10 per minute")
def login():
    data = load_json_body(LoginSchema())

    coach = Coach.query.filter_by(email=data["email"]).first()
    if coach is None or not coach.check_password(data["password"]):
        raise ApiError("Invalid email or password", status_code=401)

    token = create_access_token(identity=str(coach.id))
    return jsonify({"coach": coach.to_dict(), "access_token": token})


@auth_bp.get("/me")
@jwt_required()
def me():
    return jsonify(current_coach().to_dict())
