"""Concepts: the small vocabulary a coach tags questions with.

Two endpoints, deliberately. Listing is what the picker needs; creating is how
a coach adds one without leaving the question they are writing. Renaming,
merging and archiving are real needs but they are Phase B's, and guessing at
them now would be building a taxonomy manager nobody has asked for yet.
"""
from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from marshmallow import Schema, fields, validate
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app import db
from app.models.concept import Concept
from app.errors import ApiError
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

concepts_bp = Blueprint("concepts", __name__)


class ConceptCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=80))


@concepts_bp.get("/concepts")
@jwt_required()
def list_concepts():
    """Every concept this organization can currently tag with.

    Archived ones are withheld: they exist so history keeps resolving, not so
    a coach can keep choosing them. Nothing here is per-coach - two coaches on
    one staff must land on the same "Cover 3" or the analysis splits in half.
    """
    coach = current_coach()
    rows = (
        Concept.query.filter_by(organization_id=coach.organization_id, is_archived=False)
        .order_by(func.lower(Concept.name))
        .all()
    )
    return jsonify([c.to_dict() for c in rows])


@concepts_bp.post("/concepts")
@jwt_required()
def create_concept():
    """Add one, or hand back the one that already means this.

    A COACH TYPING AN EXISTING NAME IS NOT AN ERROR. "Cover 3" when someone
    already made "cover 3" means the same idea, and the useful response is
    that concept - not a 409 the picker would have to interpret. Case-folded
    lookup first, and the unique index still guards the race between two
    coaches typing it at the same moment.

    An ARCHIVED match is revived rather than duplicated: creating a second row
    with the same name is precisely the split the index exists to prevent.
    """
    coach = current_coach()
    data = load_json_body(ConceptCreateSchema())
    name = data["name"].strip()
    if not name:
        raise ApiError("A concept needs a name", status_code=422)

    existing = Concept.query.filter(
        Concept.organization_id == coach.organization_id,
        func.lower(Concept.name) == name.lower(),
    ).first()
    if existing is not None:
        if existing.is_archived:
            existing.is_archived = False
            db.session.commit()
        return jsonify(existing.to_dict()), 200

    concept = Concept(organization_id=coach.organization_id, name=name)
    db.session.add(concept)
    try:
        db.session.commit()
    except IntegrityError:
        # Two coaches typed it at once; converge on whichever won.
        db.session.rollback()
        winner = Concept.query.filter(
            Concept.organization_id == coach.organization_id,
            func.lower(Concept.name) == name.lower(),
        ).first()
        if winner is None:
            raise
        return jsonify(winner.to_dict()), 200
    return jsonify(concept.to_dict()), 201
