"""Question CRUD, reordering, and image/annotation management.

Nested under /api/quizzes/<quiz_id>/questions. Every route re-verifies
quiz ownership so a coach can never read or mutate another coach's data.
"""

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import Question, QuestionImage, QuestionOption, QuestionType, Quiz
from app.schemas.question import (
    AnnotationsUpdateSchema,
    QuestionCreateSchema,
    QuestionReorderSchema,
    QuestionUpdateSchema,
    validate_options_for_type,
)
from app.services.file_storage import get_file_storage
from app.utils.auth import get_owned_quiz
from app.utils.validation import load_json_body

questions_bp = Blueprint("questions", __name__)


def _get_owned_question(quiz_id: int, question_id: int) -> Question:
    quiz = get_owned_quiz(quiz_id)
    question = Question.query.filter_by(id=question_id, quiz_id=quiz.id).first()
    if question is None:
        raise ApiError("Question not found", status_code=404)
    return question


def _replace_options(question: Question, options: list[dict]) -> None:
    question.options.clear()
    for index, option in enumerate(options):
        question.options.append(
            QuestionOption(
                option_text=option["option_text"],
                is_correct_answer=option["is_correct_answer"],
                position=index,
            )
        )


@questions_bp.post("/<int:quiz_id>/questions")
@jwt_required()
def create_question(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    data = load_json_body(QuestionCreateSchema())
    validate_options_for_type(data["question_type"], data["options"])

    next_position = data["position"]
    if next_position is None:
        next_position = len(quiz.questions)

    question = Question(
        quiz_id=quiz.id,
        question_text=data["question_text"],
        question_type=QuestionType(data["question_type"]),
        position=next_position,
    )
    db.session.add(question)
    db.session.flush()
    _replace_options(question, data["options"])

    db.session.commit()
    return jsonify(question.to_dict(include_correct_answers=True)), 201


@questions_bp.patch("/<int:quiz_id>/questions/<int:question_id>")
@jwt_required()
def update_question(quiz_id: int, question_id: int):
    question = _get_owned_question(quiz_id, question_id)
    data = load_json_body(QuestionUpdateSchema())

    question_type = data.get("question_type", question.question_type.value)
    if "options" in data:
        validate_options_for_type(question_type, data["options"])

    if "question_text" in data:
        question.question_text = data["question_text"]
    if "question_type" in data:
        question.question_type = QuestionType(data["question_type"])
    if "options" in data:
        _replace_options(question, data["options"])

    db.session.commit()
    return jsonify(question.to_dict(include_correct_answers=True))


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>")
@jwt_required()
def delete_question(quiz_id: int, question_id: int):
    question = _get_owned_question(quiz_id, question_id)

    if question.image is not None:
        get_file_storage().delete_image(question.image.image_url)

    db.session.delete(question)
    db.session.commit()
    return "", 204


@questions_bp.post("/<int:quiz_id>/questions/reorder")
@jwt_required()
def reorder_questions(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    data = load_json_body(QuestionReorderSchema())

    quiz_question_ids = {q.id for q in quiz.questions}
    if set(data["question_ids"]) != quiz_question_ids:
        raise ApiError("question_ids must include every question in the quiz exactly once")

    questions_by_id = {q.id: q for q in quiz.questions}
    for position, question_id in enumerate(data["question_ids"]):
        questions_by_id[question_id].position = position

    db.session.commit()
    return jsonify([q.to_dict() for q in sorted(quiz.questions, key=lambda q: q.position)])


@questions_bp.post("/<int:quiz_id>/questions/<int:question_id>/image")
@jwt_required()
def upload_question_image(quiz_id: int, question_id: int):
    question = _get_owned_question(quiz_id, question_id)

    if "image" not in request.files:
        raise ApiError("No image file provided under the 'image' field", status_code=400)

    storage = get_file_storage()
    if question.image is not None:
        storage.delete_image(question.image.image_url)
        db.session.delete(question.image)
        db.session.flush()

    image_url = storage.save_image(request.files["image"])
    image = QuestionImage(question_id=question.id, image_url=image_url, annotations=[])
    db.session.add(image)
    db.session.commit()
    return jsonify(image.to_dict()), 201


@questions_bp.put("/<int:quiz_id>/questions/<int:question_id>/image/annotations")
@jwt_required()
def update_question_image_annotations(quiz_id: int, question_id: int):
    question = _get_owned_question(quiz_id, question_id)
    if question.image is None:
        raise ApiError("Question has no image to annotate", status_code=404)

    data = load_json_body(AnnotationsUpdateSchema())
    question.image.annotations = data["annotations"]
    db.session.commit()
    return jsonify(question.image.to_dict())


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>/image")
@jwt_required()
def delete_question_image(quiz_id: int, question_id: int):
    question = _get_owned_question(quiz_id, question_id)
    if question.image is None:
        raise ApiError("Question has no image", status_code=404)

    get_file_storage().delete_image(question.image.image_url)
    db.session.delete(question.image)
    db.session.commit()
    return "", 204
