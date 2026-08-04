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
from app.models import Group, GroupPlayer, Player
from app.schemas.group import GroupCreateSchema, GroupPlayersUpsertSchema, GroupUpdateSchema
from app.schemas.player import GroupMembersAddSchema
from app.services.csv_roster import parse_roster_csv
from app.services.player_names import normalize_and_validate_names
from app.utils.auth import current_coach, get_org_group, get_org_player
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
        Group.query.filter_by(organization_id=coach.organization_id)
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

    group = Group(organization_id=coach.organization_id, coach_id=coach.id, name=data["name"])
    db.session.add(group)
    db.session.commit()
    return jsonify(group.to_dict()), 201


@groups_bp.get("/<int:group_id>")
@jwt_required()
def get_group(group_id: int):
    group = get_org_group(group_id)
    return jsonify(group.to_dict())


@groups_bp.patch("/<int:group_id>")
@jwt_required()
def rename_group(group_id: int):
    group = get_org_group(group_id)
    data = load_json_body(GroupUpdateSchema())

    group.name = data["name"]
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.put("/<int:group_id>/players")
@jwt_required()
def set_group_players(group_id: int):
    group = get_org_group(group_id)
    data = load_json_body(GroupPlayersUpsertSchema())

    _replace_group_players(group, data["players"])
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.post("/<int:group_id>/players/csv")
@jwt_required()
def upload_group_players_csv(group_id: int):
    group = get_org_group(group_id)

    if "file" not in request.files:
        raise ApiError("No CSV file provided under the 'file' field", status_code=400)

    names = parse_roster_csv(request.files["file"].read())
    _replace_group_players(group, names)
    db.session.commit()
    return jsonify(group.to_dict())


@groups_bp.delete("/<int:group_id>")
@jwt_required()
def delete_group(group_id: int):
    group = get_org_group(group_id)
    db.session.delete(group)
    db.session.commit()
    return "", 204


@groups_bp.post("/<int:group_id>/members")
@jwt_required()
def add_group_members(group_id: int):
    """Adds canonical master-roster Players to a group by id - the
    replacement path for the master-roster era, alongside (not instead of)
    `set_group_players`'s legacy whole-list-of-names replace. Idempotent:
    a player_id already a member is silently skipped rather than erroring,
    so a coach re-selecting an already-added player from the roster picker
    doesn't need special-case handling on the frontend.
    """
    coach = current_coach()
    group = get_org_group(group_id)
    data = load_json_body(GroupMembersAddSchema())

    # Validate every id up front, all-or-nothing: a request naming even one
    # player from another organization (or a nonexistent id) is rejected
    # entirely rather than silently adding the valid subset - the client
    # sent a request it believes is fully valid, and partial success would
    # hide the bug that produced the bad id.
    requested_ids = set(data["player_ids"])
    players = Player.query.filter(
        Player.id.in_(requested_ids), Player.organization_id == coach.organization_id
    ).all()
    if len(players) != len(requested_ids):
        raise ApiError("One or more selected players were not found", status_code=404)

    existing_player_ids = {gp.player_id for gp in group.players if gp.player_id is not None}
    next_position = max((gp.position for gp in group.players), default=-1) + 1

    for player in players:
        if player.id in existing_player_ids:
            continue
        group.players.append(
            GroupPlayer(player_id=player.id, player_name=player.full_name, position=next_position)
        )
        next_position += 1

    db.session.commit()
    return jsonify(group.to_dict()), 201


@groups_bp.delete("/<int:group_id>/members/<int:player_id>")
@jwt_required()
def remove_group_member(group_id: int, player_id: int):
    """Removes one canonical membership row. The Player record itself, and
    every attempt/answer/score already linked to their player_id, are
    untouched - this only affects future group-restricted activations
    linked to this group."""
    group = get_org_group(group_id)
    get_org_player(player_id)  # 404s if the player isn't this coach's org

    membership = next((gp for gp in group.players if gp.player_id == player_id), None)
    if membership is None:
        raise ApiError("Player is not a member of this group", status_code=404)

    db.session.delete(membership)
    db.session.commit()
    return "", 204
