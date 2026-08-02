"""Roster management: manual entry or CSV upload. One roster per quiz."""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Quiz, Roster, RosterPlayer
from app.schemas.roster import RosterUpsertSchema
from app.services.csv_roster import parse_roster_csv
from app.services.player_names import normalize_and_validate_names
from app.utils.auth import get_editable_quiz, get_visible_quiz
from app.utils.validation import load_json_body

rosters_bp = Blueprint("rosters", __name__)


def _replace_roster(quiz: Quiz, raw_names: list[str]) -> Roster:
    names = normalize_and_validate_names(raw_names)

    if quiz.roster is None:
        quiz.roster = Roster(quiz_id=quiz.id)

    quiz.roster.players.clear()
    for index, name in enumerate(names):
        quiz.roster.players.append(RosterPlayer(player_name=name, position=index))

    return quiz.roster


@rosters_bp.get("/<int:quiz_id>/roster")
@jwt_required()
def get_roster(quiz_id: int):
    # Read-only: visible to the whole org, like the quiz it belongs to.
    quiz = get_visible_quiz(quiz_id)
    if quiz.roster is None:
        return jsonify({"id": None, "quiz_id": quiz.id, "players": []})
    return jsonify(quiz.roster.to_dict())


@rosters_bp.put("/<int:quiz_id>/roster")
@jwt_required()
def upsert_roster(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(RosterUpsertSchema())

    roster = _replace_roster(quiz, data["players"])
    db.session.commit()
    return jsonify(roster.to_dict())


@rosters_bp.post("/<int:quiz_id>/roster/csv")
@jwt_required()
def upload_roster_csv(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)

    if "file" not in request.files:
        raise ApiError("No CSV file provided under the 'file' field", status_code=400)

    names = parse_roster_csv(request.files["file"].read())
    roster = _replace_roster(quiz, names)
    db.session.commit()
    return jsonify(roster.to_dict())
