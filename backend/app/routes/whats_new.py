"""Per-coach read state for What's New.

Two endpoints over one column. The backend deliberately knows NOTHING about
what a release contains or which one is newest - it stores an opaque string
and hands it back.

WHY THE CONTENT LIVES IN THE FRONTEND
--------------------------------------
Release notes are content, exactly like the Help articles beside them, and
those already live in `frontend/src/help/registry.tsx`. Keeping releases
there means shipping one is a single registry entry and a deploy, with no
second copy of the same words in Python to drift from it.

The cost of that choice is that the client decides which version it has
seen. That is fine here: the only thing a client can do by lying is change
its own unread dot. Nothing about another coach, another organization, or
any real data is reachable through this.
"""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from marshmallow import Schema, fields, validate

from app.extensions import db
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

whats_new_bp = Blueprint("whats_new", __name__)


class MarkSeenSchema(Schema):
    # Length-capped to match the column. The value is opaque to the server -
    # it is only ever compared with itself on the way back out.
    version = fields.Str(required=True, validate=validate.Length(min=1, max=32))


def _payload(coach) -> dict:
    return {"seen_version": coach.whats_new_seen_version}


@whats_new_bp.get("")
@jwt_required()
def get_whats_new_state():
    """The newest release this coach has seen, or null if they never have.

    Null is the interesting case: it is what makes every coach who existed
    before What's New shipped see the indicator once, without a backfill.
    """
    return jsonify(_payload(current_coach()))


@whats_new_bp.post("/seen")
@jwt_required()
def mark_whats_new_seen():
    """Record that this coach has seen up to `version`.

    Idempotent, and a plain assignment rather than a max(): the client sends
    the newest release it knows about, and "seen" only ever means "matches
    the newest release" (see the equality comparison on the client). Trying
    to keep the highest of two version strings would need ordering rules
    that this column deliberately does not have.
    """
    coach = current_coach()
    data = load_json_body(MarkSeenSchema())

    if coach.whats_new_seen_version != data["version"]:
        coach.whats_new_seen_version = data["version"]
        db.session.commit()

    return jsonify(_payload(coach))
