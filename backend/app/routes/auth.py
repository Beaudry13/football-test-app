"""Coach registration and login.

Two registration paths: `/register` starts a brand-new organization with the
registering coach as its admin, and `/register-with-invite` joins an existing
one as a member. There is no way to join an organization without a valid
invite - that's the tenancy boundary.
"""


from flask import Blueprint, jsonify
from flask_jwt_extended import create_access_token, jwt_required
from sqlalchemy import or_

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import Coach, CoachRole, Organization
from app.schemas.auth import (
    LoginSchema,
    RegisterSchema,
    RegisterWithBetaInviteSchema,
    RegisterWithInviteSchema,
)
from app.services import beta_invites
from app.services.invites import claim, find_usable_invite
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

auth_bp = Blueprint("auth", __name__)

INVALID_INVITE = "That invitation link is invalid, expired, or has already been used"


def _reject_taken_identity(username: str, email: str) -> None:
    existing = Coach.query.filter(or_(Coach.username == username, Coach.email == email)).first()
    if existing is not None:
        raise ApiError("Username or email is already taken", status_code=409)


def _start_a_program(data: dict) -> Coach:
    """Create an organization and the coach who runs it, uncommitted.

    Shared by open registration and beta-invite registration, which differ
    only in what has to be true BEFORE this runs and what has to succeed
    after. Keeping the account shape in one place is what stops the two paths
    drifting into "a coach who signed up one way is subtly different".
    """
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
    db.session.flush()
    return coach


@auth_bp.post("/register")
@limiter.limit("10 per hour")
def register():
    data = load_json_body(RegisterSchema())
    _reject_taken_identity(data["username"], data["email"])

    coach = _start_a_program(data)
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

    # CLAIMED BY CONDITIONAL UPDATE, and the rollback below is half the fix.
    #
    # Assigning `accepted_at` here used to be a plain write after the read
    # above, so two people opening the same link could both pass
    # `find_usable_invite` and both get an account in the organization - a
    # single-use invitation admitting two people to a program's data.
    #
    # Losing means the invite was taken between the read and now, so the coach
    # created a moment ago must not survive: the rollback discards it and the
    # caller is told the same generic thing every other failure says.
    if not claim(invite, coach.id):
        db.session.rollback()
        raise ApiError(INVALID_INVITE, status_code=404)

    db.session.commit()

    token = create_access_token(identity=str(coach.id))
    return jsonify({"coach": coach.to_dict(), "access_token": token}), 201


@auth_bp.post("/register-with-beta-invite")
@limiter.limit("10 per hour")
def register_with_beta_invite():
    """Create an account, and a program to run, from a Peira invite.

    THE OTHER INVITE TYPE IS NOT THIS ONE. `/register-with-invite` above adds a
    coach to an organization that already exists, as a MEMBER, and takes no
    organization name because the invite supplies it. This one creates the
    organization and makes the redeemer its ADMIN, so the name is asked for.
    Two endpoints rather than one flag, because confusing them would put a
    stranger inside somebody else's program.

    IDENTITY IS CHECKED BEFORE THE INVITE IS SPENT. A coach who mistypes an
    email that is already taken gets a 409 and STILL HAS THEIR INVITE - it is
    single use, and burning one on a typo would mean asking the owner for
    another.
    """
    data = load_json_body(RegisterWithBetaInviteSchema())

    invite = beta_invites.find_usable(data["invite_code"])
    if invite is None:
        # One message for unknown / revoked / already-redeemed, so a guessed
        # token cannot be probed for which invites exist.
        raise ApiError(beta_invites.INVALID_INVITE, status_code=404)

    _reject_taken_identity(data["username"], data["email"])

    coach = _start_a_program(data)

    # REDEEMED BY CONDITIONAL UPDATE, and the rollback is half of it. Losing
    # means somebody else spent this invite between the lookup above and here,
    # so the organization and coach just built must not survive - otherwise a
    # program would exist that no invitation paid for. Same rule as
    # organization invites; see services/invites.claim.
    if not beta_invites.redeem(invite, coach.id):
        db.session.rollback()
        raise ApiError(beta_invites.INVALID_INVITE, status_code=404)

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
