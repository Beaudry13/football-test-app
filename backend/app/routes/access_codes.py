"""Coach-facing access code activation and history.

Player-facing code validation lives in routes/play.py since it's a public,
unauthenticated endpoint.
"""

from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import AccessCode
from app.services.access_codes import generate_unique_code
from app.utils.auth import get_owned_quiz

access_codes_bp = Blueprint("access_codes", __name__)


@access_codes_bp.get("/<int:quiz_id>/access-codes")
@jwt_required()
def list_access_codes(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    return jsonify([code.to_dict() for code in quiz.access_codes])


@access_codes_bp.post("/<int:quiz_id>/access-codes")
@jwt_required()
def activate_quiz(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)

    if not quiz.questions:
        raise ApiError("Cannot activate a quiz with no questions", status_code=422)
    if quiz.roster is None or not quiz.roster.players:
        raise ApiError("Cannot activate a quiz with no roster", status_code=422)

    # Only one code should be usable to join at a time; retire any still-active ones.
    for existing_code in quiz.access_codes:
        if existing_code.is_active:
            existing_code.is_active = False

    ttl_hours = current_app.config["ACCESS_CODE_TTL_HOURS"]
    access_code = AccessCode(
        quiz_id=quiz.id,
        code=generate_unique_code(),
        activated_at=datetime.now(timezone.utc),
        expires_at=AccessCode.default_expiry(ttl_hours),
        is_active=True,
    )
    db.session.add(access_code)
    db.session.commit()
    return jsonify(access_code.to_dict()), 201


@access_codes_bp.post("/<int:quiz_id>/access-codes/<int:access_code_id>/deactivate")
@jwt_required()
def deactivate_access_code(quiz_id: int, access_code_id: int):
    quiz = get_owned_quiz(quiz_id)
    access_code = AccessCode.query.filter_by(id=access_code_id, quiz_id=quiz.id).first()
    if access_code is None:
        raise ApiError("Access code not found", status_code=404)

    access_code.is_active = False
    db.session.commit()
    return jsonify(access_code.to_dict())
