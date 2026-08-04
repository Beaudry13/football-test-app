"""Master-roster Player CRUD: one canonical, durable record per real
person in an organization, independent of any name string used elsewhere
(Group/Roster entries, PlayerAttempt.player_name - see those models'
docstrings for the dual-read/dual-write transition).

Org-shared, same tenancy rule as Group/Folder: any coach in the
organization may view or edit any player it owns (see get_org_player).
"""

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Player
from app.schemas.player import (
    ImportConfirmSchema,
    ImportPreviewSchema,
    PlayerBulkCreateSchema,
    PlayerCreateSchema,
    PlayerUpdateSchema,
)
from app.services.file_storage import get_file_storage
from app.services.player_analytics import (
    compute_comparisons,
    compute_missed_questions,
    compute_org_roster,
    compute_player_analytics,
)
from app.services.roster_import import apply_import, build_preview
from app.utils.auth import current_coach, get_org_player
from app.utils.validation import load_json_body

players_bp = Blueprint("players", __name__)


def _apply_fields(player: Player, data: dict) -> None:
    player.first_name = data["first_name"].strip()
    player.last_name = data["last_name"].strip()
    player.jersey_number = (data.get("jersey_number") or "").strip() or None
    player.position = (data.get("position") or "").strip() or None


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


@players_bp.get("/progress")
@jwt_required()
def player_progress():
    """Organization-wide Player Progress: one batched, N+1-free pass (see
    services/player_analytics.py::compute_org_roster) over every Player's
    assigned/completed/average/trend/last-activity, plus the summary stats
    the Player Progress page's header shows. Search/position/Group/Needs
    Review filtering and sorting all happen client-side against this one
    response - the org's own roster size (dozens to a few hundred Players)
    doesn't warrant per-filter server round-trips, and every row already
    carries what the frontend needs to filter/sort on.

    active=true (default) matches the Master Roster's own default - a
    coach explicitly opts into seeing inactive Players via active=all,
    same query-parameter convention as GET /players.
    """
    coach = current_coach()
    active_param = request.args.get("active", "true").lower()
    include_inactive = active_param in ("all", "false")
    if active_param == "false":
        # Inactive-only isn't a real Player Progress use case (there's
        # nothing to triage for someone no longer playing), but honor the
        # same three-value convention as GET /players rather than silently
        # reinterpreting it - compute_org_roster's include_inactive just
        # widens the pool to active+inactive; filtering to inactive-only
        # from there is a one-line trim, not worth a second code path.
        result = compute_org_roster(coach.organization_id, include_inactive=True)
        result["players"] = [row for row in result["players"] if not row["player"]["is_active"]]
        return jsonify(result)

    return jsonify(compute_org_roster(coach.organization_id, include_inactive=include_inactive))


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


@players_bp.get("/<int:player_id>/history")
@jwt_required()
def get_player_history(player_id: int):
    """Player Progress Analytics for one canonical Player: unified summary,
    full chronological history, score trend, evidence-based missed-question
    review, and Group/position/organization comparisons - all delegated to
    services/player_analytics.py so this page can never disagree with the
    quiz dashboard, the org-wide Player Progress page, or any other
    analytics surface about what "assigned," "completed," or "average
    score" mean. See that module's docstring for the exact definitions.
    """
    player = get_org_player(player_id)

    analytics = compute_player_analytics(player)
    missed_questions = compute_missed_questions(player)
    comparisons = compute_comparisons(player)

    return jsonify(
        {
            "player": player.to_dict(),
            "summary": analytics["summary"],
            "history": analytics["history"],
            "trend": analytics["trend"],
            "missed_questions": missed_questions,
            "comparisons": comparisons,
        }
    )


@players_bp.patch("/<int:player_id>")
@jwt_required()
def update_player(player_id: int):
    player = get_org_player(player_id)
    data = load_json_body(PlayerUpdateSchema())

    _apply_fields(player, data)
    db.session.commit()
    return jsonify(player.to_dict())


@players_bp.post("/<int:player_id>/photo")
@jwt_required()
def upload_player_photo(player_id: int):
    """Adds or replaces this Player's photo. Mirrors questions.py's
    upload_question_image (delete-old-then-save-new, same FileStorage
    abstraction), which already validates actual image content, enforces
    the format allowlist, and generates a non-guessable stored filename -
    nothing extra to enforce here. get_org_player's 404-not-403 rule keeps
    this cross-org-safe. Photo identity is separate from Player identity:
    replacing or clearing it never touches history or attempts."""
    player = get_org_player(player_id)

    if "photo" not in request.files:
        raise ApiError("No image file provided under the 'photo' field", status_code=400)

    storage = get_file_storage()
    if player.photo_url:
        storage.delete_image(player.photo_url)

    player.photo_url = storage.save_image(request.files["photo"])
    db.session.commit()
    return jsonify(player.to_dict()), 201


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


IMPORT_TEMPLATE_CSV = (
    "First Name,Last Name,Jersey Number,Position\r\n"
    "Jordan,Example,12,WR\r\n"
    "Alex,Sample,7,DB\r\n"
)


@players_bp.get("/import/template.csv")
@jwt_required()
def import_template():
    """A starting-point CSV a coach can open in Excel/Sheets, fill in, and
    re-upload. The two example rows are just illustrative - they aren't
    treated specially by the importer, so if a coach genuinely rosters a
    "Jordan Example" it would just import as a real row like any other."""
    return Response(
        IMPORT_TEMPLATE_CSV,
        mimetype="text/csv",
        headers={"Content-Disposition": 'attachment; filename="peira-roster-template.csv"'},
    )


@players_bp.post("/import/preview")
@jwt_required()
def import_preview():
    """Parses and validates only - never writes to the database. See
    services/roster_import.py::build_preview."""
    coach = current_coach()
    data = load_json_body(ImportPreviewSchema())

    meta, rows = build_preview(data["raw_text"], coach.organization_id, data.get("column_mapping"))
    if "error" in meta:
        raise ApiError(meta["error"], status_code=422)

    return jsonify({**meta, "rows": rows})


@players_bp.post("/import/confirm")
@jwt_required()
def import_confirm():
    """Creates/updates Players from a coach-reviewed, coach-corrected
    preview. All-or-nothing in one transaction - see
    services/roster_import.py::apply_import for why."""
    coach = current_coach()
    data = load_json_body(ImportConfirmSchema())

    result = apply_import(data["rows"], coach.organization_id)
    if not result["success"]:
        # Row-level errors (list, keyed by row index), not the field-keyed
        # shape ApiError.details assumes - returned as the response body
        # directly instead, so the frontend gets exactly which rows failed
        # and why, in the same shape apply_import already produced.
        return jsonify({"error": "Import failed validation - nothing was created", **result}), 422

    return jsonify(result), 201


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
