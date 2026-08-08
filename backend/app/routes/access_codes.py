"""Coach-facing access code activation and history.

Player-facing code validation lives in routes/play.py since it's a public,
unauthenticated endpoint.
"""

from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import AccessCode, Group
from app.models.question import QuestionType
from app.schemas.access_code import ActivateQuizSchema
from app.services.access_codes import generate_unique_code
from app.utils.auth import current_coach, get_editable_quiz, get_visible_quiz
from app.utils.validation import load_optional_json_body

access_codes_bp = Blueprint("access_codes", __name__)


@access_codes_bp.get("/<int:quiz_id>/access-codes")
@jwt_required()
def list_access_codes(quiz_id: int):
    # Read-only: any coach in the org may look up the active code to share it.
    quiz = get_visible_quiz(quiz_id)
    return jsonify([code.to_dict() for code in quiz.access_codes])


@access_codes_bp.post("/<int:quiz_id>/access-codes")
@jwt_required()
def activate_quiz(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    data = load_optional_json_body(ActivateQuizSchema())

    groups: list[Group] = []
    if data["group_ids"]:
        coach = current_coach()
        groups = Group.query.filter(
            Group.id.in_(data["group_ids"]),
            Group.organization_id == coach.organization_id,
        ).all()
        if len(groups) != len(set(data["group_ids"])):
            raise ApiError("One or more selected groups were not found", status_code=404)

    if not quiz.questions:
        raise ApiError("Cannot activate a quiz with no questions", status_code=422)

    # A Draw Response question with no image is answerable by nobody. The type
    # cannot demand an image at creation - the upload targets an existing
    # question, so requiring one up front would make the type impossible to
    # create - so the check lands here, at the moment it actually protects
    # someone: a roster of players about to receive the quiz.
    #
    # Enforced in the API rather than only in the editor, because the editor is
    # not the only way to reach this route, and because an image deleted after
    # the question was authored puts a quiz back into this state without the
    # coach touching the question at all.
    missing_images = [
        index + 1
        for index, question in enumerate(quiz.questions)
        if question.question_type is QuestionType.DRAW_RESPONSE and question.image is None
    ]
    if missing_images:
        listed = ", ".join(str(n) for n in missing_images)
        # Agreement kept across the whole sentence. A coach reads this message
        # at the moment they are blocked from publishing, and "Question 1 needs
        # an image ... draw on them" reads as a bug in the product.
        if len(missing_images) == 1:
            message = (
                f"Question {listed} needs an image before players can draw on it. "
                "Add one, or change the question type."
            )
        else:
            message = (
                f"Questions {listed} need images before players can draw on them. "
                "Add them, or change the question types."
            )
        raise ApiError(
            message,
            status_code=422,
            details={"questions_needing_images": missing_images},
        )

    # Same class of problem, same place to catch it: a Fill in the Blank
    # question whose region or accepted answers went missing cannot be answered
    # correctly by anyone. The region can disappear without the coach touching
    # the question - deleting the source document takes its pages with it - so
    # like the image check above, this is re-derived at activation rather than
    # trusted from creation time.
    unanswerable = [
        index + 1
        for index, question in enumerate(quiz.questions)
        if question.question_type is QuestionType.FILL_BLANK
        and (not question.regions or not question.expected_answers)
    ]
    if unanswerable:
        listed = ", ".join(str(n) for n in unanswerable)
        if len(unanswerable) == 1:
            message = (
                f"Question {listed} is missing its playbook region or its accepted "
                "answers. Fix it, or remove it, before sending this quiz."
            )
        else:
            message = (
                f"Questions {listed} are missing their playbook regions or accepted "
                "answers. Fix them, or remove them, before sending this quiz."
            )
        raise ApiError(
            message,
            status_code=422,
            details={"questions_needing_regions": unanswerable},
        )

    has_roster_players = quiz.roster is not None and bool(quiz.roster.players)
    has_group_players = any(g.players for g in groups)
    if not has_roster_players and not has_group_players:
        raise ApiError(
            "Cannot activate a quiz with no roster and no group selected", status_code=422
        )

    # Only one code should be usable to join at a time; retire any still-active ones.
    for existing_code in quiz.access_codes:
        if existing_code.is_active:
            existing_code.is_active = False

    ttl_hours = current_app.config["ACCESS_CODE_TTL_HOURS"]
    access_code = AccessCode(
        quiz_id=quiz.id,
        code=generate_unique_code(),
        activated_at=datetime.now(timezone.utc),
        expires_at=AccessCode.default_expiry(ttl_hours),
        is_active=True,
        groups=groups,
    )
    db.session.add(access_code)
    db.session.commit()
    return jsonify(access_code.to_dict()), 201


@access_codes_bp.post("/<int:quiz_id>/access-codes/<int:access_code_id>/deactivate")
@jwt_required()
def deactivate_access_code(quiz_id: int, access_code_id: int):
    quiz = get_editable_quiz(quiz_id)
    access_code = AccessCode.query.filter_by(id=access_code_id, quiz_id=quiz.id).first()
    if access_code is None:
        raise ApiError("Access code not found", status_code=404)

    access_code.is_active = False
    db.session.commit()
    return jsonify(access_code.to_dict())
