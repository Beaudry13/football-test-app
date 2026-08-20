"""Operator CLI commands.

`flask owner grant|revoke|list` is how platform ownership is conferred.
`flask staff-invite list|approve|decline` is how a coach's request for a
colleague becomes an actual invitation.
`flask access-request list` shows who has asked to be let in, and which
existing programs each request MIGHT already be.
`flask beta-invite issue|list|revoke` hands somebody a way into Peira.

WHY A COMMAND AND NOT A MIGRATION OR AN ENV VAR
------------------------------------------------
A migration that hardcoded an email would put a personal address in the repo
permanently and could never express a second owner. An env var checked at
request time is `if email == "..."` wearing a hat: a typo silently grants or
revokes access, and nothing records that it happened.

A command is explicit, repeatable, reviewable, and refuses on an unknown
address instead of quietly doing nothing. Run it once from a Render shell.
"""

import click
from flask import Flask
from flask.cli import AppGroup

from app.extensions import db
from app.models import AccessRequest, Coach, Organization, StaffInviteRequest
from app.models.beta_invite import BetaInvite
from app.services import beta_invites, similar_organizations, staff_invite_requests

owner_cli = AppGroup("owner", help="Manage Peira platform owners.")


def _find(email: str) -> Coach:
    """Look up by email, case-insensitively.

    Refuses rather than returning None: "granted ownership to nobody" looks
    identical to success on a terminal, and this is the one command where
    that ambiguity is dangerous.
    """
    coach = Coach.query.filter(db.func.lower(Coach.email) == email.strip().lower()).first()
    if coach is None:
        raise click.ClickException(f"No coach account with email {email!r}")
    return coach


@owner_cli.command("grant")
@click.argument("email")
def grant(email: str):
    """Make an existing coach account a Peira platform owner."""
    coach = _find(email)
    if coach.is_platform_owner:
        click.echo(f"{coach.email} is already a platform owner - nothing to do.")
        return
    coach.is_platform_owner = True
    db.session.commit()
    click.echo(f"Granted platform ownership to {coach.email} (coach id {coach.id}).")
    click.echo("Their Coach View and organization role are unchanged.")


@owner_cli.command("revoke")
@click.argument("email")
def revoke(email: str):
    """Remove platform ownership. The coach account itself is untouched."""
    coach = _find(email)
    if not coach.is_platform_owner:
        click.echo(f"{coach.email} is not a platform owner - nothing to do.")
        return
    coach.is_platform_owner = False
    db.session.commit()
    click.echo(f"Revoked platform ownership from {coach.email} (coach id {coach.id}).")


@owner_cli.command("list")
def list_owners():
    """Show every platform owner. Answers "who can see the Owner Dashboard"."""
    owners = Coach.query.filter(Coach.is_platform_owner.is_(True)).order_by(Coach.id).all()
    if not owners:
        click.echo("No platform owners. Grant one with: flask owner grant <email>")
        return
    click.echo(f"{len(owners)} platform owner(s):")
    for coach in owners:
        click.echo(f"  #{coach.id}  {coach.email}  ({coach.username})")


staff_invite_cli = AppGroup(
    "staff-invite", help="Review coaches' requests to add staff to their organization."
)

#: WHY A COMMAND AND NOT A SCREEN
#: ------------------------------
#: Approving is a rare, deliberate, one-person act during Early Access - a
#: handful of requests, reviewed by the owner, from a Render shell. A screen
#: for it would be a queue, a filter, a detail view and an empty state: an
#: admin console built before there was anything to administer, and the start
#: of the CRM this product keeps deciding not to have.
#:
#: The moment this is genuinely tedious is the moment it has earned a screen.
#: Nothing here blocks building one later - the service holds the rules and a
#: route would call the same three functions.


def _pending_or_fail(request_id: int) -> StaffInviteRequest:
    """Refuses rather than returning None. "Approved nobody" and "approved the
    coach you meant" look identical on a terminal, and this is a command that
    hands out access."""
    request = db.session.get(StaffInviteRequest, request_id)
    if request is None:
        raise click.ClickException(f"No staff invite request with id {request_id}")
    if not request.is_pending():
        state = "approved" if request.approved_at else "declined"
        raise click.ClickException(f"Request #{request_id} was already {state} - nothing to do.")
    return request


