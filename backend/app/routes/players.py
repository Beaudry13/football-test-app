"""Master-roster Player CRUD: one canonical, durable record per real
person in an organization, independent of any name string used elsewhere
(Group/Roster entries, PlayerAttempt.player_name - see those models'
docstrings for the dual-read/dual-write transition).

Org-shared, same tenancy rule as Group/Folder: any coach in the
organization may view or edit any player it owns (see get_org_player).
"""

from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models.question import MANUALLY_GRADED_TYPES
from app.models import Player
from app.schemas.player import (
    ImportConfirmSchema,
    ImportPreviewSchema,
    PlayerBulkCreateSchema,
    PlayerCreateSchema,
    PlayerUpdateSchema,
)
from app.services.export import build_cumulative_performance_pdf
from app.services.file_storage import get_file_storage
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
    """Coach View: scoped to quizzes this coach owns. See the organization
    -wide admin variant in routes/organizations.py.

    The one unified analytics standard for this Player's activity,
    linked entirely through PlayerAttempt.player_id - the same physical
    person's attempts across every Group they've ever belonged to (or a
    direct-roster assignment) all land here, regardless of which one they
    used to join a given quiz. Mirrors grading.py's player_history() /
    _build_dashboard_data() definitions exactly (submitted-only for
    completion/average, auto-graded answers only for score) so a coach
    never sees this page disagree with the quiz dashboard or the
    org-wide, name-based legacy history endpoint.
    """
    player = get_org_player(player_id)
    return jsonify(build_player_history(current_coach(), player, organization_wide=False))


def build_player_history(
    coach, player, organization_wide: bool, result_limit: int | None = 20
) -> dict:
    """Shared by the coach route above and the admin org-wide route, so the
    two scopes cannot drift into reporting different numbers for one player.

    `result_limit` caps only the per-quiz LIST; every total below is computed
    over all submitted attempts regardless. The cumulative performance PDF
    passes None because a report that silently stopped at the player's 20
    most recent quizzes would be wrong in a way nobody could see. The default
    keeps the two history endpoints returning exactly what they always have.
    """
    from app.models import Answer, AttemptStatus, Group, GroupPlayer, PlayerAttempt, Quiz

    scope = [PlayerAttempt.player_id == player.id]
    if not organization_wide:
        # Only quizzes this coach created. Without this a coach could read the
        # titles and scores of a teammate's quizzes from the player page,
        # which is the same leak the quiz list was closed against.
        scope.append(Quiz.coach_id == coach.id)

    attempts = (
        PlayerAttempt.query.join(Quiz)
        .filter(*scope)
        .options(
            db.joinedload(PlayerAttempt.quiz),
            db.selectinload(PlayerAttempt.answers).selectinload(Answer.question),
        )
        .order_by(PlayerAttempt.started_at.desc())
        .all()
    )

    assigned_count = len(attempts)
    submitted = [a for a in attempts if a.status == AttemptStatus.SUBMITTED]
    completed_count = len(submitted)
    completion_percent = round(100 * completed_count / assigned_count, 1) if assigned_count else None

    recent_results = []
    total_correct = 0
    total_graded = 0
    total_pending = 0
    for attempt in submitted:
        auto_graded = [a for a in attempt.answers if a.is_correct is not None]
        correct = sum(1 for a in auto_graded if a.is_correct)
        total_correct += correct
        total_graded += len(auto_graded)
        pending_grading = sum(
            1
            for a in attempt.answers
            if a.is_correct is None and a.question.question_type in MANUALLY_GRADED_TYPES
        )
        total_pending += pending_grading
        score_percent = round(100 * correct / len(auto_graded), 1) if auto_graded else None
        recent_results.append(
            {
                "quiz_id": attempt.quiz_id,
                "quiz_title": attempt.quiz.title,
                "attempt_id": attempt.id,
                "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
                "score_percent": score_percent,
                "graded_answer_count": len(auto_graded),
                "correct_answer_count": correct,
                "pending_grading_count": pending_grading,
            }
        )

    average_score_percent = round(100 * total_correct / total_graded, 1) if total_graded else None

    group_ids = [
        row.group_id
        for row in GroupPlayer.query.filter_by(player_id=player.id).with_entities(GroupPlayer.group_id)
    ]
    groups = Group.query.filter(Group.id.in_(group_ids)).all() if group_ids else []

    return (
        {
            "player": player.to_dict(),
            "current_groups": [{"id": g.id, "name": g.name} for g in groups],
            "assigned_count": assigned_count,
            "completed_count": completed_count,
            "completion_percent": completion_percent,
            "average_score_percent": average_score_percent,
            # Cumulative totals across every submitted attempt in scope.
            # Exposed so the performance PDF reads them rather than deriving
            # its own - two places computing "how many did they get right"
            # is how a report starts disagreeing with the player's profile.
            # Incorrect is graded minus correct by definition: an ungraded or
            # unanswered question is neither, and must never become a wrong.
            "total_correct_count": total_correct,
            "total_incorrect_count": total_graded - total_correct,
            "total_graded_count": total_graded,
            "total_pending_grading_count": total_pending,
            "recent_results": recent_results if result_limit is None else recent_results[:result_limit],
        }
    )


# A single report should not be able to become a denial-of-service or a
# thousand-page download by accident. Well above any real roster selection.
MAX_REPORT_PLAYERS = 100


@players_bp.get("/report.pdf")
@jwt_required()
def cumulative_performance_report():
    """One cumulative performance PDF for several selected players.

    COACH VIEW SCOPING: every player's numbers come from
    `build_player_history(..., organization_wide=False)`, which restricts to
    quizzes this coach created. A coach cannot learn a teammate's quiz titles
    or scores from this report, exactly as they cannot from the player
    profile page it reuses.

    GET with ids in the query string so the browser download path (and the
    frontend's existing getBlob helper) works unchanged, matching the other
    exports in this app. No writes happen here.

    Routing note: this is declared before nothing in particular - Flask's
    `int` converter means "/report.pdf" can never be mistaken for
    "/<int:player_id>".
    """
    coach = current_coach()

    raw_ids = (request.args.get("ids") or "").strip()
    if not raw_ids:
        raise ApiError("Select at least one player", status_code=400)

    try:
        # dict.fromkeys: de-duplicated, order preserved, so asking for the
        # same player twice yields one section rather than two identical ones.
        requested = list(dict.fromkeys(int(part) for part in raw_ids.split(",") if part.strip()))
    except ValueError:
        raise ApiError("Player ids must be numbers", status_code=400)

    if not requested:
        raise ApiError("Select at least one player", status_code=400)
    if len(requested) > MAX_REPORT_PLAYERS:
        raise ApiError(
            f"Select at most {MAX_REPORT_PLAYERS} players for one report", status_code=422
        )

    players = Player.query.filter(
        Player.id.in_(requested), Player.organization_id == coach.organization_id
    ).all()
    # All-or-nothing, and 404 rather than 403: a partial report would quietly
    # omit somebody the coach believes they selected, and a distinct 403 would
    # confirm that an id exists in another organization.
    if len(players) != len(requested):
        raise ApiError("One or more players were not found", status_code=404)

    ordered = sorted(players, key=lambda p: (p.last_name.lower(), p.first_name.lower()))
    histories = [
        build_player_history(coach, player, organization_wide=False, result_limit=None)
        for player in ordered
    ]

    pdf = build_cumulative_performance_pdf(histories)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return Response(
        pdf,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="performance-report-{stamp}.pdf"'
        },
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
