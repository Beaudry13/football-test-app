"""Quiz CRUD, duplication, and preview. All routes are coach-scoped."""

import copy

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required

from app.extensions import db
from app.models import Question, QuestionImage, QuestionOption, Quiz
from app.schemas.quiz import QuizCreateSchema, QuizUpdateSchema
from app.utils.auth import current_coach, get_owned_quiz
from app.utils.validation import load_json_body

quizzes_bp = Blueprint("quizzes", __name__)


@quizzes_bp.get("")
@jwt_required()
def list_quizzes():
    coach = current_coach()
    quizzes = Quiz.query.filter_by(coach_id=coach.id).order_by(Quiz.updated_at.desc()).all()
    return jsonify([q.to_dict() for q in quizzes])


@quizzes_bp.post("")
@jwt_required()
def create_quiz():
    coach = current_coach()
    data = load_json_body(QuizCreateSchema())

    quiz = Quiz(
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
    quiz = get_owned_quiz(quiz_id)
    return jsonify(quiz.to_dict(include_questions=True, include_correct_answers=True))


@quizzes_bp.patch("/<int:quiz_id>")
@jwt_required()
def update_quiz(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    data = load_json_body(QuizUpdateSchema())

    for field in ("title", "description", "one_question_at_a_time"):
        if field in data:
            setattr(quiz, field, data[field])

    db.session.commit()
    return jsonify(quiz.to_dict())


@quizzes_bp.delete("/<int:quiz_id>")
@jwt_required()
def delete_quiz(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    db.session.delete(quiz)
    db.session.commit()
    return "", 204


@quizzes_bp.post("/<int:quiz_id>/duplicate")
@jwt_required()
def duplicate_quiz(quiz_id: int):
    original = get_owned_quiz(quiz_id)

    copy_quiz = Quiz(
        coach_id=original.coach_id,
        title=f"{original.title} (Copy)",
        description=original.description,
        one_question_at_a_time=original.one_question_at_a_time,
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
