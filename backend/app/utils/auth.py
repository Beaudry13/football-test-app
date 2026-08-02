"""Auth and multi-tenancy helpers layered on top of Flask-JWT-Extended.

Coaches are the only authenticated principal. JWT identity is the coach's id
(as a string, per JWT spec); `current_coach()` resolves it back to a model
instance and enforces that the coach still exists.

Tenancy model
-------------
`organization_id` is the tenancy scope - it decides what a coach can SEE.
`coach_id` is the creator - it decides what a coach can EDIT.

- Quizzes: visible to the whole organization, editable by their creator and
  by org admins (`get_visible_quiz` vs. `get_editable_quiz`).
- Folders and groups: fully org-shared - any member may edit them, since
  they're team infrastructure rather than one coach's work
  (`get_org_folder`, `get_org_group`).

Every failure is a 404, never a 403: a coach must not be able to learn that
an id exists in another organization by the error it produces.
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


def require_admin() -> Coach:
    """The authenticated coach, who must be an admin of their organization."""
    coach = current_coach()
    if not coach.is_admin():
        raise ApiError("This action requires an organization admin", status_code=403)
    return coach


def get_visible_quiz(quiz_id: int) -> Quiz:
    """A quiz in the caller's organization. For reads - any member may view
    any quiz their organization owns."""
    coach = current_coach()
    quiz = db.session.get(Quiz, quiz_id)
    if quiz is None or quiz.organization_id != coach.organization_id:
        raise ApiError("Quiz not found", status_code=404)
    return quiz


def get_editable_quiz(quiz_id: int) -> Quiz:
    """A quiz the caller may modify: in their organization, and either
    created by them or they're an admin.

    404 (not 403) when it exists in the org but belongs to a teammate would
    be misleading - the coach can see it listed - so that specific case is a
    403 with a clear reason, while a quiz in another org stays a 404.
    """
    quiz = get_visible_quiz(quiz_id)
    coach = current_coach()
    if quiz.coach_id != coach.id and not coach.is_admin():
        raise ApiError(
            "Only the coach who created this quiz, or an organization admin, can change it",
            status_code=403,
        )
    return quiz


def get_org_folder(folder_id: int) -> Folder:
    """A folder in the caller's organization. Org-shared: any member may edit."""
    coach = current_coach()
    folder = db.session.get(Folder, folder_id)
    if folder is None or folder.organization_id != coach.organization_id:
        raise ApiError("Folder not found", status_code=404)
    return folder


def get_org_group(group_id: int) -> Group:
    """A group in the caller's organization. Org-shared: any member may edit."""
    coach = current_coach()
    group = db.session.get(Group, group_id)
    if group is None or group.organization_id != coach.organization_id:
        raise ApiError("Group not found", status_code=404)
    return group
