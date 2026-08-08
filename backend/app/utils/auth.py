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
from app.models import Coach, Folder, Group, Player, Quiz


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


def own_quizzes_query(coach: Coach | None = None):
    """THE scope for every Coach View list. Quizzes this coach created.

    One helper rather than a repeated filter_by, because "which quizzes does
    this coach see" is now a security boundary and there are eight list
    surfaces that must all answer it identically. A missed one is a leak, and
    a leak here shows a coach another coach's work.

    NO ADMIN EXCEPTION, deliberately. An admin using the normal coach
    endpoints sees only their own quizzes, exactly as a member does - the
    org-wide view lives behind /api/organizations/quizzes and nowhere else.
    That is what stops Admin View from being "the same list, but bigger".
    """
    coach = coach or current_coach()
    return Quiz.query.filter(
        Quiz.organization_id == coach.organization_id,
        Quiz.coach_id == coach.id,
    )


def get_visible_quiz(quiz_id: int) -> Quiz:
    """A single quiz the caller may open: in their organization, and either
    created by them or they are an admin.

    THE SPLIT IS AT LISTS, NOT AT READS. Lists are own-only for everyone;
    single-quiz reads allow admins. The alternative - a parallel admin copy of
    all nine single-quiz routes (quiz, questions, responses, dashboard,
    access codes, roster, CSV, PDF, detailed PDF) - would be nine more places
    for two implementations of the same rule to drift apart, to buy a
    restriction an admin defeats by clicking "Admin View" anyway. The real
    boundary is ROLE, and role is enforced here.

    404, never 403: a member must not be able to learn that a quiz id exists
    by the error it produces. That is why this reads as "not found" for a
    teammate's quiz rather than "not allowed".
    """
    coach = current_coach()
    quiz = db.session.get(Quiz, quiz_id)
    if quiz is None or quiz.organization_id != coach.organization_id:
        raise ApiError("Quiz not found", status_code=404)
    if quiz.coach_id != coach.id and not coach.is_admin():
        raise ApiError("Quiz not found", status_code=404)
    return quiz


def get_editable_quiz(quiz_id: int) -> Quiz:
    """A quiz the caller may modify.

    Identical to `get_visible_quiz` now, and that convergence is the point:
    once Coach View became own-only, "can see it" and "can change it" answer
    the same question. Both names are kept because the call sites read very
    differently - `get_editable_quiz` at a mutating route documents intent -
    and because if the two rules ever diverge again there are already two
    hooks to diverge at.
    """
    return get_visible_quiz(quiz_id)


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


def get_org_player(player_id: int) -> Player:
    """A master-roster Player in the caller's organization. Org-shared, same
    as groups/folders - any member may view or edit any player their
    organization owns. The 404-not-403 rule applies here too: a player id
    that belongs to another organization must look identical to one that
    doesn't exist at all."""
    coach = current_coach()
    player = db.session.get(Player, player_id)
    if player is None or player.organization_id != coach.organization_id:
        raise ApiError("Player not found", status_code=404)
    return player
