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
from app.schemas.access_code import ActivateQuizSchema, SetExpirySchema
from app.services.access_codes import generate_unique_code
from app.services.attempts import deliverable_questions
from app.utils.auth import current_coach, get_editable_quiz, get_visible_quiz
from app.utils.validation import load_json_body, load_optional_json_body

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

    # DELIVERABLE questions, everywhere in this block. Validating over
    # `quiz.questions` would let a question the coach has stopped sending block
    # activation over a fault no future player can encounter - and, worse, the
    # numbering in the error messages below would count questions the players
    # about to receive this quiz will never see. "Question 3 needs an image" has
    # to mean the third question they actually get.
    deliverable = deliverable_questions(quiz)

    if not quiz.questions:
        raise ApiError("Cannot activate a quiz with no questions", status_code=422)

    if not deliverable:
        # Distinct from the message above on purpose: the quiz HAS questions,
        # they are simply all stopped. Telling the coach "no questions" would
        # send them looking for content that is right there in the editor.
        raise ApiError(
            "Every question in this Peira is stopped, so there is nothing to send. "
            "Restore a question, or add a new one.",
            status_code=422,
            reason="no_deliverable_questions",
        )

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
        for index, question in enumerate(deliverable)
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
        for index, question in enumerate(deliverable)
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
    # A coach who said when this should stop gets exactly that; everyone else
    # gets the historical 24-hour window. Validated the same way a later change
    # is, so "available until" cannot mean one thing here and another there.
    expires_at = _validated_expiry(data.get("expires_at")) or AccessCode.default_expiry(ttl_hours)
    access_code = AccessCode(
        quiz_id=quiz.id,
        code=generate_unique_code(),
        activated_at=datetime.now(timezone.utc),
        expires_at=expires_at,
        is_active=True,
        # The assignment decides how the quiz is being used. Every attempt
        # started under this code copies it and freezes it.
        mode=data["mode"],
        # Practice-only. Stored regardless of mode so the value survives if a
        # coach flips the mode while filling the form, but frozen_question_order
        # ignores it for anything graded.
        randomize_questions=data["randomize_questions"],
        groups=groups,
    )
    db.session.add(access_code)
    db.session.commit()
    return jsonify(access_code.to_dict()), 201


def _validated_expiry(value):
    """An expiry the server is willing to stand behind, or None if none given.

    THE CLIENT CLOCK IS NEVER TRUSTED. The instant arrives absolute, but
    "is it in the future" is decided here against the server's own clock - a
    laptop an hour slow must not be able to create a code that is already dead,
    or one that outlives what its coach chose.

    A past instant is REFUSED rather than clamped. Silently moving it to "now"
    would look identical to success and kill an activation the coach believed
    they had just extended; `Deactivate now` is how you end one deliberately.
    """
    if value is None:
        return None
    if value <= datetime.now(timezone.utc):
        raise ApiError(
            "Pick a time in the future. To end it right now, use Deactivate.",
            status_code=422,
        )
    return value


@access_codes_bp.patch("/<int:quiz_id>/access-codes/<int:access_code_id>")
@jwt_required()
def set_expiry(quiz_id: int, access_code_id: int):
    """Change when an activation stops - SAME CODE, SAME LINK.

    THIS IS AN UPDATE, NOT A REACTIVATION, and that distinction is the whole
    point. Reactivating mints a new code and silently kills the link already
    sitting in twenty players' group text. Extending a session that runs late,
    or pulling one in, must not cost a coach the thing they already shared -
    so this touches one column and nothing else.

    Attempts reference the code by id and never copy its expiry, so a player
    already partway through is unaffected by either direction.
    """
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(SetExpirySchema())

    access_code = AccessCode.query.filter_by(id=access_code_id, quiz_id=quiz.id).first()
    if access_code is None:
        raise ApiError("Access code not found", status_code=404)
    if not access_code.is_active:
        # Nothing to extend. Reviving a deactivated code by moving its expiry
        # would resurrect a link a coach deliberately killed.
        raise ApiError(
            "That code has been deactivated. Activate the quiz again to share it.",
            status_code=409,
        )

    access_code.expires_at = _validated_expiry(data["expires_at"])
    db.session.commit()
    return jsonify(access_code.to_dict())


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
