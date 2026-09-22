"""Motion Lab plays and looks - organization-owned, revision-protected.

WHO: an authenticated coach who passes require_motion_lab_coach (platform
owner only during the P2 pilot). WHAT: their organization's plays and looks,
all of them - Motion Lab content is collaborative, so there is no creator
filter. Another organization's play is a 404, indistinguishable from a play
that does not exist.

HOW CONCURRENT EDITS ARE SAFE: every content write names the revision it was
made from. The row is locked, the revision compared, and a mismatch refused
with 409 `revision_conflict` - the client then decides, with the coach, what
to keep. Nothing is ever merged or silently overwritten here.

WHAT IS STORED: authored intent only (services/motion_documents.py refuses
anything else). The football is derived in the browser by the Motion Lab
engine every time a play is opened.
"""

import copy

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import MotionLook, MotionPlay
from app.schemas.motion_lab import (
    LookCreateSchema,
    LookSaveSchema,
    PlayCopySchema,
    PlayCreateSchema,
    PlayPatchSchema,
    PlaySaveSchema,
)
from app.services.motion_documents import (
    MAX_PLAY_DOCUMENT_BYTES,
    validate_look_document,
    validate_play_document,
)
from app.utils.auth import (
    get_org_motion_folder,
    get_org_motion_look,
    get_org_motion_play,
    require_motion_lab_coach,
)
from app.utils.validation import load_json_body, load_optional_json_body

motion_lab_bp = Blueprint("motion_lab", __name__)

#: A request body far larger than any document could be is refused before it
#: is parsed. The document limit itself is enforced after parsing, on the
#: compact serialization. Twice the document ceiling leaves room for a client
#: that sends whitespace without letting an unbounded body reach the parser.
MAX_REQUEST_BYTES = 2 * MAX_PLAY_DOCUMENT_BYTES


def _bounded_body():
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        raise ApiError("This play is too large to save.", status_code=413, reason="document_too_large")


def _conflict(kind: str):
    return ApiError(
        f"This {kind} was changed somewhere else.",
        status_code=409,
        reason="revision_conflict",
    )


def _outdated_client(kind: str, stored: int, sent: int):
    """The tab saving this is older than the document it is saving over.

    A browser left open on a previous release rebuilds a play through ITS
    model, which knows nothing of fields added since - so its next autosave
    would quietly strip them. The version the client sends is the version its
    model writes, so anything below what is stored is refused rather than
    allowed to erase the difference.
    """
    return ApiError(
        f"This {kind} was saved by a newer Motion Lab (v{stored}); this tab writes v{sent}. Reload before editing.",
        status_code=409,
        reason="schema_outdated",
    )


# ---------------------------------------------------------------------------
# Plays
# ---------------------------------------------------------------------------


@motion_lab_bp.get("/plays")
@jwt_required()
def list_plays():
    """Every play in the organization, most recently changed first."""
    coach = require_motion_lab_coach()
    plays = (
        MotionPlay.query.filter_by(organization_id=coach.organization_id)
        .order_by(MotionPlay.updated_at.desc(), MotionPlay.id.desc())
        .all()
    )
    return jsonify([play.to_dict() for play in plays])


@motion_lab_bp.post("/plays")
@jwt_required()
def create_play():
    coach = require_motion_lab_coach()
    _bounded_body()
    data = load_json_body(PlayCreateSchema())
    document = validate_play_document(data["document"], data["schema_version"])
    folder_id = None
    if data["folder_id"] is not None:
        folder_id = get_org_motion_folder(data["folder_id"], coach).id
    play = MotionPlay(
        organization_id=coach.organization_id,
        created_by_coach_id=coach.id,
        name=data["name"],
        document=document,
        schema_version=data["schema_version"],
        revision=1,
        folder_id=folder_id,
    )
    db.session.add(play)
    db.session.commit()
    return jsonify(play.to_dict()), 201


@motion_lab_bp.get("/plays/<int:play_id>")
@jwt_required()
def get_play(play_id: int):
    coach = require_motion_lab_coach()
    return jsonify(get_org_motion_play(play_id, coach).to_dict())


@motion_lab_bp.put("/plays/<int:play_id>")
@jwt_required()
def save_play(play_id: int):
    """The editor's autosave: the whole authored play, from a known revision."""
    coach = require_motion_lab_coach()
    _bounded_body()
    data = load_json_body(PlaySaveSchema())
    document = validate_play_document(data["document"], data["schema_version"])
    play = get_org_motion_play(play_id, coach, for_update=True)
    if data["schema_version"] < play.schema_version:
        db.session.rollback()
        raise _outdated_client("play", play.schema_version, data["schema_version"])
    if play.revision != data["base_revision"]:
        db.session.rollback()
        raise _conflict("play")
    play.name = data["name"]
    play.document = document
    play.schema_version = data["schema_version"]
    play.revision += 1
    db.session.commit()
    return jsonify(play.to_dict())


