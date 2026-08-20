"""REDEEMING A PEIRA INVITE CREATES ONE ACCOUNT AND ONE PROGRAM.

This is the first thing that USES the beta invite foundation. Until now the
table existed and nothing read it; `POST /auth/register-with-beta-invite` is
the route that turns a token into a coach with a program of their own.

WHY THIS IS NOT `/register-with-invite`
---------------------------------------
The other invite type adds a coach to an organization that ALREADY EXISTS, as
a member, and asks for no organization name because the invite supplies it.
This one creates the organization and makes the redeemer its admin, so the
name is asked for. Two endpoints rather than one endpoint with a flag - the
failure mode of confusing them is a stranger inside somebody else's program,
and `TestTheTwoInviteTypesStayApart` is what keeps them from converging.

WHAT MUST NOT SURVIVE A FAILURE
-------------------------------
Half a signup is worse than none: an organization that no invitation paid for,
or an invite spent on a typo. `TestNothingIsLeftBehind` covers both directions.

PUBLIC REGISTRATION IS STILL OPEN, DELIBERATELY. Closing it is a product
decision and is pinned here so it cannot happen as a side effect.
"""

import pytest
from sqlalchemy import create_engine, update as sa_update
from sqlalchemy.orm import Session

from app.extensions import db
from app.models import Coach, CoachRole, Organization
from app.models.beta_invite import BetaInvite
from app.services import beta_invites


@pytest.fixture
def invite_token(app):
    with app.app_context():
        _, token = beta_invites.issue(label="Coach Smith - Madeira")
        return token


def sign_up(client, token, **overrides):
    body = {
        "invite_code": token,
        "username": "coachsmith",
        "email": "smith@example.com",
        "password": "password123",
        "organization": "Madeira Mustangs",
    }
    body.update(overrides)
    return client.post("/api/auth/register-with-beta-invite", json=body)


class TestTheOrdinaryPath:
    def test_it_creates_a_coach_who_runs_their_own_program(self, app, client, invite_token):
        created = sign_up(client, invite_token)

        assert created.status_code == 201, created.get_json()
        with app.app_context():
            coach = Coach.query.filter_by(username="coachsmith").one()
            # ADMIN, not MEMBER. A one-person program whose only coach cannot
            # invite anyone would be unusable from its first minute.
            assert coach.role is CoachRole.ADMIN
            assert db.session.get(Organization, coach.organization_id).name == "Madeira Mustangs"

    def test_it_logs_them_straight_in(self, client, invite_token):
        """No second trip to the login screen holding a password they typed
        thirty seconds ago."""
        body = sign_up(client, invite_token).get_json()

        assert body["access_token"]
        assert body["coach"]["username"] == "coachsmith"

    def test_the_invite_records_which_coach_it_produced(self, app, client, invite_token):
        """THE ONE QUESTION THIS TABLE EXISTS TO ANSWER - how did this coach
        get into the beta."""
        sign_up(client, invite_token)

        with app.app_context():
            invite = BetaInvite.query.one()
            assert invite.redeemed_at is not None
            assert invite.redeemed_by_coach_id == Coach.query.one().id
            assert invite.label == "Coach Smith - Madeira"

    @pytest.mark.parametrize(
        "mangle",
        [
            lambda t: t.lower(),
            lambda t: t.replace("-", ""),
            lambda t: f"  {t}  ",
            lambda t: t.replace("PEIRA-", ""),
        ],
    )
    def test_it_forgives_how_the_coach_typed_it(self, client, invite_token, mangle):
        """A coach retyping a code off a text message must not be told their
        invite is invalid because of case or dashes."""
        assert sign_up(client, mangle(invite_token)).status_code == 201


class TestAnInviteIsSpentOnce:
    def test_the_same_token_cannot_be_used_twice(self, client, invite_token):
        assert sign_up(client, invite_token).status_code == 201

        second = sign_up(
            client, invite_token, username="someoneelse", email="else@example.com"
        )

        assert second.status_code == 404

    def test_A_CONCURRENT_REDEMPTION_LOSES_AND_LEAVES_NOTHING(
        self, app, client, invite_token, monkeypatch
    ):
        """THE RACE, AND THE TEST THAT BITES.

        The obvious version - redeem it, then sign up - proves nothing. The
        second request looks the token up on its own connection, sees
        `redeemed_at` already set, and is refused at the LOOKUP without ever
        reaching the write. It passes against check-then-assign too. Measured
        on the organization-invite fix, where the whole file passed against the
        broken implementation.

        The race lives only in the window BETWEEN the lookup and the write, so
        the other request has to arrive inside it. Patching the lookup holds
        that window open: the route reads a genuinely usable invite, somebody
        else redeems it and commits on another connection, and only then does
        the route try to redeem what it is still holding.

        Losing must leave NO organization and NO coach. A program that no
        invitation paid for is exactly what closing public signup is meant to
        prevent.
        """
        from app.routes import auth as auth_routes

        with app.app_context():
            other_org = Organization(name="Somewhere Else")
            db.session.add(other_org)
            db.session.flush()
            winner = Coach(
                username="winner", email="winner@example.com", organization_id=other_org.id
            )
            winner.set_password("password123")
            db.session.add(winner)
            db.session.commit()
            winner_id = winner.id
            orgs_before = Organization.query.count()
            coaches_before = Coach.query.count()
            # render_as_string, not str(): str() masks the password, and a
            # second engine built from a masked URL cannot authenticate.
            url = db.engine.url.render_as_string(hide_password=False)

        real_lookup = beta_invites.find_usable

        def lookup_then_lose_the_race(candidate):
            found = real_lookup(candidate)
            if found is not None:
                other = create_engine(url)
                try:
                    with Session(other) as elsewhere:
                        elsewhere.execute(
                            sa_update(BetaInvite)
                            .where(
                                BetaInvite.id == found.id,
                                BetaInvite.redeemed_at.is_(None),
                            )
                            .values(redeemed_at=BetaInvite.now(), redeemed_by_coach_id=winner_id)
                        )
                        elsewhere.commit()
                finally:
                    other.dispose()
            return found

        monkeypatch.setattr(
            auth_routes.beta_invites, "find_usable", lookup_then_lose_the_race
        )

        refused = sign_up(client, invite_token)

        assert refused.status_code == 404, refused.get_json()
        with app.app_context():
            assert Organization.query.count() == orgs_before, "a program outlived the lost race"
            assert Coach.query.count() == coaches_before, "a coach outlived the lost race"
            assert Organization.query.filter_by(name="Madeira Mustangs").first() is None
            # The winner's record stands. A read-then-write would overwrite it
            # with the loser, so the owner could not say who used the invite.
            assert BetaInvite.query.one().redeemed_by_coach_id == winner_id


