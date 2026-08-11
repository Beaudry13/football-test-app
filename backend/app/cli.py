"""Operator CLI commands.

`flask owner grant|revoke|list` is how platform ownership is conferred.

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
from app.models import Coach

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


def register_cli(app: Flask) -> None:
    app.cli.add_command(owner_cli)
