"""Coach-scoped quiz folder CRUD, for dashboard organization.

Nesting is deliberately simple: a folder's parent_folder_id is fixed at
creation and never changed afterward (see Folder.parent_folder_id's
comment), which is what keeps self-parenting and cycles structurally
impossible rather than something each route has to separately guard
against. The only thing left to enforce here is the two-level depth cap.
"""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db
from app.models import Folder
from app.schemas.folder import FolderCreateSchema, FolderUpdateSchema
from app.services.quiz_scope import visible_folders
from app.utils.auth import current_coach, own_quizzes_query, get_org_folder
from app.utils.validation import load_json_body

folders_bp = Blueprint("folders", __name__)


@folders_bp.get("")
@jwt_required()
def list_folders():
    coach = current_coach()
    folders = (
        Folder.query.filter_by(organization_id=coach.organization_id)
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
    coach = current_coach()
    data = load_json_body(FolderCreateSchema())

    parent_folder_id = data["parent_folder_id"]
    if parent_folder_id is not None:
        # get_org_folder() already 404s for a missing id or one in another
        # organization - covers "stale/missing parent" and "cross-org
        # parent" with no extra code here.
        parent = get_org_folder(parent_folder_id)
        if parent.parent_folder_id is not None:
            raise ApiError(
                "Folders can only be nested one level deep - this folder is already a subfolder",
                status_code=422,
            )

    folder = Folder(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        name=data["name"],
        parent_folder_id=parent_folder_id,
    )
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@folders_bp.patch("/<int:folder_id>")
@jwt_required()
def rename_folder(folder_id: int):
    folder = get_org_folder(folder_id)
    data = load_json_body(FolderUpdateSchema())

    folder.name = data["name"]
    db.session.commit()
    return jsonify(folder.to_dict())


@folders_bp.delete("/<int:folder_id>")
@jwt_required()
def delete_folder(folder_id: int):
    folder = get_org_folder(folder_id)
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
    db.session.delete(folder)
    db.session.commit()
    return "", 204
