"""Auth helpers layered on top of Flask-JWT-Extended.

Coaches are the only authenticated principal in this system. JWT identity
is the coach's id (as a string, per JWT spec); `current_coach()` resolves
it back to a model instance and enforces that the coach still exists.
"""

from flask_jwt_extended import get_jwt_identity

from app.errors import ApiError
from app.extensions import db
from app.models import Coach, Folder, Group, Quiz


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


def get_owned_folder(folder_id: int) -> Folder:
    """Fetch a folder by id, scoped to the authenticated coach making the request."""
    coach = current_coach()
    folder = db.session.get(Folder, folder_id)
    if folder is None or folder.coach_id != coach.id:
        raise ApiError("Folder not found", status_code=404)
    return folder


def get_owned_group(group_id: int) -> Group:
    """Fetch a group by id, scoped to the authenticated coach making the request."""
    coach = current_coach()
    group = db.session.get(Group, group_id)
    if group is None or group.coach_id != coach.id:
        raise ApiError("Group not found", status_code=404)
    return group
