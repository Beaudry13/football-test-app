"""Roster management: manual entry or CSV upload. One roster per quiz."""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Player, Quiz, Roster, RosterPlayer
from app.schemas.player import GroupMembersAddSchema
from app.schemas.roster import RosterUpsertSchema
from app.services.csv_roster import parse_roster_csv
from app.services.player_names import normalize_and_validate_names
from app.utils.auth import current_coach, get_editable_quiz, get_org_player, get_visible_quiz
from app.utils.validation import load_json_body

rosters_bp = Blueprint("rosters", __name__)


def _replace_roster(quiz: Quiz, raw_names: list[str]) -> Roster:
    """Replaces only the legacy (player_id IS NULL) name rows - see
    groups.py::_replace_group_players for why canonical rows must survive
    this whole-list legacy editor's clear-and-rebuild.
    """
    names = normalize_and_validate_names(raw_names)

    if quiz.roster is None:
        quiz.roster = Roster(quiz_id=quiz.id)

    for rp in [rp for rp in quiz.roster.players if rp.player_id is None]:
        quiz.roster.players.remove(rp)

    next_position = max((rp.position for rp in quiz.roster.players), default=-1) + 1
    for name in names:
        quiz.roster.players.append(RosterPlayer(player_name=name, position=next_position))
        next_position += 1

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


@rosters_bp.post("/<int:quiz_id>/roster/members")
@jwt_required()
def add_roster_members(quiz_id: int):
    """Adds canonical master-roster Players directly to a quiz's Roster -
    the direct-roster equivalent of groups.py's add_group_members. Same
    idempotent-skip and all-or-nothing-validation behavior; see that
    route's docstring."""
    coach = current_coach()
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(GroupMembersAddSchema())

    requested_ids = set(data["player_ids"])
    players = Player.query.filter(
        Player.id.in_(requested_ids), Player.organization_id == coach.organization_id
    ).all()
    if len(players) != len(requested_ids):
        raise ApiError("One or more selected players were not found", status_code=404)

    if quiz.roster is None:
        quiz.roster = Roster(quiz_id=quiz.id)

    existing_player_ids = {rp.player_id for rp in quiz.roster.players if rp.player_id is not None}
    next_position = max((rp.position for rp in quiz.roster.players), default=-1) + 1

    for player in players:
        if player.id in existing_player_ids:
            continue
        quiz.roster.players.append(
            RosterPlayer(player_id=player.id, player_name=player.full_name, position=next_position)
        )
        next_position += 1

    db.session.commit()
    return jsonify(quiz.roster.to_dict()), 201


@rosters_bp.delete("/<int:quiz_id>/roster/members/<int:player_id>")
@jwt_required()
def remove_roster_member(quiz_id: int, player_id: int):
    quiz = get_editable_quiz(quiz_id)
    get_org_player(player_id)

    membership = None
    if quiz.roster is not None:
        membership = next((rp for rp in quiz.roster.players if rp.player_id == player_id), None)
    if membership is None:
        raise ApiError("Player is not on this quiz's roster", status_code=404)

    db.session.delete(membership)
    db.session.commit()
    return "", 204
