"""A SINGLE-USE ORGANIZATION INVITE MUST ADMIT ONE PERSON.

THE BUG
-------
`register_with_invite` read the invite with `find_usable_invite`, created the
coach, and only then assigned `accepted_at`. Two people opening the same link
could both pass the read and both get an account inside the organization -
a single-use invitation admitting two people to a program's data, with
`accepted_by_coach_id` recording whichever request committed last.

Found while building beta invites, which avoid this by construction. Fixed the
same way: the claim is a conditional UPDATE, so the database decides who won,
and the loser's half-made coach is rolled back.

WHY THE OBVIOUS TEST IS NOT ENOUGH
----------------------------------
Two redemptions in one session pass against the broken code too - the second
re-reads an object the first already mutated in memory. Measured on the beta
invite work, where the naive implementation passed every test until a second
CONNECTION was involved. A real race is two requests that cannot see each
other's uncommitted work, which is what `TestTwoPeopleOneLink` sets up.
"""

import pytest
from sqlalchemy import create_engine, update as sa_update
from sqlalchemy.orm import Session

from app.extensions import db
from app.models import Coach, Organization, OrganizationInvite
from app.services.invites import INVITE_TTL_DAYS


@pytest.fixture
def invite_code(app):
    with app.app_context():
        org = Organization(name="Wildcats")
        db.session.add(org)
        db.session.flush()
        inviter = Coach(
            username="admin1", email="admin1@example.com", organization_id=org.id
        )
        inviter.set_password("password123")
        db.session.add(inviter)
        db.session.flush()
        invite = OrganizationInvite(
            organization_id=org.id,
            code="test-invite-token-for-the-race",
            created_by_coach_id=inviter.id,
            created_at=OrganizationInvite.default_expiry(0),
            expires_at=OrganizationInvite.default_expiry(INVITE_TTL_DAYS),
        )
        db.session.add(invite)
        db.session.commit()
        return invite.code


def signup(client, code, username="newcoach", email="new@example.com"):
    return client.post(
        "/api/auth/register-with-invite",
        json={
            "invite_code": code,
            "username": username,
            "email": email,
            "password": "password123",
        },
    )


class TestTheOrdinaryPath:
    def test_a_valid_invite_creates_a_coach_in_that_organization(self, app, client, invite_code):
        created = signup(client, invite_code)

        assert created.status_code == 201, created.get_json()
        with app.app_context():
            invite = OrganizationInvite.query.filter_by(code=invite_code).one()
            coach = db.session.get(Coach, invite.accepted_by_coach_id)
            assert coach.username == "newcoach"
            assert coach.organization_id == invite.organization_id
            assert invite.accepted_at is not None

    def test_the_same_invite_cannot_be_used_twice(self, client, invite_code):
        assert signup(client, invite_code).status_code == 201

        second = signup(client, invite_code, username="another", email="another@example.com")

        assert second.status_code == 404


