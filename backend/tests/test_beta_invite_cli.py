"""THE ONLY WAY TO CUT A KEY FOR THE EARLY ACCESS FRONT DOOR.

WHY THIS EXISTS
---------------
The beta invite model, its service and its signup screen all shipped before
anything could CREATE one outside a Python shell. Peira had a lock, a door and
a key-shaped hole, and no way to cut a key - so nobody could actually be let
into the beta without hand-typing `beta_invites.issue()` at a `flask shell`.

That is exactly what the `flask owner` docstring says a command exists to
replace: explicit, repeatable, reviewable, and hard to do by accident.

WHAT THE TESTS GUARD
--------------------
`TestTheTokenIsShownOnceAndNeverAgain` is the one that matters. Only a hash is
stored, so the plaintext exists for exactly the length of one command's output.
A `list` that leaked it would undo the reason the hash exists.
"""

import pytest

from app.extensions import db
from app.models import Coach, Organization
from app.models.beta_invite import BetaInvite
from app.services import beta_invites


@pytest.fixture
def owner(app):
    with app.app_context():
        org = Organization(name="Peira HQ")
        db.session.add(org)
        db.session.flush()
        coach = Coach(username="owner", email="owner@example.com", organization_id=org.id)
        coach.set_password("password123")
        coach.is_platform_owner = True
        db.session.add(coach)
        db.session.commit()
        return coach.email


def run(app, *args):
    return app.test_cli_runner().invoke(args=list(args))


class TestIssuing:
    def test_it_prints_a_usable_join_link(self, app):
        result = run(app, "beta-invite", "issue", "--label", "Coach Smith - Madeira")

        assert result.exit_code == 0, result.output
        assert "/invite/PEIRA-" in result.output
        assert "Coach Smith - Madeira" in result.output

        # The printed token must actually work, not merely look right.
        printed = result.output.split("/invite/")[1].split()[0]
        with app.app_context():
            assert beta_invites.find_usable(printed) is not None

    def test_it_records_who_issued_it(self, app, owner):
        result = run(app, "beta-invite", "issue", "--as-owner", owner)

        assert result.exit_code == 0, result.output
        with app.app_context():
            issuer = db.session.get(Coach, BetaInvite.query.one().created_by_coach_id)
            assert issuer.email == owner

    def test_an_unknown_issuer_is_REFUSED_rather_than_ignored(self, app):
        """"Issued by nobody" and "issued by the owner you meant" look
        identical on a terminal, and this command hands out access."""
        result = run(app, "beta-invite", "issue", "--as-owner", "nobody@example.com")

        assert result.exit_code != 0
        assert "No coach account" in result.output
        with app.app_context():
            assert BetaInvite.query.count() == 0

    def test_a_note_is_optional(self, app):
        result = run(app, "beta-invite", "issue")

        assert result.exit_code == 0, result.output
        with app.app_context():
            assert BetaInvite.query.one().label is None


class TestTheTokenIsShownOnceAndNeverAgain:
    def test_LIST_NEVER_PRINTS_A_USABLE_TOKEN(self, app):
        """THE PROPERTY THE HASH EXISTS FOR. If `list` leaked the plaintext,
        storing only a digest would have bought nothing."""
        issued = run(app, "beta-invite", "issue", "--label", "Coach Smith")
        token = issued.output.split("/invite/")[1].split()[0]

        listed = run(app, "beta-invite", "list")

        assert listed.exit_code == 0, listed.output
        assert token not in listed.output
        assert beta_invites.normalise(token) not in listed.output.upper()

    def test_list_shows_enough_to_tell_two_invites_apart(self, app):
        run(app, "beta-invite", "issue", "--label", "Coach Smith")
        run(app, "beta-invite", "issue", "--label", "Coach Jones")

        listed = run(app, "beta-invite", "list")

        assert "Coach Smith" in listed.output
        assert "Coach Jones" in listed.output
        assert listed.output.count("UNUSED") == 2

    def test_list_says_who_used_one(self, app, owner):
        with app.app_context():
            invite, _ = beta_invites.issue(label="Coach Smith")
            coach = Coach.query.filter_by(email=owner).one()
            beta_invites.redeem(invite, coach.id)
            db.session.commit()

        listed = run(app, "beta-invite", "list")

        assert "redeemed" in listed.output
        assert owner in listed.output

    def test_list_says_so_plainly_when_there_are_none(self, app):
        listed = run(app, "beta-invite", "list")

        assert listed.exit_code == 0
        assert "No beta invites yet" in listed.output


class TestRevoking:
    def test_an_unused_invite_stops_working(self, app):
        issued = run(app, "beta-invite", "issue")
        token = issued.output.split("/invite/")[1].split()[0]
        with app.app_context():
            invite_id = BetaInvite.query.one().id

        result = run(app, "beta-invite", "revoke", str(invite_id))

        assert result.exit_code == 0, result.output
        with app.app_context():
            assert beta_invites.find_usable(token) is None

    def test_A_REDEEMED_INVITE_CANNOT_BE_REVOKED(self, app, owner):
        """History must not say an invitation was cancelled when somebody
        used it."""
        with app.app_context():
            invite, _ = beta_invites.issue()
            coach = Coach.query.filter_by(email=owner).one()
            beta_invites.redeem(invite, coach.id)
            db.session.commit()
            invite_id = invite.id

        result = run(app, "beta-invite", "revoke", str(invite_id))

        assert result.exit_code != 0
        assert "already redeemed" in result.output
        with app.app_context():
            assert db.session.get(BetaInvite, invite_id).revoked_at is None

    def test_an_unknown_id_is_refused(self, app):
        result = run(app, "beta-invite", "revoke", "999999")

        assert result.exit_code != 0
        assert "No beta invite with id 999999" in result.output


class TestNothingElseChanged:
    def test_issuing_creates_no_account_and_no_program(self, app):
        """An invitation is a way IN, not a way in already taken."""
        run(app, "beta-invite", "issue")

        with app.app_context():
            assert Coach.query.count() == 0
            assert Organization.query.count() == 0