@staff_invite_cli.command("list")
def list_requests():
    """Show every staff invite request still waiting on a decision."""
    requests = staff_invite_requests.pending()
    if not requests:
        click.echo("No staff invite requests waiting.")
        return
    click.echo(f"{len(requests)} request(s) waiting:")
    for request in requests:
        org = db.session.get(Organization, request.organization_id)
        asked_by = db.session.get(Coach, request.requested_by_coach_id)
        click.echo(
            f"  #{request.id}  {request.name} <{request.email}>"
            f"  -> {org.name} (org {org.id})"
            f"  asked by {asked_by.email if asked_by else 'a deleted account'}"
            f"  on {request.requested_at:%Y-%m-%d}"
        )
    click.echo("")
    click.echo("Approve with: flask staff-invite approve <id>")


@staff_invite_cli.command("approve")
@click.argument("request_id", type=int)
@click.option("--as-owner", default=None, help="Email of the owner recording the decision.")
def approve(request_id: int, as_owner: str | None):
    """Mint the single-use invite this request asked for, and print its link.

    THE LINK IS PRINTED ONCE, HERE. Peira sends no email - delivering it is
    still a human act, which at Early Access volume is a feature rather than a
    gap: somebody reads the request, decides, and sends it themselves.
    """
    request = _pending_or_fail(request_id)
    org = db.session.get(Organization, request.organization_id)
    approver = _find(as_owner) if as_owner else None

    code = staff_invite_requests.approve(request, approved_by=approver)
    if code is None:
        raise click.ClickException(
            f"Request #{request_id} was decided by somebody else just now - no invite created."
        )

    click.echo(f"Approved #{request_id}: {request.name} <{request.email}>")
    click.echo(f"They will join {org.name} (org {org.id}) as a MEMBER.")
    click.echo("They are never asked to type a program name, so no duplicate can appear.")
    click.echo("")
    click.echo("Send them this link. It works once and expires in 14 days:")
    click.echo(f"  /join/{code}")


@staff_invite_cli.command("decline")
@click.argument("request_id", type=int)
def decline(request_id: int):
    """Record that a request was not granted. Creates no invite, sends nothing.

    Not a ban: the same person can be requested again, because the uniqueness
    rule only covers requests still waiting.
    """
    request = _pending_or_fail(request_id)
    if not staff_invite_requests.decline(request):
        raise click.ClickException(
            f"Request #{request_id} was decided by somebody else just now."
        )
    click.echo(f"Declined #{request_id}: {request.name} <{request.email}>. No invite was created.")


access_request_cli = AppGroup(
    "access-request", help="Review people who have asked to be let into Peira."
)


@access_request_cli.command("list")
@click.option("--limit", default=50, show_default=True, help="How many to show.")
def list_access_requests(limit: int):
    """Who has asked for access, and which existing programs they might be.

    THE SIMILAR-NAME LIST IS A HINT FOR A HUMAN, NEVER AN ACTION. Nothing is
    merged, linked or pre-filled from it. It exists so the decision - does this
    person start a new program, or should they be sent a staff invite into one
    that already exists - is made with the duplicate in view rather than
    discovered six weeks later.

    `AccessRequest` is the only path where somebody still TYPES a program name;
    they have no account yet, so there is nothing to copy it from. Everyone
    joining an existing program via a staff invite never types one at all.
    """
    requests = (
        AccessRequest.query.order_by(AccessRequest.requested_at.desc()).limit(limit).all()
    )
    if not requests:
        click.echo("No access requests yet.")
        return

    click.echo(f"{len(requests)} access request(s), newest first:")
    for request in requests:
        click.echo("")
        click.echo(f"  #{request.id}  {request.name} <{request.email}>")
        click.echo(f"      asked {request.requested_at:%Y-%m-%d}")
        click.echo(f"      team:  {request.team or '(not given)'}")

        matches = similar_organizations.candidates_for(request.team)
        if not matches:
            click.echo("      POSSIBLE EXISTING: none found")
            continue
        click.echo("      POSSIBLE EXISTING PROGRAM(S):")
        for match in matches:
            coaches = match["coach_count"]
            click.echo(
                f"        - {match['name']}  (org {match['organization_id']}, "
                f"{coaches} coach{'' if coaches == 1 else 'es'})"
            )
    click.echo("")
    click.echo("These are name similarities only - nothing has been merged or linked.")
    click.echo("If one is the same program, ask a coach there to request a staff invite.")


