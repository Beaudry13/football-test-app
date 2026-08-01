"""Coach-scoped quiz folder CRUD, for dashboard organization."""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import selectinload

from app.extensions import db
from app.models import Folder
from app.schemas.folder import FolderCreateSchema, FolderUpdateSchema
from app.utils.auth import current_coach, get_owned_folder
from app.utils.validation import load_json_body

folders_bp = Blueprint("folders", __name__)


@folders_bp.get("")
@jwt_required()
def list_folders():
    coach = current_coach()
    folders = (
        Folder.query.filter_by(coach_id=coach.id)
        .options(selectinload(Folder.quizzes))
        .order_by(Folder.name)
        .all()
    )
    return jsonify([f.to_dict() for f in folders])


@folders_bp.post("")
@jwt_required()
def create_folder():
    coach = current_coach()
    data = load_json_body(FolderCreateSchema())

    folder = Folder(coach_id=coach.id, name=data["name"])
    db.session.add(folder)
    db.session.commit()
    return jsonify(folder.to_dict()), 201


@folders_bp.patch("/<int:folder_id>")
@jwt_required()
def rename_folder(folder_id: int):
    folder = get_owned_folder(folder_id)
    data = load_json_body(FolderUpdateSchema())

    folder.name = data["name"]
    db.session.commit()
    return jsonify(folder.to_dict())


@folders_bp.delete("/<int:folder_id>")
@jwt_required()
def delete_folder(folder_id: int):
    folder = get_owned_folder(folder_id)
    # The FK's ondelete="SET NULL" (see Quiz.folder_id) handles orphaning the
    # folder's quizzes back to "Uncategorized" - no manual unlinking needed.
    db.session.delete(folder)
    db.session.commit()
    return "", 204
