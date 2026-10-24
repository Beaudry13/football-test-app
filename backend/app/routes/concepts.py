"""Concepts: the small vocabulary a coach tags questions with.

Two endpoints, deliberately. Listing is what the picker needs; creating is how
a coach adds one without leaving the question they are writing. Renaming,
merging and archiving are real needs but they are Phase B's, and guessing at
them now would be building a taxonomy manager nobody has asked for yet.
"""
from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from marshmallow import Schema, fields, validate
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app import db
from app.models.concept import Concept
from app.errors import ApiError
from app.utils.auth import current_coach, require_admin
from app.utils.validation import load_json_body


def _carry_teach_marks(merge_ids: set[int], keep_id: int) -> None:
    """A Rep problem taught under a merged concept stays taught under the one
    it merged into. Where that Rep already has a mark there, the later
    teaching wins and the other row goes - one mark per Rep and problem."""
    from app.models.rep_teach_mark import RepTeachMark, concept_key

    for mark in RepTeachMark.query.filter(RepTeachMark.concept_id.in_(merge_ids)).all():
        there = RepTeachMark.query.filter_by(quiz_id=mark.quiz_id, concept_key=concept_key(keep_id)).one_or_none()
        if there is None:
            mark.concept_id = keep_id
            mark.concept_key = concept_key(keep_id)
        else:
            if mark.taught_at > there.taught_at:
                there.taught_at = mark.taught_at
                there.taught_by_coach_id = mark.taught_by_coach_id
            db.session.delete(mark)
        db.session.flush()

concepts_bp = Blueprint("concepts", __name__)


class ConceptCreateSchema(Schema):
    name = fields.Str(required=True, validate=validate.Length(min=1, max=80))


class ConceptMergeSchema(Schema):
    keep_id = fields.Int(required=True)
    merge_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1, max=20))


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


# ---- CONCEPT CLEANUP: one "Motion adjustment", not five spellings -----------
#
# Deliberately small: find concepts that look like the same idea, and merge
# them into the one a coach keeps. Not a taxonomy manager.


