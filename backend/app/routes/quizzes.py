"""Quiz CRUD, duplication, and preview.

All routes are organization-scoped: any coach in the organization can read
a quiz, but only its creator or an org admin can change it. See
app/utils/auth.py for the tenancy rules.
"""

import copy
from collections import defaultdict
from datetime import datetime, timezone

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import contains_eager, selectinload

from app.extensions import db
from app.models import (
    AccessCode,
    AttemptStatus,
    Group,
    PlayerAttempt,
    Question,
    QuestionImage,
    QuestionOption,
    Quiz,
    Roster,
)
from app.schemas.quiz import QuizCreateSchema, QuizUpdateSchema
from app.services.access_codes import effective_roster_names
from app.services.file_storage import get_file_storage
from app.utils.auth import current_coach, get_editable_quiz, get_org_folder, get_visible_quiz
from app.utils.validation import load_json_body

quizzes_bp = Blueprint("quizzes", __name__)


@quizzes_bp.get("")
@jwt_required()
def list_quizzes():
    coach = current_coach()
    # selectinload: to_dict() reads len(quiz.questions) for question_count, so
    # without this each quiz would trigger its own lazy-load query (N+1).
    quizzes = (
        Quiz.query.filter_by(organization_id=coach.organization_id)
        .options(selectinload(Quiz.questions), selectinload(Quiz.coach))
        .order_by(Quiz.updated_at.desc())
        .all()
    )

    # One query for every quiz's active-code status, instead of walking each
    # quiz's full access_codes history (which only grows over time) or
    # issuing a per-quiz query (N+1). A quiz appears here at most once in
    # practice (reactivating deactivates the prior code), but a set handles
    # it either way.
    quiz_ids = [q.id for q in quizzes]
    active_quiz_ids: set[int] = set()
    if quiz_ids:
        active_quiz_ids = {
            quiz_id
            for (quiz_id,) in db.session.query(AccessCode.quiz_id)
            .filter(
                AccessCode.quiz_id.in_(quiz_ids),
                AccessCode.is_active.is_(True),
                AccessCode.expires_at > datetime.now(timezone.utc),
            )
            .all()
        }

    return jsonify([q.to_dict(is_active=q.id in active_quiz_ids) for q in quizzes])


@quizzes_bp.get("/active-status")
@jwt_required()
def active_status():
    """Live submitted/in-progress/not-started breakdown for every currently
    active access code in the org - what the dashboard's prominent
    active-quiz section polls. Keyed by access code, not quiz: nothing stops
    two codes on the same quiz both being active in principle (the
    retire-on-activate behavior in access_codes.py is app-level, not a DB
    constraint), so keying by code means that surfaces as two cards instead
    of silently colliding.

    Two queries total regardless of how many quizzes are simultaneously
    active - same batching discipline as list_quizzes' is_active computation
    above, just extended to also carry the roster/group data each card
    needs.
    """
    coach = current_coach()
    active_codes = (
        AccessCode.query.join(Quiz)
        .filter(
            Quiz.organization_id == coach.organization_id,
            AccessCode.is_active.is_(True),
            AccessCode.expires_at > datetime.now(timezone.utc),
        )
        .options(
            contains_eager(AccessCode.quiz).selectinload(Quiz.roster).selectinload(Roster.players),
            selectinload(AccessCode.groups).selectinload(Group.players),
        )
        .all()
    )

    attempts_by_code: dict[int, list[PlayerAttempt]] = defaultdict(list)
    if active_codes:
        code_ids = [c.id for c in active_codes]
        for attempt in PlayerAttempt.query.filter(PlayerAttempt.access_code_id.in_(code_ids)).all():
            attempts_by_code[attempt.access_code_id].append(attempt)

    result = []
    for code in active_codes:
        attempts = attempts_by_code[code.id]
        submitted = [
            {"player_name": a.player_name, "submitted_at": a.submitted_at.isoformat()}
            for a in attempts
            if a.status == AttemptStatus.SUBMITTED
        ]
        in_progress = [
            {"player_name": a.player_name, "started_at": a.started_at.isoformat()}
            for a in attempts
            if a.status == AttemptStatus.IN_PROGRESS
        ]
        # Ground truth is the attempt, not the roster snapshot - a coach can
        # edit a group's membership after players already started, and an
        # already-created attempt shouldn't vanish from view because of that
        # (same staleness tolerance _build_dashboard_data already documents
        # for its own missing_players list).
        roster_names = effective_roster_names(code)
        started_names = {a.player_name for a in attempts}
        not_started = [name for name in roster_names if name not in started_names]

        result.append(
            {
                "quiz_id": code.quiz_id,
                "quiz_title": code.quiz.title,
                "access_code_id": code.id,
                "code": code.code,
                "expires_at": code.expires_at.isoformat(),
                # Sorted so the "sent to" line doesn't visually reorder on a
                # background poll when nothing actually changed - a poll
                # that reorders things nobody touched reads as a bug.
                "group_names": sorted(g.name for g in code.groups),
                "roster_size": len(roster_names),
                "submitted": submitted,
                "in_progress": in_progress,
                "not_started": not_started,
            }
        )

    return jsonify(result)