beta_invite_cli = AppGroup("beta-invite", help="Issue and manage Early Access invitations.")

#: WHY THIS COMMAND HAD TO EXIST
#: -----------------------------
#: The beta invite model, its service and its signup screen all shipped before
#: anything could CREATE one outside a Python shell - so the Early Access front
#: door had a lock, a key and a door, and no way to cut a key. `flask shell`
#: plus a hand-typed `beta_invites.issue()` is the exact thing the `flask
#: owner` docstring says a command exists to replace: explicit, repeatable,
#: reviewable, and hard to do by accident.


@beta_invite_cli.command("issue")
@click.option("--label", default=None, help='Your own note - e.g. "Coach Smith - Madeira".')
@click.option("--as-owner", default=None, help="Email of the owner issuing it.")
def issue_beta_invite(label: str | None, as_owner: str | None):
    """Create ONE invitation and print its link. The token is shown once.

    IT CANNOT BE SHOWN AGAIN. Only a hash is stored, so a lost invite is
    revoked and reissued rather than looked up - which is what makes a stolen
    database worth nothing. Copy it now.
    """
    issuer = _find(as_owner) if as_owner else None
    invite, token = beta_invites.issue(
        label=label, created_by_coach_id=issuer.id if issuer else None
    )

    click.echo(f"Issued invite #{invite.id}" + (f" for {invite.label}" if invite.label else ""))
    click.echo("")
    click.echo("Send them this link. It works ONCE and creates their account and program:")
    click.echo(f"  /invite/{token}")
    click.echo("")
    click.echo("This is the only time the code is shown. It is not recoverable.")


@beta_invite_cli.command("list")
def list_beta_invites():
    """Every invitation and what became of it.

    Answers the question the table exists for - how did this coach get into
    the beta - without ever showing a token that could still be used.
    """
    invites = BetaInvite.query.order_by(BetaInvite.id).all()
    if not invites:
        click.echo("No beta invites yet. Create one with: flask beta-invite issue --label '...'")
        return

    click.echo(f"{len(invites)} invite(s):")
    for invite in invites:
        if invite.redeemed_at:
            coach = db.session.get(Coach, invite.redeemed_by_coach_id)
            state = f"redeemed {invite.redeemed_at:%Y-%m-%d} by {coach.email if coach else 'a deleted account'}"
        elif invite.revoked_at:
            state = f"revoked {invite.revoked_at:%Y-%m-%d}"
        else:
            state = "UNUSED"
        click.echo(f"  #{invite.id}  {invite.token_prefix}...  {invite.label or '(no note)'}  - {state}")


@beta_invite_cli.command("revoke")
@click.argument("invite_id", type=int)
def revoke_beta_invite(invite_id: int):
    """Stop an unused invitation working. Refuses one already redeemed.

    History must not say an invite was cancelled when somebody used it, which
    is why this can fail - see services/beta_invites.revoke.
    """
    invite = db.session.get(BetaInvite, invite_id)
    if invite is None:
        raise click.ClickException(f"No beta invite with id {invite_id}")
    if not beta_invites.revoke(invite):
        raise click.ClickException(
            f"Invite #{invite_id} was already redeemed or revoked - nothing to do."
        )
    db.session.commit()
    click.echo(f"Revoked invite #{invite_id}. It can no longer be used.")


def register_cli(app: Flask) -> None:
    app.cli.add_command(owner_cli)
    app.cli.add_command(staff_invite_cli)
    app.cli.add_command(access_request_cli)
    app.cli.add_command(beta_invite_cli)