def _normal(name: str) -> str:
    """"  Motion-Adjustment!! " -> "motion adjustment" (as the picker does)."""
    import re

    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def _close(a: str, b: str) -> bool:
    """Same idea by the picker's rules: same words, a shortened word
    ("motion adjust"), or a slip of the finger (two edits, on names of 5+)."""
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    if len(short) >= 4 and long_.startswith(short):
        return True
    if len(short) < 5 or len(long_) - len(short) > 2:
        return False
    row = list(range(len(long_) + 1))
    for i, ca in enumerate(short, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(long_, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1] <= 2


@concepts_bp.get("/concepts/<int:concept_id>/questions")
@jwt_required()
def concept_questions(concept_id: int):
    """THE FOOTBALL PROBLEMS ALREADY WRITTEN ABOUT ONE CONCEPT - the coach's
    own quizzes' and Reps' questions tagged with it, newest quiz first, so a
    targeted Rep can be built from what exists instead of rewritten. Own-only,
    like every list (utils/auth.get_visible_quiz). Stopped questions are left
    out: they would be undeliverable."""
    from app.models import Question, Quiz

    coach = current_coach()
    concept = db.session.get(Concept, concept_id)
    if concept is None or concept.organization_id != coach.organization_id:
        raise ApiError("That concept does not exist", status_code=404)
    if request.args.get("detail") == "teach":
        return jsonify(_concept_football_to_teach(coach, concept_id))
    rows = (
        Question.query.join(Quiz, Quiz.id == Question.quiz_id)
        .filter(
            Question.concept_id == concept_id,
            Question.retired_at.is_(None),
            Quiz.organization_id == coach.organization_id,
            Quiz.coach_id == coach.id,
        )
        .order_by(Quiz.updated_at.desc(), Quiz.id.desc(), Question.position)
        .limit(40)
        .all()
    )
    return jsonify(
        [
            {
                "question_id": q.id,
                "quiz_id": q.quiz_id,
                "quiz_title": q.quiz.title,
                "quiz_kind": q.quiz.kind,
                "question_text": q.question_text,
                "question_type": q.question_type.value,
                "has_picture": bool(q.image or q.presnap),
            }
            for q in rows
        ]
    )


def _concept_football_to_teach(coach, concept_id: int) -> dict:
    """THE CONCEPT'S FOOTBALL, READY TO TEACH, IN ONE READ - Position Teach
    (a room's misses) and an install's concept item asked for each source
    quiz whole, one after another, to keep two to eight slides.

    `?quiz_ids=1,2` narrows it to those quizzes (still own-only); without it,
    his newest. Each question serialized exactly as the coach's quiz payload
    serializes it (`to_dict(include_correct_answers=True)` and the masked
    picture, services/page_masking) - no second field list to drift - plus
    each quiz's retest parent, so a retest's copy is taught once, by source.
    Stopped questions are left out, as everywhere Teach reads.
    """
    from sqlalchemy.orm import contains_eager, selectinload

    from app.models import Question, Quiz
    from app.services.page_masking import attach_masked_media
    from app.services.signed_media import AUDIENCE_COACH

    wanted: list[int] = []
    for part in (request.args.get("quiz_ids") or "").split(","):
        if part.strip().isdigit():
            wanted.append(int(part))
    query = (
        Question.query.join(Quiz, Quiz.id == Question.quiz_id)
        .filter(
            Question.concept_id == concept_id,
            Question.retired_at.is_(None),
            Quiz.organization_id == coach.organization_id,
            Quiz.coach_id == coach.id,
        )
        .options(
            contains_eager(Question.quiz),
            selectinload(Question.options),
            selectinload(Question.image),
            selectinload(Question.clip),
            selectinload(Question.regions),
        )
    )
    if wanted:
        query = query.filter(Question.quiz_id.in_(wanted[:20]))
    rows = query.order_by(Quiz.updated_at.desc(), Quiz.id.desc(), Question.position).limit(60).all()
    quizzes: dict[int, dict] = {}
    for q in rows:
        quizzes.setdefault(
            q.quiz_id,
            {
                "id": q.quiz.id,
                "title": q.quiz.title,
                "kind": q.quiz.kind,
                "retest_of": {"id": q.quiz.retest_of_quiz_id} if q.quiz.retest_of_quiz_id else None,
            },
        )
    payload = {"questions": [q.to_dict(include_correct_answers=True) for q in rows]}
    attach_masked_media(payload, audience=AUDIENCE_COACH)
    return {"quizzes": list(quizzes.values()), "questions": payload["questions"]}


@concepts_bp.get("/concepts/duplicates")
@jwt_required()
def concept_duplicates():
    """Groups of active concepts that look like one idea, each with how many
    questions use every spelling - the most-used is the suggested keeper."""
    from app.models import Question

    coach = current_coach()
    rows = Concept.query.filter_by(organization_id=coach.organization_id, is_archived=False).all()
    counts = dict(
        db.session.query(Question.concept_id, func.count(Question.id))
        .filter(Question.concept_id.in_([c.id for c in rows] or [0]))
        .group_by(Question.concept_id)
        .all()
    )
    seen: set[int] = set()
    groups = []
    for c in rows:
        if c.id in seen:
            continue
        group = [x for x in rows if x.id not in seen and _close(_normal(c.name), _normal(x.name))]
        if len(group) < 2:
            continue
        seen.update(x.id for x in group)
        entries = sorted(
            ({"id": x.id, "name": x.name, "question_count": counts.get(x.id, 0)} for x in group),
            key=lambda e: (-e["question_count"], e["name"].lower()),
        )
        groups.append({"concepts": entries, "suggested_keep": entries[0]["id"]})
    return jsonify(groups)


@concepts_bp.post("/concepts/merge")
@jwt_required()
def merge_concepts():
    """Merge spellings of one idea into the concept the coach keeps: every
    question tagged with a merged concept is retagged to the kept one, and the
    merged concepts are ARCHIVED - never deleted, so every attempt snapshot and
    history that names them still resolves. Org admins only: it changes how
    teammates' questions are tagged."""
    from app.models import Question

    coach = require_admin()
    data = load_json_body(ConceptMergeSchema())
    keep_id = data["keep_id"]
    merge_ids = set(data["merge_ids"]) - {keep_id}
    if not merge_ids:
        raise ApiError("Pick at least one concept to merge into it", status_code=422)
    wanted = {keep_id} | merge_ids
    found = Concept.query.filter(
        Concept.id.in_(wanted), Concept.organization_id == coach.organization_id
    ).all()
    if len(found) != len(wanted):
        raise ApiError("That concept does not exist", status_code=422)
    keep = next(c for c in found if c.id == keep_id)
    retagged = (
        Question.query.filter(Question.concept_id.in_(merge_ids))
        .update({Question.concept_id: keep.id}, synchronize_session=False)
    )
    _carry_teach_marks(merge_ids, keep.id)
    for c in found:
        if c.id in merge_ids:
            c.is_archived = True
    if keep.is_archived:
        keep.is_archived = False
    db.session.commit()
    return jsonify({"kept": keep.to_dict(), "retagged": retagged, "archived": sorted(merge_ids)})