@quizzes_bp.post("")
@jwt_required()
def create_quiz():
    coach = current_coach()
    data = load_json_body(QuizCreateSchema())

    quiz = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=data["title"],
        description=data["description"],
        one_question_at_a_time=data["one_question_at_a_time"],
    )
    db.session.add(quiz)
    db.session.commit()
    return jsonify(quiz.to_dict()), 201


@quizzes_bp.get("/<int:quiz_id>")
@jwt_required()
def get_quiz(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    return jsonify(quiz.to_dict(include_questions=True, include_correct_answers=True))


@quizzes_bp.patch("/<int:quiz_id>")
@jwt_required()
def update_quiz(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(QuizUpdateSchema())

    for field in ("title", "description", "one_question_at_a_time"):
        if field in data:
            setattr(quiz, field, data[field])

    if "folder_id" in data:
        if data["folder_id"] is None:
            quiz.folder_id = None
        else:
            quiz.folder_id = get_org_folder(data["folder_id"]).id

    db.session.commit()
    return jsonify(quiz.to_dict())


@quizzes_bp.delete("/<int:quiz_id>")
@jwt_required()
def delete_quiz(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    # DB-level cascade removes the question_images rows, but not the actual
    # files - those have to be cleaned up explicitly before the row goes away.
    storage = get_file_storage()
    for question in quiz.questions:
        if question.image:
            storage.delete_image(question.image.image_url)
    db.session.delete(quiz)
    db.session.commit()
    return "", 204


@quizzes_bp.post("/<int:quiz_id>/duplicate")
@jwt_required()
def duplicate_quiz(quiz_id: int):
    # Readable by anyone in the org, so a coach can start from a teammate's
    # quiz. The copy belongs to whoever duplicated it, not to the original
    # author - otherwise they'd end up unable to edit their own new copy.
    original = get_visible_quiz(quiz_id)
    coach = current_coach()

    copy_quiz = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=f"{original.title} (Copy)",
        description=original.description,
        one_question_at_a_time=original.one_question_at_a_time,
        folder_id=original.folder_id,
    )
    db.session.add(copy_quiz)
    db.session.flush()  # assign copy_quiz.id without committing

    for question in original.questions:
        copy_question = Question(
            quiz_id=copy_quiz.id,
            question_text=question.question_text,
            question_type=question.question_type,
            position=question.position,
        )
        db.session.add(copy_question)
        db.session.flush()

        for option in question.options:
            db.session.add(
                QuestionOption(
                    question_id=copy_question.id,
                    option_text=option.option_text,
                    is_correct_answer=option.is_correct_answer,
                    position=option.position,
                )
            )

        if question.image is not None:
            db.session.add(
                QuestionImage(
                    question_id=copy_question.id,
                    image_url=question.image.image_url,
                    annotations=copy.deepcopy(question.image.annotations),
                )
            )

    db.session.commit()
    return jsonify(copy_quiz.to_dict(include_questions=True, include_correct_answers=True)), 201
