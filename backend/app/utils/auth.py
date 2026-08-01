"""Auth helpers layered on top of Flask-JWT-Extended.

Coaches are the only authenticated principal in this system. JWT identity
is the coach's id (as a string, per JWT spec); `current_coach()` resolves
it back to a model instance and enforces that the coach still exists.
"""

from flask_jwt_extended import get_jwt_identity

from app.errors import ApiError
from app.extensions import db
from app.models import Coach, Quiz


def current_coach() -> Coach:
    coach_id = get_jwt_identity()
    coach = db.session.get(Coach, int(coach_id))
    if coach is None:
        raise ApiError("Coach account no longer exists", status_code=401)
    return coach


def require_owned_quiz(quiz: Quiz | None, coach: Coach) -> None:
    """Raise if `quiz` does not belong to `coach`. Keeps coach data scoped per org."""
    if quiz is None or quiz.coach_id != coach.id:
        # 404, not 403: don't reveal that a quiz id belongs to another coach.
        raise ApiError("Quiz not found", status_code=404)


def get_owned_quiz(quiz_id: int) -> Quiz:
    """Fetch a quiz by id, scoped to the authenticated coach making the request."""
    coach = current_coach()
    quiz = db.session.get(Quiz, quiz_id)
    require_owned_quiz(quiz, coach)
    return quiz
