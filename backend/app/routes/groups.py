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
from app.services.player_matching import resolve_or_create_players
from app.services.player_names import normalize_and_validate_names
from app.utils.auth import current_coach, get_org_group, get_org_player
from app.utils.validation import load_json_body

groups_bp = Blueprint("groups", __name__)


def _add_canonical_group_members(group: Group, players: list) -> Group:
    """Adds canonical Players to a group, skipping anyone already in it.

    Additive, like add_group_members - NOT the legacy editor's clear-and-
    rebuild. A CSV upload says "these players are in this group", and
    dropping members who happen not to be in the file would be a destructive
    reading of an additive action.
    """
    existing = {gp.player_id for gp in group.players if gp.player_id is not None}
    next_position = max((gp.position for gp in group.players), default=-1) + 1

    for player in players:
        if player.id in existing:
            continue
        existing.add(player.id)
        group.players.append(
            GroupPlayer(
                player_id=player.id,
                # Display snapshot, exactly as add_group_members stores it -
                # Player.full_name stays the live value.
                player_name=player.full_name,
                position=next_position,
            )
        )
        next_position += 1

    return group


def _replace_group_players(group: Group, raw_names: list[str]) -> Group:
    """Replaces only the legacy (player_id IS NULL) name rows. Canonical
    master-roster memberships - added via add_group_members, below - are
    managed exclusively through their own add/remove endpoints and must
    survive a save from this whole-list legacy editor, so they're excluded
    from the clear-and-rebuild rather than wiped by it.
    """
    names = normalize_and_validate_names(raw_names)

    for gp in [gp for gp in group.players if gp.player_id is None]:
        group.players.remove(gp)

    next_position = max((gp.position for gp in group.players), default=-1) + 1
    for name in names:
        group.players.append(GroupPlayer(player_name=name, position=next_position))
        next_position += 1

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

    names = normalize_and_validate_names(parse_roster_csv(request.files["file"].read()))
    # Duplicate rows are still rejected before anything resolves. Two rows
    # for one name usually mean two different people, and collapsing them to
    # one canonical Player would silently drop somebody - see
    # services/player_names for the original reasoning, which canonical
    # linking does not change.
    # Canonical, not name-only. A CSV upload looks like an ordinary bulk
    # action to a coach, but it used to create GroupPlayer rows with no
    # player_id - and every attempt made through them was invisible to the
    # player profile and the cumulative report. Names now resolve to master
    # roster Players (creating any the roster lacks, refusing on an ambiguous
    # name) so participation is attributable.
    coach = current_coach()
    players = resolve_or_create_players(coach.organization_id, names)
    _add_canonical_group_members(group, players)
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
