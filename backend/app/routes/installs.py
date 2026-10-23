"""INSTALLS - "this is what we are installing this week".

A coach's working set of existing football (models/install.py): Motion Lab
plays, quizzes and Reps, concepts - referred to, never copied - in an order he
chooses, with one optional level of sections.

  GET    /api/installs[?archived=1]       his installs (active by default)
  POST   /api/installs                    a new one
  GET    /api/installs/<id>               it, its sections and items, each item
                                          with what PEIRA already knows about it
  PATCH  /api/installs/<id>               rename, its room, archive / restore
  DELETE /api/installs/<id>               the install only - never the football
  POST   /api/installs/<id>/items         add football to it
  DELETE /api/installs/<id>/items/<item>  take it out (the football stays)
  PUT    /api/installs/<id>/layout        the whole order, sections included
  POST   /api/installs/<id>/duplicate     the same organization, new name -
                                          references, not copies
  GET    /api/installs/for?kind=&ref_id=  his active installs, and which
                                          already hold this piece of football

OWN-ONLY, like every quiz list: another coach's install is a 404.

ITEM STATUS IS WHAT PEIRA ALREADY KNOWS, read-only and light: for a play, what
he has made from it; for a quiz, whether it is out, how many have turned it
in, what is waiting to be graded and its weakest concept; for a Rep, who ran it
and its open football problem (the Rep page's own first-try rules); for a
concept, how much of his football is about it. No score is invented.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from sqlalchemy import func
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db
from app.models import (
    AccessCode,
    Concept,
    Install,
    InstallItem,
    InstallSection,
    Question,
    Quiz,
)
from app.models.question import MANUALLY_GRADED_TYPES
from app.models.quiz import REP_KIND
from app.schemas.install import (
    InstallCreateSchema,
    InstallDuplicateSchema,
    InstallItemSchema,
    InstallLayoutSchema,
    InstallPatchSchema,
)
from app.services.results_preload import submitted_official_attempts
from app.services.concept_results import concept_breakdown
from app.services.question_exclusions import active_exclusions_for_quiz
from app.services.rep_results import rep_results
from app.utils.auth import current_coach, get_org_motion_play, get_visible_quiz, require_motion_lab_coach
from app.utils.validation import load_json_body, load_optional_json_body

installs_bp = Blueprint("installs", __name__)


def _own_install(install_id: int, coach) -> Install:
    # Its items with what each refers to, and its sections: one query apiece,
    # not one per item.
    install = db.session.get(
        Install,
        install_id,
        options=[
            selectinload(Install.sections),
            selectinload(Install.items).joinedload(InstallItem.play),
            selectinload(Install.items).joinedload(InstallItem.quiz),
            selectinload(Install.items).joinedload(InstallItem.concept),
        ],
    )
    if install is None or install.coach_id != coach.id or install.organization_id != coach.organization_id:
        raise ApiError("Install not found", status_code=404)
    return install


def _counts(install: Install) -> dict:
    out = {"plays": 0, "quizzes": 0, "reps": 0, "concepts": 0}
    for item in install.items:
        if item.kind == "play":
            out["plays"] += 1
        elif item.kind == "concept":
            out["concepts"] += 1
        elif item.quiz is not None and item.quiz.kind == REP_KIND:
            out["reps"] += 1
        else:
            out["quizzes"] += 1
    return out


def _summary(install: Install) -> dict:
    return {
        "id": install.id,
        "title": install.title,
        "position_group": install.position_group,
        "archived": install.archived_at is not None,
        "current": install.is_current,
        "item_count": len(install.items),
        "counts": _counts(install),
        "created_at": install.created_at.isoformat(),
        "updated_at": install.updated_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# What PEIRA already knows about each item
# ---------------------------------------------------------------------------


def _made_from_plays(coach, play_ids: list[int]) -> dict[int, dict]:
    """{play_id: {"quizzes": n, "reps": n}} - his quizzes and Reps holding a live
    question made from each play (made-from-play's own rule)."""
    if not play_ids:
        return {}
    rows = (
        db.session.query(Question.motion_play_id, Quiz.kind, func.count(func.distinct(Quiz.id)))
        .join(Quiz, Question.quiz_id == Quiz.id)
        .filter(
            Question.motion_play_id.in_(play_ids),
            Question.retired_at.is_(None),
            Quiz.organization_id == coach.organization_id,
            Quiz.coach_id == coach.id,
        )
        .group_by(Question.motion_play_id, Quiz.kind)
        .all()
    )
    out = {pid: {"quizzes": 0, "reps": 0} for pid in play_ids}
    for play_id, kind, n in rows:
        out[play_id]["reps" if kind == REP_KIND else "quizzes"] += n
    return out


def _live(quiz: Quiz) -> bool:
    codes = AccessCode.query.filter_by(quiz_id=quiz.id, is_active=True).all()
    return any(code.is_valid() for code in codes)


def _quiz_status(quiz: Quiz) -> dict:
    # The dashboard's own read: answers, players, questions and roster loaded
    # once (services/results_preload), not per player or per question.
    responses = submitted_official_attempts(quiz)
    excluded = {row.question_id for row in active_exclusions_for_quiz(quiz.id)}
    to_grade = sum(
        1
        for r in responses
        for a in r.answers
        if a.is_correct is None
        and a.question is not None
        and a.question.question_type in MANUALLY_GRADED_TYPES
        and a.question_id not in excluded
    )
    weakest = next((c for c in concept_breakdown(quiz, responses) if c["players_missed_count"] > 0), None)
    return {
        "live": _live(quiz),
        "submitted": len(responses),
        "to_grade": to_grade,
        "weakest": (
            {
                "concept_id": weakest["concept_id"],
                "name": weakest["concept_name"],
                "missed": weakest["players_missed_count"],
                "responded": weakest["players_responded_count"],
            }
            if weakest
            else None
        ),
    }


def _rep_status(rep: Quiz) -> dict:
    results = rep_results(rep)
    problem = next((c for c in results["concepts"] if c["missed"] > 0 and not c.get("retest")), None)
    return {
        "live": results["audience"]["code"] is not None,
        "ran": len(results["players"]),
        "invited": results["audience"]["invited"],
        "open_problem": (
            {
                "name": problem["name"],
                "concept_id": (problem["concept"] or {}).get("id"),
                "missed": problem["missed"],
                "responded": problem["responded"],
                "taught": problem.get("taught") is not None,
            }
            if problem
            else None
        ),
    }


def _concept_status(coach, concept_id: int) -> dict:
    """How much of his football is about this concept (quizzes and Reps)."""
    rows = (
        db.session.query(Quiz.kind, func.count(func.distinct(Quiz.id)))
        .join(Question, Question.quiz_id == Quiz.id)
        .filter(
            Question.concept_id == concept_id,
            Question.retired_at.is_(None),
            Quiz.organization_id == coach.organization_id,
            Quiz.coach_id == coach.id,
        )
        .group_by(Quiz.kind)
        .all()
    )
    counts = {"quizzes": 0, "reps": 0}
    for kind, n in rows:
        counts["reps" if kind == REP_KIND else "quizzes"] += n
    return counts


def _item(item: InstallItem, made: dict[int, dict], coach, with_status: bool = True) -> dict:
    base = {"id": item.id, "kind": item.kind, "section_id": item.section_id, "position": item.position, "ref_id": item.ref_id}
    if item.kind == "play":
        play = item.play
        base["ref"] = {"id": play.id, "name": play.name, "updated_at": play.updated_at.isoformat()}
        base["status"] = {"made": made.get(play.id, {"quizzes": 0, "reps": 0})} if with_status else None
    elif item.kind == "quiz":
        quiz = item.quiz
        base["ref"] = {"id": quiz.id, "title": quiz.title, "kind": quiz.kind, "question_count": len(quiz.questions)}
        base["status"] = (_rep_status(quiz) if quiz.kind == REP_KIND else _quiz_status(quiz)) if with_status else None
    else:
        concept = item.concept
        base["ref"] = {"id": concept.id, "name": concept.name, "is_archived": concept.is_archived}
        base["status"] = {"in": _concept_status(coach, concept.id)} if with_status else None
    return base


def _detail(install: Install, coach, with_status: bool = True) -> dict:
    """The install with each item's reference - and, unless the request only
    moved, renamed or re-marked it, what PEIRA knows about each item. An edit
    to the order changes nothing about the football, so it answers with
    `status: null` and the page keeps the statuses it already shows (each
    status is a results read; rebuilding them on every arrow tap was the
    slowest thing an install did)."""
    made = _made_from_plays(coach, [i.motion_play_id for i in install.items if i.kind == "play"]) if with_status else {}
    data = _summary(install)
    data["sections"] = [{"id": s.id, "title": s.title, "position": s.position} for s in install.sections]
    data["items"] = [_item(i, made, coach, with_status) for i in install.items]
    return data


# ---------------------------------------------------------------------------
# The current install - his choice, one at a time
# ---------------------------------------------------------------------------


def _current_of(coach) -> Install | None:
    return Install.query.filter(Install.coach_id == coach.id, Install.is_current.is_(True)).first()


def _make_current(install: Install, coach) -> None:
    """This install is the current one; whichever was stops being - first, so
    the one-per-coach index never sees two."""
    Install.query.filter(
        Install.coach_id == coach.id, Install.is_current.is_(True), Install.id != install.id
    ).update({Install.is_current: False}, synchronize_session="fetch")
    db.session.flush()
    install.is_current = True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@installs_bp.get("")
@jwt_required()
def list_installs():
    coach = current_coach()
    archived = request.args.get("archived") in ("1", "true")
    query = Install.query.filter(Install.organization_id == coach.organization_id, Install.coach_id == coach.id)
    query = query.filter(Install.archived_at.isnot(None) if archived else Install.archived_at.is_(None))
    # The current install first; then the rest, most recently worked on first.
    installs = query.order_by(Install.is_current.desc(), Install.updated_at.desc(), Install.id.desc()).all()
    return jsonify([_summary(i) for i in installs])


@installs_bp.post("")
@jwt_required()
def create_install():
    coach = current_coach()
    data = load_json_body(InstallCreateSchema())
    install = Install(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=data["title"],
        position_group=data["position_group"],
        # With no current install, the new one is it: there is nothing to replace.
        is_current=_current_of(coach) is None,
    )
    db.session.add(install)
    db.session.commit()
    return jsonify(_detail(install, coach)), 201


@installs_bp.get("/for")
@jwt_required()
def installs_for():
    """His active installs, and whether each already holds this football - for
    "Add to install" where the football is."""
    coach = current_coach()
    kind = request.args.get("kind", "")
    try:
        ref_id = int(request.args.get("ref_id", ""))
    except ValueError as exc:
        raise ApiError("ref_id must be an id", status_code=422) from exc
    column = {"play": InstallItem.motion_play_id, "quiz": InstallItem.quiz_id, "concept": InstallItem.concept_id}.get(kind)
    if column is None:
        raise ApiError("Unknown kind", status_code=422)
    installs = (
        Install.query.filter(
            Install.organization_id == coach.organization_id, Install.coach_id == coach.id, Install.archived_at.is_(None)
        )
        .order_by(Install.updated_at.desc(), Install.id.desc())
        .all()
    )
    holding: set[int] = set()
    if installs:
        rows = db.session.query(InstallItem.install_id).filter(
            InstallItem.install_id.in_([i.id for i in installs]), column == ref_id
        )
        holding = {row[0] for row in rows}
    return jsonify([{"id": i.id, "title": i.title, "has": i.id in holding} for i in installs])


@installs_bp.get("/<int:install_id>")
@jwt_required()
def get_install(install_id: int):
    coach = current_coach()
    return jsonify(_detail(_own_install(install_id, coach), coach))


@installs_bp.patch("/<int:install_id>")
@jwt_required()
def patch_install(install_id: int):
    coach = current_coach()
    install = _own_install(install_id, coach)
    data = load_optional_json_body(InstallPatchSchema())
    if "title" in data:
        install.title = data["title"]
    if "position_group" in data:
        install.position_group = data["position_group"]
    if "archived" in data:
        install.archived_at = datetime.now(timezone.utc) if data["archived"] else None
        # Put away, it is not this week's any more. Restoring brings it back
        # as an ordinary install - current only when he says so.
        if data["archived"]:
            install.is_current = False
    if "current" in data:
        if not data["current"]:
            install.is_current = False
        elif install.archived_at is not None:
            raise ApiError("Restore it first - an archived install cannot be current", status_code=422)
        else:
            _make_current(install, coach)
    db.session.commit()
    return jsonify(_detail(install, coach, with_status=False))


@installs_bp.delete("/<int:install_id>")
@jwt_required()
def delete_install(install_id: int):
    """The install - its order and sections - and nothing else: every play,
    quiz, Rep and concept it referred to is untouched."""
    coach = current_coach()
    install = _own_install(install_id, coach)
    db.session.delete(install)
    db.session.commit()
    return "", 204


def _validated_ref(kind: str, ref_id: int, coach):
    if kind == "play":
        require_motion_lab_coach()
        return get_org_motion_play(ref_id, coach)
    if kind == "quiz":
        return get_visible_quiz(ref_id)
    concept = db.session.get(Concept, ref_id)
    if concept is None or concept.organization_id != coach.organization_id:
        raise ApiError("That concept does not exist", status_code=404)
    return concept


@installs_bp.post("/<int:install_id>/items")
@jwt_required()
def add_item(install_id: int):
    coach = current_coach()
    install = _own_install(install_id, coach)
    data = load_json_body(InstallItemSchema())
    _validated_ref(data["kind"], data["ref_id"], coach)
    section_id = data["section_id"]
    if section_id is not None and section_id not in {s.id for s in install.sections}:
        raise ApiError("That section is not in this install", status_code=422)
    column = {"play": "motion_play_id", "quiz": "quiz_id", "concept": "concept_id"}[data["kind"]]
    already = next((i for i in install.items if getattr(i, column) == data["ref_id"]), None)
    if already is None:
        siblings = [i for i in install.items if i.section_id == section_id]
        item = InstallItem(
            install_id=install.id,
            kind=data["kind"],
            section_id=section_id,
            position=max((i.position for i in siblings), default=-1) + 1,
            **{column: data["ref_id"]},
        )
        db.session.add(item)
        install.updated_at = datetime.now(timezone.utc)
        db.session.commit()
        db.session.refresh(install)
    return jsonify(_detail(install, coach)), (200 if already else 201)


@installs_bp.delete("/<int:install_id>/items/<int:item_id>")
@jwt_required()
def remove_item(install_id: int, item_id: int):
    coach = current_coach()
    install = _own_install(install_id, coach)
    item = next((i for i in install.items if i.id == item_id), None)
    if item is None:
        raise ApiError("That is not in this install", status_code=404)
    db.session.delete(item)
    install.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    db.session.refresh(install)
    return jsonify(_detail(install, coach, with_status=False))


@installs_bp.put("/<int:install_id>/layout")
@jwt_required()
def set_layout(install_id: int):
    """The whole order at once. Every item placed exactly once; sections left
    out are removed (their items must be placed elsewhere); new ones made."""
    coach = current_coach()
    install = _own_install(install_id, coach)
    data = load_json_body(InstallLayoutSchema())
    items = {i.id: i for i in install.items}
    placed = list(data["loose"]) + [iid for s in data["sections"] for iid in s["item_ids"]]
    if sorted(placed) != sorted(items) or len(set(placed)) != len(placed):
        raise ApiError("Every item must be placed exactly once", status_code=422, reason="bad_layout")
    sections = {s.id: s for s in install.sections}
    kept: set[int] = set()
    for position, entry in enumerate(data["sections"]):
        if entry["id"] is not None:
            section = sections.get(entry["id"])
            if section is None:
                raise ApiError("That section is not in this install", status_code=422, reason="bad_layout")
            section.title = entry["title"]
            section.position = position
        else:
            section = InstallSection(install_id=install.id, title=entry["title"], position=position)
            db.session.add(section)
            db.session.flush()
        kept.add(section.id)
        for item_position, item_id in enumerate(entry["item_ids"]):
            items[item_id].section_id = section.id
            items[item_id].position = item_position
    for item_position, item_id in enumerate(data["loose"]):
        items[item_id].section_id = None
        items[item_id].position = item_position
    for section_id, section in sections.items():
        if section_id not in kept:
            db.session.delete(section)
    install.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    db.session.refresh(install)
    return jsonify(_detail(install, coach, with_status=False))


@installs_bp.post("/<int:install_id>/duplicate")
@jwt_required()
def duplicate_install(install_id: int):
    """THE SAME ORGANIZATION FOR A NEW WEEK: a new install with the same sections
    and the same references, in the same order - pointing at the SAME football.
    No play, quiz, Rep or concept is copied; nothing delivered changes."""
    coach = current_coach()
    source = _own_install(install_id, coach)
    data = load_json_body(InstallDuplicateSchema())
    copy = Install(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=data["title"],
        position_group=source.position_group,
    )
    db.session.add(copy)
    db.session.flush()
    section_map = {}
    for section in source.sections:
        new = InstallSection(install_id=copy.id, title=section.title, position=section.position)
        db.session.add(new)
        db.session.flush()
        section_map[section.id] = new.id
    for item in source.items:
        db.session.add(
            InstallItem(
                install_id=copy.id,
                kind=item.kind,
                section_id=section_map.get(item.section_id),
                position=item.position,
                motion_play_id=item.motion_play_id,
                quiz_id=item.quiz_id,
                concept_id=item.concept_id,
            )
        )
    if data["make_current"]:
        _make_current(copy, coach)
    db.session.commit()
    db.session.refresh(copy)
    return jsonify(_detail(copy, coach)), 201
