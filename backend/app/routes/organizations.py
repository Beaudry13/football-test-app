"""Organization membership and invitations.

Every route resolves the organization from the authenticated coach rather
than from a URL parameter - there is no way to name another organization in
a request, so there's nothing to authorize against and nothing to leak.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db, limiter
from sqlalchemy.orm import selectinload

from app.models import Coach, CoachRole, Folder, OrganizationInvite, Quiz
from app.schemas.organization import (
    MemberRoleUpdateSchema,
    OrganizationUpdateSchema,
    QuizOwnerUpdateSchema,
)
from app.services.invites import INVITE_TTL_DAYS, generate_invite_code
from app.utils.auth import current_coach, require_admin
from app.utils.validation import load_json_body

organizations_bp = Blueprint("organizations", __name__)


def _member_dict(coach: Coach) -> dict:
    return {
        "id": coach.id,
        "username": coach.username,
        "email": coach.email,
        "role": coach.role.value,
    }


def _admin_count(organization_id: int) -> int:
    return Coach.query.filter_by(organization_id=organization_id, role=CoachRole.ADMIN).count()


def _get_org_member(coach_id: int, organization_id: int) -> Coach:
    member = Coach.query.filter_by(id=coach_id, organization_id=organization_id).first()
    if member is None:
        raise ApiError("Member not found", status_code=404)
    return member


@organizations_bp.get("")
@jwt_required()
def get_organization():
    coach = current_coach()
    members = (
        Coach.query.filter_by(organization_id=coach.organization_id)
        .order_by(Coach.username)
        .all()
    )
    return jsonify(
        {
            **coach.organization.to_dict(),
            "members": [_member_dict(m) for m in members],
        }
    )


@organizations_bp.patch("")
@jwt_required()
@limiter.limit("20 per minute")
def rename_organization():
    coach = require_admin()
    data = load_json_body(OrganizationUpdateSchema())

    coach.organization.name = data["name"]
    db.session.commit()
    return jsonify(coach.organization.to_dict())


@organizations_bp.get("/invites")
@jwt_required()
@limiter.limit("30 per minute")
def list_invites():
    coach = require_admin()
    invites = (
        OrganizationInvite.query.filter_by(organization_id=coach.organization_id)
        .order_by(OrganizationInvite.created_at.desc())
        .all()
    )
    # Codes are omitted from the list: an invite link is shown once, when it's
    # created. Re-reading a code later isn't needed and widens where a live
    # credential can be observed.
    return jsonify([i.to_dict() for i in invites])


@organizations_bp.post("/invites")
@jwt_required()
@limiter.limit("20 per minute")
def create_invite():
    coach = require_admin()

    invite = OrganizationInvite(
        organization_id=coach.organization_id,
        code=generate_invite_code(),
        created_by_coach_id=coach.id,
        created_at=datetime.now(timezone.utc),
        expires_at=OrganizationInvite.default_expiry(INVITE_TTL_DAYS),
        is_revoked=False,
    )
    db.session.add(invite)
    db.session.commit()

    # The only response that carries the code - the client shows it as a
    # copyable join link immediately.
    return jsonify(invite.to_dict(include_code=True)), 201


@organizations_bp.delete("/invites/<int:invite_id>")
@jwt_required()
@limiter.limit("20 per minute")
def revoke_invite(invite_id: int):
    coach = require_admin()
    invite = OrganizationInvite.query.filter_by(
        id=invite_id, organization_id=coach.organization_id
    ).first()
    if invite is None:
        raise ApiError("Invite not found", status_code=404)

    invite.is_revoked = True
    db.session.commit()
    return "", 204


@organizations_bp.patch("/members/<int:coach_id>")
@jwt_required()
@limiter.limit("20 per minute")
def update_member_role(coach_id: int):
    admin = require_admin()
    data = load_json_body(MemberRoleUpdateSchema())
    member = _get_org_member(coach_id, admin.organization_id)

    new_role = CoachRole(data["role"])
    # Demoting the last admin would leave the org unable to invite, promote,
    # or manage anyone ever again.
    if (
        member.role == CoachRole.ADMIN
        and new_role == CoachRole.MEMBER
        and _admin_count(admin.organization_id) <= 1
    ):
        raise ApiError("An organization must keep at least one admin", status_code=422)

    member.role = new_role
    db.session.commit()
    return jsonify(_member_dict(member))


@organizations_bp.delete("/members/<int:coach_id>")
@jwt_required()
@limiter.limit("20 per minute")
def remove_member(coach_id: int):
    admin = require_admin()
    member = _get_org_member(coach_id, admin.organization_id)

    if member.id == admin.id:
        raise ApiError("You cannot remove yourself from the organization", status_code=422)
    if member.role == CoachRole.ADMIN and _admin_count(admin.organization_id) <= 1:
        raise ApiError("An organization must keep at least one admin", status_code=422)

    # SILENT ORPHANING IS THE THING THIS GUARD EXISTS TO PREVENT.
    #
    # quizzes.coach_id is ON DELETE SET NULL, so removing a coach used to
    # quietly hand their quizzes to nobody. That was harmless when every quiz
    # was visible org-wide. Now that Coach View is own-only, a quiz owned by
    # nobody appears in nobody's list - it would still exist, still be live,
    # still be answerable by players, and no one would ever find it again.
    #
    # So the removal is refused until the quizzes have somewhere to go. The
    # refusal is actionable rather than a dead end: pass `reassign_quizzes_to`
    # and the transfer and the removal happen together.
    owned = Quiz.query.filter_by(coach_id=member.id).all()
    if owned:
        payload = request.get_json(silent=True) or {}
        target_id = payload.get("reassign_quizzes_to")

        if target_id is None:
            raise ApiError(
                f"{member.username} owns {len(owned)} "
                f"{'quiz' if len(owned) == 1 else 'quizzes'}. Reassign them to another "
                "coach first, or choose someone to take them over as part of removing "
                "this coach.",
                status_code=409,
                reason="owns_quizzes",
                details={
                    "quiz_count": len(owned),
                    "quizzes": [{"id": q.id, "title": q.title} for q in owned],
                },
            )

        # Resolved inside this organization, so a coach id from elsewhere
        # cannot be named as the new owner.
        new_owner = _get_org_member(int(target_id), admin.organization_id)
        if new_owner.id == member.id:
            raise ApiError(
                "Choose a different coach to take over these quizzes", status_code=422
            )
        for quiz in owned:
            quiz.coach_id = new_owner.id

        # Flush the transfer, then forget `member.quizzes`.
        #
        # Coach.quizzes has no passive_deletes, so on db.session.delete(member)
        # SQLAlchemy loads that collection and nulls each row's coach_id
        # itself - silently undoing the reassignment above and orphaning the
        # very quizzes this guard exists to protect. Expiring the collection
        # makes it reload as empty (the quizzes belong to someone else now),
        # so there is nothing left for the delete to null.
        db.session.flush()
        db.session.expire(member, ["quizzes"])

    # Folders and groups still fall to the FK's SET NULL, and that stays
    # correct: they are org-shared infrastructure that any coach can see and
    # edit, so an unowned one is not hidden from anybody.
    db.session.delete(member)
    db.session.commit()
    return "", 204


# ---------------------------------------------------------------------------
# ADMIN VIEW
#
# The organization-wide surface, and the ONLY place it exists. Every coach
# endpoint elsewhere is own-only for everyone including admins, so this is not
# "the normal list with a wider filter" - it is a different screen with
# different questions: whose is this, who has what, what is unowned.
#
# Every route here goes through require_admin(), and every one resolves the
# organization from the authenticated admin rather than from the URL, so
# cross-organization access is not something to authorize - it is something
# that cannot be expressed.
# ---------------------------------------------------------------------------


@organizations_bp.get("/quizzes")
@jwt_required()
def list_organization_quizzes():
    """Every quiz in the admin's organization, with its owner.

    Includes UNASSIGNED quizzes (coach_id IS NULL). That is the whole reason
    an ownerless quiz is not lost: Coach View shows a coach their own quizzes,
    so a quiz belonging to nobody appears in nobody's list. Here it appears
    with owner null and can be reassigned.
    """
    admin = require_admin()

    query = Quiz.query.filter(Quiz.organization_id == admin.organization_id).options(
        selectinload(Quiz.questions), selectinload(Quiz.coach)
    )

    # Filter by coach. "unassigned" is a first-class value rather than a
    # separate endpoint, because "show me what nobody owns" is the same
    # question as "show me what Dave owns" from the admin's point of view.
    coach_filter = (request.args.get("coach_id") or "").strip()
    if coach_filter == "unassigned":
        query = query.filter(Quiz.coach_id.is_(None))
    elif coach_filter:
        try:
            query = query.filter(Quiz.coach_id == int(coach_filter))
        except ValueError:
            raise ApiError("coach_id must be a number or 'unassigned'", status_code=422) from None

    # Search. Server-side here (unlike the dashboard, which filters a list it
    # already has) because an organization's full quiz list is the one that
    # can actually get long.
    search = (request.args.get("q") or "").strip()
    if search:
        pattern = f"%{search}%"
        query = query.filter(
            db.or_(Quiz.title.ilike(pattern), Quiz.description.ilike(pattern))
        )

    quizzes = query.order_by(Quiz.updated_at.desc()).all()

    # The organization's folders come back in the SAME response, unfiltered.
    #
    # Admin View renders a tree and needs the whole shape of it - names,
    # parents, and the branches that hold nothing - and it needs that shape
    # before the admin expands anything. Fetching folders separately, or a
    # level at a time as branches open, would mean a request per expand and a
    # window where the two halves disagree. One request, then every expand,
    # filter and search is instant and local.
    #
    # Sized for the real case: hundreds of quizzes and tens of folders is a
    # small JSON document. If an organization ever outgrows that, the server
    # already accepts coach_id and q to narrow it.
    folders = (
        Folder.query.filter_by(organization_id=admin.organization_id)
        .order_by(Folder.name)
        .all()
    )

    return jsonify(
        {
            "folders": [folder.to_dict() for folder in folders],
            "quizzes": [
                {
                    **quiz.to_dict(),
                    # Ownership is the point of this screen, so it is explicit
                    # rather than inferred from created_by_username being null.
                    "owner": (
                        {"id": quiz.coach.id, "username": quiz.coach.username}
                        if quiz.coach
                        else None
                    ),
                    "is_unassigned": quiz.coach_id is None,
                }
                for quiz in quizzes
            ],
        }
    )


@organizations_bp.patch("/quizzes/<int:quiz_id>/owner")
@jwt_required()
def transfer_quiz_owner(quiz_id: int):
    """Reassign a quiz to another coach in the organization.

    EXPLICIT, never a side effect. Ownership decides who sees a quiz in their
    Coach View, so changing it silently - on edit, on duplicate, on anything -
    would make quizzes appear and disappear from people's dashboards for
    reasons they could not see. This is the only route that changes it.
    """
    admin = require_admin()
    quiz = Quiz.query.filter_by(id=quiz_id, organization_id=admin.organization_id).first()
    if quiz is None:
        raise ApiError("Quiz not found", status_code=404)

    data = load_json_body(QuizOwnerUpdateSchema())
    # Re-resolved inside the admin's own organization, so a coach id from
    # another organization cannot be assigned even if one is guessed.
    new_owner = _get_org_member(data["coach_id"], admin.organization_id)

    quiz.coach_id = new_owner.id
    db.session.commit()
    return jsonify(
        {
            **quiz.to_dict(),
            "owner": {"id": new_owner.id, "username": new_owner.username},
            "is_unassigned": False,
        }
    )


@organizations_bp.get("/players/history")
@jwt_required()
def organization_player_history():
    """Whole-program history for a player, by name. Admin View only.

    This is where the org-wide analytics moved to, not where they were added:
    the coach route used to do this for everyone. The reasoning behind it -
    that a player's development across the whole program is the point - is
    still right, which is why the capability was preserved rather than
    dropped when Coach View became own-only.
    """
    admin = require_admin()
    player_name = (request.args.get("name") or "").strip()
    if not player_name:
        raise ApiError("Query parameter 'name' is required", status_code=400)

    from app.routes.grading import _player_history_payload

    return jsonify(_player_history_payload(admin, player_name, organization_wide=True))


@organizations_bp.get("/players/<int:player_id>/history")
@jwt_required()
def organization_player_profile(player_id: int):
    """Whole-program analytics for a canonical roster player. Admin View only."""
    admin = require_admin()

    from app.routes.players import build_player_history
    from app.utils.auth import get_org_player

    player = get_org_player(player_id)
    return jsonify(build_player_history(admin, player, organization_wide=True))