class TestNothingIsLeftBehind:
    def test_a_taken_email_does_not_burn_the_invite(self, app, client, invite_token):
        """A TYPO MUST NOT COST A COACH THEIR INVITATION. It is single use, so
        spending it on a rejected signup would mean going back to the owner for
        another one."""
        with app.app_context():
            org = Organization(name="Existing")
            db.session.add(org)
            db.session.flush()
            taken = Coach(
                username="taken", email="smith@example.com", organization_id=org.id
            )
            taken.set_password("password123")
            db.session.add(taken)
            db.session.commit()

        rejected = sign_up(client, invite_token)

        assert rejected.status_code == 409
        with app.app_context():
            assert BetaInvite.query.one().is_usable() is True

        # And the same invite still works once they fix the address.
        assert sign_up(client, invite_token, email="new@example.com").status_code == 201

    def test_a_rejected_signup_leaves_no_program(self, app, client, invite_token):
        with app.app_context():
            org = Organization(name="Existing")
            db.session.add(org)
            db.session.flush()
            taken = Coach(
                username="coachsmith", email="other@example.com", organization_id=org.id
            )
            taken.set_password("password123")
            db.session.add(taken)
            db.session.commit()
            orgs_before = Organization.query.count()

        assert sign_up(client, invite_token).status_code == 409

        with app.app_context():
            assert Organization.query.count() == orgs_before

    def test_an_invalid_token_creates_nothing(self, app, client):
        refused = sign_up(client, "PEIRA-2345-6789-ABCD")

        assert refused.status_code == 404
        with app.app_context():
            assert Organization.query.count() == 0
            assert Coach.query.count() == 0


class TestFailuresStayIndistinguishable:
    def test_unknown_revoked_and_used_read_identically(self, app, client, invite_token):
        """ONE ANSWER FOR EVERY FAILURE, so a guessed token cannot be probed
        for which invites exist."""
        with app.app_context():
            revoked_invite, revoked = beta_invites.issue()
            beta_invites.revoke(revoked_invite)
            db.session.commit()

        used = invite_token
        assert sign_up(client, used).status_code == 201

        answers = [
            sign_up(client, used, username="alpha", email="a@example.com"),
            sign_up(client, revoked, username="bravo", email="b@example.com"),
            sign_up(client, "PEIRA-2345-6789-ABCD", username="chrly", email="c@example.com"),
        ]

        assert {r.status_code for r in answers} == {404}
        assert len({r.get_json()["error"] for r in answers}) == 1

    def test_the_response_never_carries_the_token(self, client, invite_token):
        """Not the plaintext and not the hash - a hash in a payload is an
        offline guessing target."""
        body = sign_up(client, invite_token).get_data(as_text=True)

        assert beta_invites.normalise(invite_token) not in body.upper()
        assert "token_hash" not in body
        assert "invite" not in body.lower()


class TestTheTwoInviteTypesStayApart:
    def test_a_beta_token_is_not_an_organization_invite(self, client, invite_token):
        """Sent to the wrong endpoint it must simply fail, not quietly put the
        coach into whichever organization happens to match."""
        refused = client.post(
            "/api/auth/register-with-invite",
            json={
                "invite_code": invite_token,
                "username": "coachsmith",
                "email": "smith@example.com",
                "password": "password123",
            },
        )

        assert refused.status_code == 404

    def test_a_beta_signup_requires_a_program_name(self, client, invite_token):
        """The field that distinguishes the two endpoints. Without it there is
        no organization to create and no honest default to invent."""
        rejected = sign_up(client, invite_token, organization="")

        assert rejected.status_code == 422

    def test_the_redeemer_is_an_admin_not_a_member(self, app, client, invite_token):
        sign_up(client, invite_token)

        with app.app_context():
            assert Coach.query.one().role is CoachRole.ADMIN


class TestNothingElseChanged:
    def test_public_registration_is_still_open(self, client):
        """DELIBERATE, and pinned. Closing public signup is a product decision,
        not a side effect of building the invited path."""
        created = client.post(
            "/api/auth/register",
            json={
                "username": "walkup",
                "email": "walkup@example.com",
                "password": "password123",
                "organization": "Walk Up Program",
            },
        )

        assert created.status_code == 201

    def test_open_registration_still_makes_an_admin_of_a_new_org(self, app, client):
        """Both signup paths now build the account through one helper, so this
        is what catches the two drifting apart."""
        client.post(
            "/api/auth/register",
            json={
                "username": "walkup",
                "email": "walkup@example.com",
                "password": "password123",
                "organization": "Walk Up Program",
            },
        )

        with app.app_context():
            coach = Coach.query.one()
            assert coach.role is CoachRole.ADMIN
            assert db.session.get(Organization, coach.organization_id).name == "Walk Up Program"
