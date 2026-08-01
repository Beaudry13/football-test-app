"""Public, unauthenticated endpoints players use to take a quiz.

No player accounts exist: identity is (access code + a name chosen from
the coach-uploaded roster), which is exactly what every route here checks.
"""

from flask import Blueprint, jsonify
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import AccessCode, Answer, PlayerResponse, Question
from app.schemas.play import PlayerResultsSchema, SubmitQuizSchema, ValidateCodeSchema
from app.services.access_codes import find_access_code_by_code, find_valid_access_code
from app.utils.validation import load_json_body

play_bp = Blueprint("play", __name__)

NO_RESULTS_FOUND = "No results found for that code and name"


def _resolve_answer_text(question: Question, answer: Answer | None) -> str | None:
    if answer is None:
        return None
    if question.question_type.value == "written":
        return answer.answer_text
    option = next((o for o in question.options if o.id == answer.selected_option_id), None)
    return option.option_text if option else None


@play_bp.post("/validate-code")
# Codes are 6 characters from a 31-character alphabet (~887M combinations).
# Without a limit here, that space is guessable by brute force; at 20/minute
# per IP it would take on the order of decades, while still leaving room for
# a player who mistypes a code a few times in a row.
@limiter.limit("20 per minute")
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
@limiter.limit("20 per minute")
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

    submitted_question_ids = [a["question_id"] for a in data["answers"]]
    if len(submitted_question_ids) != len(set(submitted_question_ids)):
        # Caught here, not left to the DB's unique constraint, so this doesn't get
        # misreported as "already submitted" by the IntegrityError handler below.
        raise ApiError("Each question can only be answered once per submission", status_code=422)

    # Validate every answer *before* writing anything. Raising mid-write (after
    # a flush assigns response.id but before commit) would leave an uncommitted
    # transaction sitting on the connection for the rest of the request/test -
    # harmless in isolation, but it can hold locks that block later work on the
    # same rows until something eventually tears the session down.
    quiz_question_ids = {q.id for q in quiz.questions}
    questions_by_id = {q.id: q for q in quiz.questions}
    graded_answers = []

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

        graded_answers.append(
            {
                "question_id": question_id,
                "answer_text": submitted_answer["answer_text"],
                "selected_option_id": selected_option_id,
                "is_correct": is_correct,
            }
        )

    response = PlayerResponse(
        quiz_id=quiz.id, access_code_id=access_code.id, player_name=data["player_name"]
    )
    # Appending through the relationship (rather than setting player_response_id
    # directly) lets SQLAlchemy assign the FK itself during commit, so there's
    # no need for an intermediate flush just to learn response.id.
    for graded_answer in graded_answers:
        response.answers.append(Answer(**graded_answer))
    db.session.add(response)

    try:
        # The only way this can still fail is a truly concurrent duplicate
        # submission: two requests both pass the pre-check above before either
        # has committed, and only the DB's unique constraint catches that.
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ApiError("This player has already submitted this quiz", status_code=409) from exc

    return jsonify(response.to_dict(include_answers=True)), 201


@play_bp.post("/results")
@limiter.limit("20 per minute")
def player_results():
    """A player's own graded results - revisitable after the code expires,
    since grading (especially of written answers) can happen well after."""
    data = load_json_body(PlayerResultsSchema())

    access_code = find_access_code_by_code(data["code"])
    if access_code is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    response = (
        PlayerResponse.query.filter(
            PlayerResponse.access_code_id == access_code.id,
            db.func.lower(PlayerResponse.player_name) == data["player_name"].strip().lower(),
        )
        .options(selectinload(PlayerResponse.answers))
        .first()
    )
    if response is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    quiz = access_code.quiz
    answers_by_question = {a.question_id: a for a in response.answers}

    answer_details = []
    for question in sorted(quiz.questions, key=lambda q: q.position):
        answer = answers_by_question.get(question.id)
        correct_option = next((o for o in question.options if o.is_correct_answer), None)

        answer_details.append(
            {
                "question_id": question.id,
                "question_text": question.question_text,
                "question_type": question.question_type.value,
                "your_answer": _resolve_answer_text(question, answer),
                "correct_answer": correct_option.option_text if correct_option else None,
                "is_correct": answer.is_correct if answer else None,
                "coach_feedback": answer.coach_feedback if answer else None,
                "graded_at": answer.graded_at.isoformat() if answer and answer.graded_at else None,
            }
        )

    return jsonify(
        {
            "quiz_title": quiz.title,
            "player_name": response.player_name,
            "submitted_at": response.submitted_at.isoformat(),
            "answers": answer_details,
        }
    )
