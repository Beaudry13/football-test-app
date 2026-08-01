"""Public, unauthenticated endpoints players use to take a quiz.

No player accounts exist: identity is (access code + a name chosen from
the coach-uploaded roster), which is exactly what every route here checks.
"""

from flask import Blueprint, jsonify
from sqlalchemy.exc import IntegrityError

from app.errors import ApiError
from app.extensions import db
from app.models import AccessCode, Answer, PlayerResponse, Question
from app.schemas.play import SubmitQuizSchema, ValidateCodeSchema
from app.services.access_codes import find_valid_access_code
from app.utils.validation import load_json_body

play_bp = Blueprint("play", __name__)


@play_bp.post("/validate-code")
def validate_code():
    data = load_json_body(ValidateCodeSchema())

    access_code = find_valid_access_code(data["code"])
    if access_code is None:
        raise ApiError("Invalid or expired access code", status_code=404)

    quiz = access_code.quiz
    roster_players = quiz.roster.players if quiz.roster is not None else []

    return jsonify(
        {
            "access_code_id": access_code.id,
            "expires_at": access_code.expires_at.isoformat(),
            "quiz": quiz.to_dict(include_questions=True, include_correct_answers=False),
            "roster_players": [p.player_name for p in roster_players],
        }
    )


@play_bp.post("/submit")
def submit_quiz():
    data = load_json_body(SubmitQuizSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    if access_code is None or not access_code.is_valid():
        raise ApiError("Invalid or expired access code", status_code=404)

    quiz = access_code.quiz
    roster_names = {p.player_name for p in (quiz.roster.players if quiz.roster else [])}
    if data["player_name"] not in roster_names:
        raise ApiError("Player name is not on this quiz's roster", status_code=422)

    existing = PlayerResponse.query.filter_by(
        access_code_id=access_code.id, player_name=data["player_name"]
    ).first()
    if existing is not None:
        raise ApiError("This player has already submitted this quiz", status_code=409)

    quiz_question_ids = {q.id for q in quiz.questions}
    questions_by_id = {q.id: q for q in quiz.questions}

    response = PlayerResponse(
        quiz_id=quiz.id, access_code_id=access_code.id, player_name=data["player_name"]
    )
    db.session.add(response)
    db.session.flush()

    for submitted_answer in data["answers"]:
        question_id = submitted_answer["question_id"]
        if question_id not in quiz_question_ids:
            raise ApiError(f"Question {question_id} does not belong to this quiz", status_code=422)

        question: Question = questions_by_id[question_id]
        selected_option_id = submitted_answer["selected_option_id"]
        is_correct = None

        if selected_option_id is not None:
            option = next((o for o in question.options if o.id == selected_option_id), None)
            if option is None:
                raise ApiError(
                    f"Option {selected_option_id} does not belong to question {question_id}",
                    status_code=422,
                )
            is_correct = option.is_correct_answer

        db.session.add(
            Answer(
                player_response_id=response.id,
                question_id=question_id,
                answer_text=submitted_answer["answer_text"],
                selected_option_id=selected_option_id,
                is_correct=is_correct,
            )
        )

    try:
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ApiError("This player has already submitted this quiz", status_code=409) from exc

    return jsonify(response.to_dict(include_answers=True)), 201
