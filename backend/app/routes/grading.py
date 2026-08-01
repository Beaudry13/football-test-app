"""Manual grading, coach feedback, and results dashboards.

Registered under /api directly (not /api/quizzes) because it also exposes
cross-quiz endpoints like per-player history.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from sqlalchemy.orm import contains_eager, selectinload

from app.errors import ApiError
from app.extensions import db
from app.models import Answer, PlayerResponse, Quiz
from app.schemas.grading import GradeAnswerSchema
from app.utils.auth import current_coach, get_owned_quiz
from app.utils.validation import load_json_body

grading_bp = Blueprint("grading", __name__)


def _get_owned_answer(answer_id: int) -> Answer:
    coach = current_coach()
    answer = (
        Answer.query.join(PlayerResponse)
        .join(Quiz)
        .filter(Answer.id == answer_id, Quiz.coach_id == coach.id)
        .first()
    )
    if answer is None:
        raise ApiError("Answer not found", status_code=404)
    return answer


@grading_bp.get("/quizzes/<int:quiz_id>/responses")
@jwt_required()
def list_responses(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)
    responses = (
        PlayerResponse.query.filter_by(quiz_id=quiz.id)
        .options(selectinload(PlayerResponse.answers))
        .order_by(PlayerResponse.submitted_at.desc())
        .all()
    )
    return jsonify([r.to_dict(include_answers=True) for r in responses])


@grading_bp.get("/quizzes/<int:quiz_id>/responses/<int:response_id>")
@jwt_required()
def get_response(quiz_id: int, response_id: int):
    quiz = get_owned_quiz(quiz_id)
    response = (
        PlayerResponse.query.filter_by(id=response_id, quiz_id=quiz.id)
        .options(selectinload(PlayerResponse.answers))
        .first()
    )
    if response is None:
        raise ApiError("Response not found", status_code=404)
    return jsonify(response.to_dict(include_answers=True))


@grading_bp.patch("/answers/<int:answer_id>/grade")
@jwt_required()
def grade_answer(answer_id: int):
    answer = _get_owned_answer(answer_id)
    data = load_json_body(GradeAnswerSchema())

    answer.is_correct = data["is_correct"]
    if data["coach_feedback"] is not None:
        answer.coach_feedback = data["coach_feedback"]
    answer.graded_at = datetime.now(timezone.utc)

    db.session.commit()
    return jsonify(answer.to_dict())


@grading_bp.get("/quizzes/<int:quiz_id>/dashboard")
@jwt_required()
def quiz_dashboard(quiz_id: int):
    quiz = get_owned_quiz(quiz_id)

    roster_size = len(quiz.roster.players) if quiz.roster else 0
    responses = (
        PlayerResponse.query.filter_by(quiz_id=quiz.id)
        .options(selectinload(PlayerResponse.answers))
        .all()
    )
    response_count = len(responses)
    response_rate = (response_count / roster_size) if roster_size else 0.0

    question_breakdown = []
    for question in sorted(quiz.questions, key=lambda q: q.position):
        answers = [a for r in responses for a in r.answers if a.question_id == question.id]
        correct = sum(1 for a in answers if a.is_correct is True)
        incorrect = sum(1 for a in answers if a.is_correct is False)
        ungraded = sum(1 for a in answers if a.is_correct is None)

        question_breakdown.append(
            {
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "answered_count": len(answers),
                "correct_count": correct,
                "incorrect_count": incorrect,
                "ungraded_count": ungraded,
            }
        )

    return jsonify(
        {
            "quiz_id": quiz.id,
            "roster_size": roster_size,
            "response_count": response_count,
            "response_rate": round(response_rate, 4),
            "question_breakdown": question_breakdown,
        }
    )


@grading_bp.get("/players/history")
@jwt_required()
def player_history():
    coach = current_coach()
    player_name = request.args.get("name", "").strip()
    if not player_name:
        raise ApiError("Query parameter 'name' is required", status_code=400)

    responses = (
        PlayerResponse.query.join(Quiz)
        .filter(Quiz.coach_id == coach.id, PlayerResponse.player_name == player_name)
        # contains_eager reuses the join above for response.quiz.title instead of
        # a separate lazy-load per response; selectinload batches .answers in one query.
        .options(contains_eager(PlayerResponse.quiz), selectinload(PlayerResponse.answers))
        .order_by(PlayerResponse.submitted_at.desc())
        .all()
    )

    history = []
    for response in responses:
        auto_graded = [a for a in response.answers if a.is_correct is not None]
        correct = sum(1 for a in auto_graded if a.is_correct)

        history.append(
            {
                "quiz_id": response.quiz_id,
                "quiz_title": response.quiz.title,
                "response_id": response.id,
                "submitted_at": response.submitted_at.isoformat(),
                "graded_answer_count": len(auto_graded),
                "correct_answer_count": correct,
            }
        )

    return jsonify({"player_name": player_name, "history": history})
