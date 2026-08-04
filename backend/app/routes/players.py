"""Master-roster Player CRUD: one canonical, durable record per real
person in an organization, independent of any name string used elsewhere
(Group/Roster entries, PlayerAttempt.player_name - see those models'
docstrings for the dual-read/dual-write transition).

Org-shared, same tenancy rule as Group/Folder: any coach in the
organization may view or edit any player it owns (see get_org_player).
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Player
from app.schemas.player import PlayerBulkCreateSchema, PlayerCreateSchema, PlayerUpdateSchema
from app.utils.auth import current_coach, get_org_player
from app.utils.validation import load_json_body

players_bp = Blueprint("players", __name__)


def _apply_fields(player: Player, data: dict) -> None:
    player.first_name = data["first_name"].strip()
    player.last_name = data["last_name"].strip()
    player.jersey_number = (data.get("jersey_number") or "").strip() or None
    player.position = (data.get("position") or "").strip() or None
    player.photo_url = (data.get("photo_url") or "").strip() or None


@players_bp.get("")
@jwt_required()
def list_players():
    coach = current_coach()
    query = Player.query.filter_by(organization_id=coach.organization_id)

    active_param = request.args.get("active", "true").lower()
    if active_param == "true":
        query = query.filter_by(is_active=True)
    elif active_param == "false":
        query = query.filter_by(is_active=False)
    # any other value (e.g. "all") returns both

    position = request.args.get("position", "").strip()
    if position:
        query = query.filter(Player.position == position)

    search = request.args.get("q", "").strip()
    if search:
        like = f"%{search.lower()}%"
        query = query.filter(
            db.or_(
                db.func.lower(Player.first_name).like(like),
                db.func.lower(Player.last_name).like(like),
                db.func.lower(db.func.concat(Player.first_name, " ", Player.last_name)).like(like),
            )
        )

    players = query.order_by(Player.last_name, Player.first_name).all()
    return jsonify([p.to_dict() for p in players])


@players_bp.post("")
@jwt_required()
def create_player():
    coach = current_coach()
    data = load_json_body(PlayerCreateSchema())

    player = Player(organization_id=coach.organization_id)
    _apply_fields(player, data)
    db.session.add(player)
    db.session.commit()
    return jsonify(player.to_dict()), 201


@players_bp.post("/bulk")
@jwt_required()
def bulk_create_players():
    coach = current_coach()
    data = load_json_body(PlayerBulkCreateSchema())

    created = []
    for row in data["players"]:
        player = Player(organization_id=coach.organization_id)
        _apply_fields(player, row)
        db.session.add(player)
        created.append(player)

    db.session.commit()
    return jsonify([p.to_dict() for p in created]), 201


@players_bp.get("/<int:player_id>")
@jwt_required()
def get_player(player_id: int):
    player = get_org_player(player_id)
    return jsonify(player.to_dict())


@players_bp.patch("/<int:player_id>")
@jwt_required()
def update_player(player_id: int):
    player = get_org_player(player_id)
    data = load_json_body(PlayerUpdateSchema())

    _apply_fields(player, data)
    db.session.commit()
    return jsonify(player.to_dict())


@players_bp.post("/<int:player_id>/deactivate")
@jwt_required()
def deactivate_player(player_id: int):
    """Preserves the player everywhere - group membership, attempts,
    answers, history - and just removes them from active-selection lists
    (master roster default filter, group-add pickers). Never a delete: a
    player with any history must never be permanently removed."""
    player = get_org_player(player_id)
    player.is_active = False
    db.session.commit()
    return jsonify(player.to_dict())


@players_bp.post("/<int:player_id>/reactivate")
@jwt_required()
def reactivate_player(player_id: int):
    player = get_org_player(player_id)
    player.is_active = True
    db.session.commit()
    return jsonify(player.to_dict())


@players_bp.delete("/<int:player_id>")
@jwt_required()
def delete_player(player_id: int):
    """Hard delete - only safe for a player with zero history. Guarded here
    rather than left to a FK constraint failure, so the coach gets a clear
    reason instead of a raw 500."""
    from app.models import PlayerAttempt

    player = get_org_player(player_id)
    has_attempts = PlayerAttempt.query.filter_by(player_id=player.id).first() is not None
    if has_attempts:
        raise ApiError(
            "This player has quiz history and cannot be deleted - deactivate instead",
            status_code=422,
        )

    db.session.delete(player)
    db.session.commit()
    return "", 204