@motion_lab_bp.patch("/plays/<int:play_id>")
@jwt_required()
def update_play(play_id: int):
    """Library housekeeping: rename, or move to a folder.

    A RENAME is a content change - the name is part of what the editor saves -
    so it bumps the revision, and an editor still holding the old revision will
    be told the play changed. FILING is not: moving a play between folders does
    not touch anything the editor holds, and must not make an open editor's
    next autosave look stale.
    """
    coach = require_motion_lab_coach()
    data = load_json_body(PlayPatchSchema())
    play = get_org_motion_play(play_id, coach, for_update=True)
    if "folder_id" in data:
        play.folder_id = (
            None if data["folder_id"] is None else get_org_motion_folder(data["folder_id"], coach).id
        )
    if "name" in data and data["name"] != play.name:
        play.name = data["name"]
        play.revision += 1
    db.session.commit()
    return jsonify(play.to_dict())


@motion_lab_bp.post("/plays/<int:play_id>/copy")
@jwt_required()
def copy_play(play_id: int):
    """An independent copy. `copied_from_play_id` records where it came from;
    nothing links the two afterwards."""
    coach = require_motion_lab_coach()
    data = load_optional_json_body(PlayCopySchema())
    source = get_org_motion_play(play_id, coach)
    if "folder_id" in data:
        folder_id = None if data["folder_id"] is None else get_org_motion_folder(data["folder_id"], coach).id
    else:
        folder_id = source.folder_id
    duplicate = MotionPlay(
        organization_id=coach.organization_id,
        created_by_coach_id=coach.id,
        name=data.get("name") or f"{source.name} (copy)"[:255],
        # A deep copy by value: JSONB round-trips through Python objects, and
        # the new row gets its own document. Editing either never reaches the
        # other.
        document=copy.deepcopy(source.document),
        schema_version=source.schema_version,
        revision=1,
        folder_id=folder_id,
        copied_from_play_id=source.id,
    )
    db.session.add(duplicate)
    db.session.commit()
    return jsonify(duplicate.to_dict()), 201


@motion_lab_bp.delete("/plays/<int:play_id>")
@jwt_required()
def delete_play(play_id: int):
    coach = require_motion_lab_coach()
    play = get_org_motion_play(play_id, coach, for_update=True)
    db.session.delete(play)
    db.session.commit()
    return "", 204


# ---------------------------------------------------------------------------
# Looks
# ---------------------------------------------------------------------------


@motion_lab_bp.get("/looks")
@jwt_required()
def list_looks():
    coach = require_motion_lab_coach()
    looks = (
        MotionLook.query.filter_by(organization_id=coach.organization_id)
        .order_by(MotionLook.updated_at.desc(), MotionLook.id.desc())
        .all()
    )
    return jsonify([look.to_dict() for look in looks])


@motion_lab_bp.post("/looks")
@jwt_required()
def create_look():
    coach = require_motion_lab_coach()
    _bounded_body()
    data = load_json_body(LookCreateSchema())
    document = validate_look_document(data["document"], data["schema_version"])
    look = MotionLook(
        organization_id=coach.organization_id,
        created_by_coach_id=coach.id,
        name=data["name"],
        document=document,
        schema_version=data["schema_version"],
        revision=1,
    )
    db.session.add(look)
    db.session.commit()
    return jsonify(look.to_dict()), 201


@motion_lab_bp.get("/looks/<int:look_id>")
@jwt_required()
def get_look(look_id: int):
    coach = require_motion_lab_coach()
    return jsonify(get_org_motion_look(look_id, coach).to_dict())


@motion_lab_bp.put("/looks/<int:look_id>")
@jwt_required()
def save_look(look_id: int):
    coach = require_motion_lab_coach()
    _bounded_body()
    data = load_json_body(LookSaveSchema())
    document = validate_look_document(data["document"], data["schema_version"])
    look = get_org_motion_look(look_id, coach, for_update=True)
    if data["schema_version"] < look.schema_version:
        db.session.rollback()
        raise _outdated_client("formation", look.schema_version, data["schema_version"])
    if look.revision != data["base_revision"]:
        db.session.rollback()
        raise _conflict("look")
    look.name = data["name"]
    look.document = document
    look.schema_version = data["schema_version"]
    look.revision += 1
    db.session.commit()
    return jsonify(look.to_dict())


@motion_lab_bp.delete("/looks/<int:look_id>")
@jwt_required()
def delete_look(look_id: int):
    coach = require_motion_lab_coach()
    look = get_org_motion_look(look_id, coach, for_update=True)
    db.session.delete(look)
    db.session.commit()
    return "", 204

