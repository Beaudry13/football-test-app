"""Coach registration and login."""

from flask import Blueprint, jsonify
from flask_jwt_extended import create_access_token, jwt_required
from sqlalchemy import or_

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import Coach
from app.schemas.auth import LoginSchema, RegisterSchema
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/register")
@limiter.limit("10 per hour")
def register():
    data = load_json_body(RegisterSchema())

    existing = Coach.query.filter(
        or_(Coach.username == data["username"], Coach.email == data["email"])
    ).first()
    if existing is not None:
        raise ApiError("Username or email is already taken", status_code=409)

    coach = Coach(
        username=data["username"],
        email=data["email"],
        organization=data["organization"],
    )
    coach.set_password(data["password"])

    db.session.add(coach)
    db.session.commit()

    token = create_access_token(identity=str(coach.id))
    return jsonify({"coach": coach.to_dict(), "access_token": token}), 201


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
