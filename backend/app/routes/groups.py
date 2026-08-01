"""Coach-scoped, reusable player groups: CRUD + player-list management.

Distinct from rosters.py (which manages a single quiz's own Roster) - a
Group is coach-wide and gets attached to specific access-code activations
(see routes/access_codes.py::activate_quiz), not to a quiz directly.
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db
from app.models import Group, GroupPlayer
from app.schemas.group import GroupCreateSchema, GroupPlayersUpsertSchema, GroupUpdateSchema
from app.services.csv_roster import parse_roster_csv
from app.services.player_names import normalize_and_validate_names
from app.utils.auth import current_coach, get_owned_group
from app.utils.validation import load_json_body

groups_bp = Blueprint("groups", __name__)


def _replace_group_players(group: Group, raw_names: list[str]) -> Group:
    names = normalize_and_validate_names(raw_names)

    group.players.clear()
    for index, name in enumerate(names):
        group.players.append(GroupPlayer(player_name=name, position=index))

    return group


@groups_bp.get("")
@jwt_required()
def list_groups():
    coach = current_coach()
    groups = (
        Group.query.filter_by(coach_id=coach.id)
        .options(selectinload(Group.players))
        .order_by(Group.name)
        .all()
    )
    return jsonify([g.to_dict() for g in groups])


@groups_bp.post("")
@jwt_required()
def create_group():
    coach = current_coach()
    data = load_json_body(GroupCreateSchema())

    group = Group(coach_id=coach.id, name=data["name"])
    db.session.add(group)
    db.session.commit()
    return jsonify(group.to_dict()), 201


@groups_bp.get("/<int:group_id>")
@jwt_required()
def get_group(group_id: int):
    group = get_owned_group(group_id)
    return jsonify(group.to_dict())


@groups_bp.patch("/<int:group_id>")
@jwt_required()
def rename_group(group_id: int):
    group = get_owned_group(group_id)
    data = load_json_body(GroupUpdateSchema())

    group.name = data["name"]
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.put("/<int:group_id>/players")
@jwt_required()
def set_group_players(group_id: int):
    group = get_owned_group(group_id)
    data = load_json_body(GroupPlayersUpsertSchema())

    _replace_group_players(group, data["players"])
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.post("/<int:group_id>/players/csv")
@jwt_required()
def upload_group_players_csv(group_id: int):
    group = get_owned_group(group_id)

    if "file" not in request.files:
        raise ApiError("No CSV file provided under the 'file' field", status_code=400)

    names = parse_roster_csv(request.files["file"].read())
    _replace_group_players(group, names)
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.delete("/<int:group_id>")
@jwt_required()
def delete_group(group_id: int):
    group = get_owned_group(group_id)
    db.session.delete(group)
    db.session.commit()
    return "", 204
