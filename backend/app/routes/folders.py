"""Folder CRUD for both folder areas - Quizzes (the default) and Motion Lab.

AREAS. A folder belongs to exactly one area (models/folder.py). Every route
here answers about quiz folders unless asked about motion folders, so the
dashboard and FolderPage - which never name an area - see exactly what they
always did. Motion Lab folders are org-wide and gated by
require_motion_lab_coach; a quiz folder's rules are unchanged.

Nesting is deliberately simple: a folder's parent_folder_id is fixed at
creation and never changed afterward (see Folder.parent_folder_id's
comment), which is what keeps self-parenting and cycles structurally
impossible rather than something each route has to separately guard
against. The only thing left to enforce here is the two-level depth cap.
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db
from app.models import Folder
from app.schemas.folder import FolderCreateSchema, FolderUpdateSchema
from app.services.quiz_scope import visible_folders
from app.models.folder import FOLDER_AREA_MOTION, FOLDER_AREA_QUIZZES, FOLDER_AREAS
from app.utils.auth import (
    current_coach,
    get_org_folder,
    own_quizzes_query,
    require_motion_lab_coach,
)
from app.utils.validation import load_json_body

folders_bp = Blueprint("folders", __name__)


def _requested_area() -> str:
    """`?area=` on a list, defaulting to quizzes so every existing caller - the
    dashboard, FolderPage - keeps asking exactly the question it always did."""
    area = request.args.get("area", FOLDER_AREA_QUIZZES)
    if area not in FOLDER_AREAS:
        raise ApiError("Validation failed", status_code=422, details={"area": ["Unknown folder area."]})
    return area


def _guard_motion(folder: Folder) -> None:
    """A Motion Lab folder is reachable only by a coach who may use Motion Lab.
    Anyone else gets the same 404 as a folder that does not exist."""
    if folder.area == FOLDER_AREA_MOTION:
        require_motion_lab_coach()


@folders_bp.get("")
@jwt_required()
def list_folders():
    if _requested_area() == FOLDER_AREA_MOTION:
        # MOTION LAB FOLDERS ARE THE ORGANIZATION'S, whole. Plays are
        # collaborative content with no creator filter, so neither are the
        # folders that file them - visible_folders' own-quizzes rule is a Quizzes
        # rule and does not apply here.
        coach = require_motion_lab_coach()
        motion_folders = (
            Folder.query.filter_by(organization_id=coach.organization_id, area=FOLDER_AREA_MOTION)
            .order_by(Folder.name)
            .all()
        )
        return jsonify([f.to_dict() for f in motion_folders])

    coach = current_coach()
    folders = (
        Folder.query.filter_by(organization_id=coach.organization_id, area=FOLDER_AREA_QUIZZES)
        .options(selectinload(Folder.quizzes), selectinload(Folder.subfolders))
        .order_by(Folder.name)
        .all()
    )
    # Coach View shows only folders relevant to this coach - theirs, ones
    # holding their quizzes, and the ancestors needed to reach those. Without
    # the ancestors a nested folder becomes unreachable from the dashboard.
    # See services/quiz_scope.visible_folders.
    return jsonify(
        [f.to_dict() for f in visible_folders(coach, folders, own_quizzes_query(coach).all())]
    )


@folders_bp.post("")
@jwt_required()
def create_folder():
    data = load_json_body(FolderCreateSchema())
    # A Motion Lab folder may only be made by a coach who may use Motion Lab.
    coach = require_motion_lab_coach() if data["area"] == FOLDER_AREA_MOTION else current_coach()

    parent_folder_id = data["parent_folder_id"]
    if parent_folder_id is not None:
        # get_org_folder() already 404s for a missing id or one in another
        # organization - covers "stale/missing parent" and "cross-org
        # parent" with no extra code here.
        # Nesting is unlimited. A real season structure is genuinely several
        # levels deep - 2026 Season > Week 3 > Defense > Redzone > Install -
        # and the previous two-level cap forced coaches to flatten that into
        # folder names.
        #
        # CYCLES REMAIN IMPOSSIBLE, and not by luck: a folder's parent is
        # chosen at creation and never changed (rename does not move folders,
        # and there is no reparent route). A new folder therefore cannot be
        # named as its own ancestor, because it does not exist yet when its
        # parent is picked. Adding folder-moving later WOULD need a real cycle
        # check - that is the change to be careful about, not this one.
        parent = get_org_folder(parent_folder_id)
        # ONE TREE PER AREA. A quiz folder under a motion folder (or the
        # reverse) would appear in neither tree's root and be unreachable.
        # Answered as "not found", the same as a folder in another organization.
        if parent.area != data["area"]:
            raise ApiError("Folder not found", status_code=404)

    folder = Folder(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        name=data["name"],
        parent_folder_id=parent_folder_id,
        area=data["area"],
    )
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@folders_bp.patch("/<int:folder_id>")
@jwt_required()
def rename_folder(folder_id: int):
    folder = get_org_folder(folder_id)
    _guard_motion(folder)
    data = load_json_body(FolderUpdateSchema())

    folder.name = data["name"]
    db.session.commit()
    return jsonify(folder.to_dict())


@folders_bp.delete("/<int:folder_id>")
@jwt_required()
def delete_folder(folder_id: int):
    folder = get_org_folder(folder_id)
    _guard_motion(folder)
    # Lower-risk choice over cascade-deleting the whole subtree: block until
    # subfolders are moved/deleted first. The FK's ondelete="RESTRICT" backs
    # this up at the database level too.
    if len(folder.subfolders) > 0:
        raise ApiError(
            "This folder has subfolders - delete or empty them first",
            status_code=422,
        )
    # The FK's ondelete="SET NULL" (see Quiz.folder_id) handles orphaning the
    # folder's quizzes back to "Uncategorized" - no manual unlinking needed.
    # A Motion Lab folder's plays return to the Library root the same way
    # (MotionPlay.folder_id is SET NULL too).
    db.session.delete(folder)
    db.session.commit()
    return "", 204