class TestTwoPeopleOneLink:
    def test_A_CLAIM_ON_ANOTHER_CONNECTION_LOSES(self, app, invite_code):
        """The primitive, exercised directly.

        Another request accepts the invite and commits on its own connection
        while this one is still holding an invite it read a moment earlier and
        believes is usable. The stale view is the whole point - a
        check-then-assign cannot tell the difference.

        This one proves `claim` behaves; it does NOT discriminate against the
        old route, because it calls a function the old route never had.
        `test_THE_LOSER_GETS_NO_ACCOUNT` is the test that bites.
        """
        from app.services.invites import claim, find_usable_invite

        with app.app_context():
            # The intruder is created FIRST, and committed, because a commit
            # expires every object in the session - doing this afterwards would
            # refresh `mine` from the database and dissolve the very stale view
            # the test is built around.
            org_id = OrganizationInvite.query.filter_by(code=invite_code).one().organization_id
            intruder = Coach(
                username="intruder",
                email="intruder@example.com",
                organization_id=org_id,
            )
            intruder.set_password("password123")
            db.session.add(intruder)
            db.session.commit()
            intruder_id = intruder.id

            # What this request read a moment before the other one arrived.
            mine = find_usable_invite(invite_code)
            assert mine is not None, "this request read a usable invite"

            # render_as_string, not str(): str() masks the password, and a
            # second engine built from a masked URL cannot authenticate.
            other = create_engine(db.engine.url.render_as_string(hide_password=False))
            try:
                with Session(other) as elsewhere:
                    elsewhere.execute(
                        sa_update(OrganizationInvite)
                        .where(
                            OrganizationInvite.id == mine.id,
                            OrganizationInvite.accepted_at.is_(None),
                        )
                        .values(
                            accepted_at=OrganizationInvite.default_expiry(0),
                            accepted_by_coach_id=intruder_id,
                        )
                    )
                    elsewhere.commit()
            finally:
                other.dispose()

            # This session's object still says usable. The row does not.
            assert mine.is_usable() is True, "the stale view is the point"

            assert claim(mine, intruder_id) is False

    def test_THE_LOSER_GETS_NO_ACCOUNT(self, app, client, invite_code, monkeypatch):
        """THE RACE AS A REAL REQUEST, and the test that bites.

        The obvious version of this - let somebody else accept the invite, then
        sign up - proves nothing. The second request looks the invite up on its
        own connection, sees `accepted_at` already set, and is refused at the
        LOOKUP without ever reaching the claim. It passes against
        check-then-assign too. Measured, not assumed.

        The race only exists in the window BETWEEN the lookup and the write, so
        the other request has to arrive inside that window. Patching the lookup
        is how the window is held open: the route reads a genuinely usable
        invite, somebody else accepts it and commits on another connection, and
        only then does the route try to claim what it is still holding.

        Against check-then-assign this returns 201 and leaves a second coach
        inside an organization whose single-use invitation was already spent.
        """
        from app.routes import auth as auth_routes

        with app.app_context():
            invite = OrganizationInvite.query.filter_by(code=invite_code).one()
            intruder = Coach(
                username="intruder",
                email="intruder@example.com",
                organization_id=invite.organization_id,
            )
            intruder.set_password("password123")
            db.session.add(intruder)
            db.session.commit()
            invite_id, intruder_id = invite.id, intruder.id
            before = Coach.query.count()
            # render_as_string, not str(): str() masks the password, and a
            # second engine built from a masked URL cannot authenticate.
            url = db.engine.url.render_as_string(hide_password=False)

        real_lookup = auth_routes.find_usable_invite

        def lookup_then_lose_the_race(code):
            found = real_lookup(code)
            if found is not None:
                other = create_engine(url)
                try:
                    with Session(other) as elsewhere:
                        elsewhere.execute(
                            sa_update(OrganizationInvite)
                            .where(
                                OrganizationInvite.id == invite_id,
                                OrganizationInvite.accepted_at.is_(None),
                            )
                            .values(
                                accepted_at=OrganizationInvite.default_expiry(0),
                                accepted_by_coach_id=intruder_id,
                            )
                        )
                        elsewhere.commit()
                finally:
                    other.dispose()
            return found

        monkeypatch.setattr(auth_routes, "find_usable_invite", lookup_then_lose_the_race)

        refused = signup(client, invite_code)

        assert refused.status_code == 404, refused.get_json()
        with app.app_context():
            assert Coach.query.count() == before, "a coach survived the lost race"
            assert Coach.query.filter_by(username="newcoach").first() is None
            # The winner's record stands. Check-then-assign would overwrite it
            # with the loser, so the organization could not even say who used
            # its invitation.
            stored = db.session.get(OrganizationInvite, invite_id)
            assert stored.accepted_by_coach_id == intruder_id


class TestTheWindowBetweenLookupAndClaim:
    """`claim` re-checks every condition `is_usable` does, so it cannot be
    fooled by an invite that stopped being usable after the caller looked."""

    @pytest.mark.parametrize(
        "invalidate",
        [
            pytest.param({"is_revoked": True}, id="revoked"),
            pytest.param(
                {"expires_at": OrganizationInvite.default_expiry(-1)}, id="expired"
            ),
            pytest.param(
                {"accepted_at": OrganizationInvite.default_expiry(0)}, id="accepted"
            ),
        ],
    )
    def test_an_invite_that_stopped_being_usable_cannot_be_claimed(
        self, app, invite_code, invalidate
    ):
        from app.services.invites import claim, find_usable_invite

        with app.app_context():
            found = find_usable_invite(invite_code)
            assert found is not None and found.is_usable()

            db.session.execute(
                sa_update(OrganizationInvite)
                .where(OrganizationInvite.id == found.id)
                .values(**invalidate)
            )

            assert claim(found, found.created_by_coach_id) is False


class TestFailuresStayIndistinguishable:
    @pytest.mark.parametrize("bad", ["nonexistent-token", "", "   "])
    def test_an_unknown_code_is_refused_the_same_way(self, client, bad):
        refused = signup(client, bad)

        assert refused.status_code in (404, 422)

    def test_revoked_and_used_read_identically_to_unknown(self, app, client, invite_code):
        """One message for every failure, so a guessed code cannot be probed
        for which invites exist. Unchanged by this fix, and pinned because the
        fix touches the same path."""
        with app.app_context():
            invite = OrganizationInvite.query.filter_by(code=invite_code).one()
            invite.is_revoked = True
            db.session.commit()

        revoked = signup(client, invite_code)
        unknown = signup(
            client, "no-such-token", username="othercoach", email="other@example.com"
        )

        assert revoked.status_code == unknown.status_code == 404
        assert revoked.get_json()["error"] == unknown.get_json()["error"]


class TestNothingElseChanged:
    def test_beta_invites_are_a_separate_concept(self, app):
        from app.models.beta_invite import BetaInvite

        assert OrganizationInvite.__tablename__ == "organization_invites"
        assert BetaInvite.__tablename__ == "beta_invites"

    def test_public_registration_still_works(self, client):
        created = client.post(
            "/api/auth/register",
            json={
                "username": "solo",
                "email": "solo@example.com",
                "password": "password123",
                "organization": "Solo Program",
            },
        )

        assert created.status_code == 201
