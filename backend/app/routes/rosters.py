"""Roster management: manual entry or CSV upload. One roster per quiz."""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Quiz, Roster, RosterPlayer
from app.schemas.roster import RosterUpsertSchema
from app.services.csv_roster import parse_roster_csv
from app.utils.auth import get_owned_quiz
from app.utils.validation import load_json_body

rosters_bp = Blueprint("rosters", __name__)


def _replace_roster(quiz: Quiz, raw_names: list[str]) -> Roster:
    """Normalizes whitespace and rejects duplicate names (case-insensitive).

    A duplicate isn't silently deduped: two roster entries for the same name
    would let a player validate but then collide with the unique-per-player
    constraint at submit time, and would also make two genuinely different
    people with the same name unable to both take the quiz. Better to make
    the coach fix the roster (e.g. "Jordan Smith / Jordan Smith Jr.") than
    to silently drop one.
    """
    names = [name.strip() for name in raw_names]
    names = [name for name in names if name]
    if not names:
        raise ApiError("Roster must have at least one player name", status_code=422)

    seen_lower: set[str] = set()
    for name in names:
        lowered = name.lower()
        if lowered in seen_lower:
            raise ApiError(f'Duplicate player name: "{name}"', status_code=422)
        seen_lower.add(lowered)

    if quiz.roster is None:
        quiz.roster = Roster(quiz_id=quiz.id)

    quiz.roster.players.clear()
    for index, name in enumerate(names):
        quiz.roster.players.append(RosterPlayer(player_name=name, position=index))

    return quiz.roster


@rosters_bp.get("/<int:quiz_id>/roster")
@jwt_required()
def get_roster(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    if quiz.roster is None:
        return jsonify({"id": None, "quiz_id": quiz.id, "players": []})
    return jsonify(quiz.roster.to_dict())


@rosters_bp.put("/<int:quiz_id>/roster")
@jwt_required()
def upsert_roster(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    data = load_json_body(RosterUpsertSchema())

    roster = _replace_roster(quiz, data["players"])
    db.session.commit()
    return jsonify(roster.to_dict())


@rosters_bp.post("/<int:quiz_id>/roster/csv")
@jwt_required()
def upload_roster_csv(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)

    if "file" not in request.files:
        raise ApiError("No CSV file provided under the 'file' field", status_code=400)

    names = parse_roster_csv(request.files["file"].read())
    roster = _replace_roster(quiz, names)
    db.session.commit()
    return jsonify(roster.to_dict())
