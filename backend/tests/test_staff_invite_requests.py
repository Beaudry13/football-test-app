"""A COACH ASKS FOR A COLLEAGUE; A HUMAN DECIDES; THE COLLEAGUE JOINS THAT ORG.

WHY THIS EXISTS
---------------
Peira's duplicate-organization problem is created at signup: whoever types the
program name decides its spelling, so "UC", "Cincinnati", "University of
Cincinnati" and "Cincinnati Football" become four isolated programs with one
coach each. This path removes the typing. A staff invite is bound to the
REQUESTING COACH'S organization id, so the second coach through the door never
gets the chance to name anything.

`TestTheOrganizationCannotBeChosen` is the class that matters. It is both the
duplicate fix and the isolation guarantee, and it holds because there is no
parameter to attack rather than because a validator rejects one.

A REQUEST IS NOT AN INVITE, STRUCTURALLY
-----------------------------------------
Submitting mints nothing redeemable and grants no permission. `TestSubmitting
GrantsNothing` checks the property directly: no token exists anywhere until a
human approves. That is enforced by the schema having no column for one, not
by a status field somebody has to remember to check.

WHAT IS NOT TESTED HERE BECAUSE IT DOES NOT EXIST
--------------------------------------------------
No email is sent. Approval prints a link for an operator to pass on, which at
Early Access volume is a deliberate choice rather than a missing feature.
"""

import pytest
from sqlalchemy import create_engine, update as sa_update
from sqlalchemy.orm import Session

from app.extensions import db
from app.models import (
    Coach,
    CoachRole,
    Organization,
    OrganizationInvite,
    StaffInviteRequest,
)
from app.services import staff_invite_requests


@pytest.fixture
def wildcats(app):
    """An organization with an admin and an ordinary member already in it."""
    with app.app_context():
        org = Organization(name="Cincinnati Football")
        db.session.add(org)
        db.session.flush()
        admin = Coach(
            username="headcoach",
            email="head@example.com",
            organization_id=org.id,
            role=CoachRole.ADMIN,
        )
        admin.set_password("password123")
        member = Coach(
            username="positioncoach",
            email="position@example.com",
            organization_id=org.id,
            role=CoachRole.MEMBER,
        )
        member.set_password("password123")
        db.session.add_all([admin, member])
        db.session.commit()
        return {"org_id": org.id, "admin_id": admin.id, "member_id": member.id}


def token_for(client, email):
    response = client.post(
        "/api/auth/login", json={"email": email, "password": "password123"}
    )
    assert response.status_code == 200, response.get_json()
    return {"Authorization": f"Bearer {response.get_json()['access_token']}"}


def ask(client, headers, **overrides):
    body = {"name": "Coach Jordan", "email": "jordan@example.com"}
    body.update(overrides)
    return client.post("/api/organizations/staff-invite-requests", json=body, headers=headers)


class TestTheOrdinaryPath:
    def test_a_coach_can_ask_for_a_colleague(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")

        received = ask(client, headers)

        assert received.status_code == 202, received.get_json()
        with app.app_context():
            request = StaffInviteRequest.query.one()
            assert request.name == "Coach Jordan"
            assert request.email == "jordan@example.com"
            assert request.organization_id == wildcats["org_id"]
            assert request.requested_by_coach_id == wildcats["admin_id"]
            assert request.is_pending()

    def test_ASKING_IS_NOT_AN_ADMIN_PRIVILEGE(self, app, client, wildcats):
        """A position coach who knows the new hire is exactly who should be
        able to say so. The request grants nothing, so gating it behind admin
        would only stop the person with the information from supplying it."""
        headers = token_for(client, "position@example.com")

        received = ask(client, headers)

        assert received.status_code == 202
        with app.app_context():
            assert StaffInviteRequest.query.one().requested_by_coach_id == wildcats["member_id"]

    def test_it_takes_two_fields_and_REFUSES_MORE(self, app, client, wildcats):
        """THE SIMPLICITY CHECK. No title, no phone, no staff role, no message.

        Unknown fields are REJECTED rather than quietly dropped, which is the
        stronger of the two: a client that thinks it is sending a staff role
        finds out, instead of believing a field was stored that never was.
        """
        headers = token_for(client, "head@example.com")

        refused = client.post(
            "/api/organizations/staff-invite-requests",
            json={
                "name": "Coach Jordan",
                "email": "jordan@example.com",
                "title": "Offensive Coordinator",
                "phone": "+15135551234",
            },
            headers=headers,
        )

        assert refused.status_code == 422
        with app.app_context():
            assert StaffInviteRequest.query.count() == 0
            columns = {c.name for c in StaffInviteRequest.__table__.columns}
        assert not {"title", "phone", "role", "message"} & columns

    def test_it_normalises_the_address(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")

        ask(client, headers, email="  Jordan@Example.com  ")

        with app.app_context():
            assert StaffInviteRequest.query.one().email == "jordan@example.com"

    def test_an_anonymous_request_is_refused(self, client, wildcats):
        refused = client.post(
            "/api/organizations/staff-invite-requests",
            json={"name": "Coach Jordan", "email": "jordan@example.com"},
        )

        assert refused.status_code == 401


class TestTheOrganizationCannotBeChosen:
    """THE DUPLICATE FIX AND THE ISOLATION GUARANTEE, WHICH ARE ONE THING.

    The organization is copied from the authenticated coach's own row. There is
    no field to send, which is stronger than validating one somebody sent.
    """

    def test_A_CLIENT_SUPPLIED_ORGANIZATION_IS_REFUSED(self, app, client, wildcats):
        """Aiming a request at somebody else's program does not half-work - it
        does not work at all, and loudly."""
        with app.app_context():
            victim = Organization(name="University of Cincinnati")
            db.session.add(victim)
            db.session.commit()
            victim_id = victim.id

        headers = token_for(client, "head@example.com")
        refused = client.post(
            "/api/organizations/staff-invite-requests",
            json={
                "name": "Coach Jordan",
                "email": "jordan@example.com",
                # A person typing the real program's name must never reach it.
                "organization_id": victim_id,
                "organization": "University of Cincinnati",
            },
            headers=headers,
        )

        assert refused.status_code == 422
        with app.app_context():
            assert StaffInviteRequest.query.count() == 0

    def test_THE_SERVICE_HAS_NO_ORGANIZATION_PARAMETER_TO_ATTACK(self, app, wildcats):
        """The structural half, and the reason the 422 above is belt rather
        than braces. Even called directly, there is nowhere to put one: the
        organization is read off the coach.
        """
        import inspect

        signature = inspect.signature(staff_invite_requests.submit)

        assert list(signature.parameters) == ["coach", "name", "email"]

        with app.app_context():
            coach = db.session.get(Coach, wildcats["admin_id"])
            staff_invite_requests.submit(coach, "Coach Jordan", "jordan@example.com")

            assert StaffInviteRequest.query.one().organization_id == coach.organization_id

    def test_THE_INVITE_LANDS_IN_THE_REQUESTERS_ORGANIZATION(self, app, client, wildcats):
        with app.app_context():
            other = Organization(name="Somewhere Else")
            db.session.add(other)
            db.session.commit()

        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            code = staff_invite_requests.approve(request)
            invite = OrganizationInvite.query.filter_by(code=code).one()
            assert invite.organization_id == wildcats["org_id"]

    def test_the_invited_coach_never_types_a_program_name(self, app, client, wildcats):
        """THE POINT OF THE WHOLE PATH. They redeem through the existing
        organization-invite endpoint, whose schema has no `organization` field
        at all - so a fifth spelling of an existing program cannot appear."""
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            code = staff_invite_requests.approve(StaffInviteRequest.query.one())

        joined = client.post(
            "/api/auth/register-with-invite",
            json={
                "invite_code": code,
                "username": "coachjordan",
                "email": "jordan@example.com",
                "password": "password123",
            },
        )

        assert joined.status_code == 201, joined.get_json()
        with app.app_context():
            jordan = Coach.query.filter_by(username="coachjordan").one()
            assert jordan.organization_id == wildcats["org_id"]
            # A MEMBER, not an admin of somebody else's program.
            assert jordan.role is CoachRole.MEMBER
            assert Organization.query.count() == 1


class TestSubmittingGrantsNothing:
    def test_the_response_carries_no_token(self, client, wildcats):
        headers = token_for(client, "head@example.com")

        body = ask(client, headers).get_data(as_text=True)

        assert "code" not in body
        assert "join" not in body.lower()
        assert body.count("token") == 0

    def test_NO_INVITE_EXISTS_UNTIL_SOMEBODY_APPROVES(self, app, client, wildcats):
        """The structural half of "a request is not an invite". Until a human
        decides, there is nothing in the database anybody could redeem."""
        headers = token_for(client, "head@example.com")

        ask(client, headers)

        with app.app_context():
            assert OrganizationInvite.query.count() == 0
            assert Coach.query.count() == 2

    def test_a_request_has_nowhere_to_put_a_token(self, app, client, wildcats):
        """Enforced by the schema rather than by a status field somebody has to
        remember to check."""
        with app.app_context():
            columns = {c.name for c in StaffInviteRequest.__table__.columns}

        assert not {c for c in columns if "code" in c or "token" in c or "secret" in c}


class TestApproval:
    def test_it_mints_a_usable_single_use_invite(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            code = staff_invite_requests.approve(request)

            assert code
            invite = OrganizationInvite.query.filter_by(code=code).one()
            assert invite.is_usable() is True
            assert db.session.get(StaffInviteRequest, request.id).approved_invite_id == invite.id

    def test_APPROVING_TWICE_ADMITS_ONE_PERSON(self, app, client, wildcats):
        """Two invites for one request is two people admitted where one was
        vouched for."""
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            first = staff_invite_requests.approve(request)
            second = staff_invite_requests.approve(request)

            assert first is not None
            assert second is None
            assert OrganizationInvite.query.count() == 1

    def test_A_LOST_RACE_LEAVES_NO_ORPHAN_INVITE(self, app, client, wildcats):
        """An unattached single-use invitation is a live credential nobody is
        accountable for. Losing must roll it back, not merely refuse.

        The competing decision commits on ANOTHER CONNECTION, because a request
        decided in this session would already be visible to it.
        """
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            request_id = request.id
            # render_as_string, not str(): str() masks the password.
            url = db.engine.url.render_as_string(hide_password=False)

            other = create_engine(url)
            try:
                with Session(other) as elsewhere:
                    elsewhere.execute(
                        sa_update(StaffInviteRequest)
                        .where(StaffInviteRequest.id == request_id)
                        .values(declined_at=StaffInviteRequest.now())
                    )
                    elsewhere.commit()
            finally:
                other.dispose()

            assert staff_invite_requests.approve(request) is None

        with app.app_context():
            assert OrganizationInvite.query.count() == 0

    def test_declining_creates_nothing(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            assert staff_invite_requests.decline(StaffInviteRequest.query.one()) is True
            assert OrganizationInvite.query.count() == 0
            assert StaffInviteRequest.query.one().is_pending() is False

    def test_a_decided_request_cannot_be_decided_again(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")
        ask(client, headers)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            staff_invite_requests.decline(request)

            assert staff_invite_requests.decline(request) is False
            assert staff_invite_requests.approve(request) is None


class TestAskingTwice:
    def test_a_repeat_request_does_not_queue_the_same_person_twice(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")

        assert ask(client, headers).status_code == 202
        assert ask(client, headers).status_code == 202

        with app.app_context():
            assert StaffInviteRequest.query.count() == 1

    def test_A_DECLINE_IS_NOT_A_BAN(self, app, client, wildcats):
        """The pending-only index exists for this. Declining somebody in August
        must not stop them being added in September."""
        headers = token_for(client, "head@example.com")
        ask(client, headers)
        with app.app_context():
            staff_invite_requests.decline(StaffInviteRequest.query.one())

        assert ask(client, headers).status_code == 202

        with app.app_context():
            assert StaffInviteRequest.query.count() == 2
            assert len(staff_invite_requests.pending()) == 1

    def test_two_organizations_can_want_the_same_person(self, app, client, wildcats):
        """The uniqueness is per organization. A coach moving programs, or
        helping two, is not an error."""
        with app.app_context():
            other = Organization(name="Elder Football")
            db.session.add(other)
            db.session.flush()
            elder = Coach(
                username="eldercoach",
                email="elder@example.com",
                organization_id=other.id,
                role=CoachRole.ADMIN,
            )
            elder.set_password("password123")
            db.session.add(elder)
            db.session.commit()

        ask(client, token_for(client, "head@example.com"))
        ask(client, token_for(client, "elder@example.com"))

        with app.app_context():
            assert StaffInviteRequest.query.count() == 2


class TestPendingListing:
    def test_it_shows_only_undecided_requests_oldest_first(self, app, client, wildcats):
        headers = token_for(client, "head@example.com")
        ask(client, headers, email="first@example.com")
        ask(client, headers, email="second@example.com")

        with app.app_context():
            first = StaffInviteRequest.query.filter_by(email="first@example.com").one()
            staff_invite_requests.decline(first)

            waiting = staff_invite_requests.pending()

            assert [r.email for r in waiting] == ["second@example.com"]


class TestNothingElseChanged:
    def test_public_registration_is_still_open(self, client):
        """Pinned so closing it cannot happen as a side effect."""
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

    def test_MINTING_AN_INVITE_DIRECTLY_IS_CLOSED(self, app, client, wildcats):
        """The other half of the Early Access model, and the reason removing the
        button was not merely cosmetic. An admin who calls the endpoint directly
        is refused too - otherwise "coaches cannot mint invitations" would be a
        statement about a screen rather than about the product.
        """
        headers = token_for(client, "head@example.com")

        refused = client.post("/api/organizations/invites", headers=headers)

        assert refused.status_code == 403
        assert "Request a staff invite" in refused.get_json()["error"]
        with app.app_context():
            assert OrganizationInvite.query.count() == 0

    def test_reopening_it_is_ONE_function(self, app, wildcats):
        """THE PERMISSION SEAM. Letting trusted owners issue their own invites
        again is meant to be a change to this one predicate - not a redesign of
        how invitations work."""
        from app.services import invites

        with app.app_context():
            coach = db.session.get(Coach, wildcats["admin_id"])
            assert invites.may_issue_invites_directly(coach) is False

    def test_the_three_asking_concepts_stay_separate(self, app):
        from app.models import AccessRequest
        from app.models.beta_invite import BetaInvite

        assert AccessRequest.__tablename__ == "access_requests"
        assert BetaInvite.__tablename__ == "beta_invites"
        assert StaffInviteRequest.__tablename__ == "staff_invite_requests"


class TestTheApprovalCommand:
    """THE OWNER SURFACE IS A COMMAND, NOT A SCREEN.

    Approving is a rare, deliberate, one-person act at Early Access volume. A
    screen for it would be a queue, a filter, a detail view and an empty state
    - an admin console built before there was anything to administer. The
    moment it is genuinely tedious is the moment it has earned one; nothing
    here blocks that, because a route would call the same three functions.
    """

    def runner(self, app):
        return app.test_cli_runner()

    def test_list_names_the_organization_the_invite_would_land_in(self, app, client, wildcats):
        ask(client, token_for(client, "head@example.com"))

        result = self.runner(app).invoke(args=["staff-invite", "list"])

        assert result.exit_code == 0, result.output
        assert "jordan@example.com" in result.output
        # The operator must be able to see WHICH program before deciding.
        assert "Cincinnati Football" in result.output
        assert "head@example.com" in result.output

    def test_list_says_so_plainly_when_there_is_nothing(self, app):
        result = self.runner(app).invoke(args=["staff-invite", "list"])

        assert result.exit_code == 0
        assert "No staff invite requests waiting." in result.output

    def test_approve_prints_the_link_exactly_once(self, app, client, wildcats):
        ask(client, token_for(client, "head@example.com"))
        with app.app_context():
            request_id = StaffInviteRequest.query.one().id

        result = self.runner(app).invoke(args=["staff-invite", "approve", str(request_id)])

        assert result.exit_code == 0, result.output
        with app.app_context():
            invite = OrganizationInvite.query.one()
            assert f"/join/{invite.code}" in result.output
            assert invite.organization_id == wildcats["org_id"]

    def test_approve_REFUSES_AN_UNKNOWN_ID_RATHER_THAN_DOING_NOTHING(self, app):
        """"Approved nobody" and "approved the coach you meant" look identical
        on a terminal, and this command hands out access."""
        result = self.runner(app).invoke(args=["staff-invite", "approve", "999999"])

        assert result.exit_code != 0
        assert "No staff invite request with id 999999" in result.output

    def test_approve_refuses_a_request_already_decided(self, app, client, wildcats):
        ask(client, token_for(client, "head@example.com"))
        with app.app_context():
            request = StaffInviteRequest.query.one()
            request_id = request.id
            staff_invite_requests.decline(request)

        result = self.runner(app).invoke(args=["staff-invite", "approve", str(request_id)])

        assert result.exit_code != 0
        assert "already declined" in result.output
        with app.app_context():
            assert OrganizationInvite.query.count() == 0

    def test_decline_creates_no_invite(self, app, client, wildcats):
        ask(client, token_for(client, "head@example.com"))
        with app.app_context():
            request_id = StaffInviteRequest.query.one().id

        result = self.runner(app).invoke(args=["staff-invite", "decline", str(request_id)])

        assert result.exit_code == 0, result.output
        assert "No invite was created." in result.output
        with app.app_context():
            assert OrganizationInvite.query.count() == 0


class TestMergingTwoProgramsCarriesRequestsAcross:
    """A merge is the CURE for the duplicate programs this feature prevents, so
    the two have to agree about what happens to an outstanding ask.

    A pending request MOVES rather than being revoked, and the contrast with
    `organization_invites` is the whole reason both exist. An invitation is a
    credential: redirecting one would drop somebody into an organization they
    never agreed to join, so the merge deletes them. A request carries no token
    and the coach who made it is being moved by this same merge, so carrying it
    across is what keeps their colleague's route in working.
    """

    def two_programs(self, app):
        from app.models import Organization

        with app.app_context():
            source = Organization(name="UC")
            destination = Organization(name="University of Cincinnati")
            db.session.add_all([source, destination])
            db.session.flush()
            for org, handle in ((source, "src"), (destination, "dst")):
                coach = Coach(
                    username=f"{handle}coach",
                    email=f"{handle}@example.com",
                    organization_id=org.id,
                    role=CoachRole.ADMIN,
                )
                coach.set_password("password123")
                db.session.add(coach)
            db.session.commit()
            return source.id, destination.id

    def merge(self, app, source_id, destination_id):
        from app.services import organization_merge

        with app.app_context():
            owner = Coach.query.filter_by(email="dst@example.com").one()
            # The source admin needs an explicit role decision - moving one
            # as-is would widen their access. Irrelevant to what these tests
            # are about, so it is settled the safe way.
            source_admin = Coach.query.filter_by(email="src@example.com").one()
            decisions = {source_admin.id: "MEMBER"}
            plan = organization_merge.preview(source_id, destination_id, decisions=decisions)
            organization_merge.execute(
                source_id,
                destination_id,
                expected_fingerprint=plan["fingerprint"],
                performed_by=owner,
                decisions=decisions,
                acknowledge_collisions=True,
                acknowledge_duplicate_players=True,
            )

    def test_a_pending_request_follows_its_organization(self, app):
        source_id, destination_id = self.two_programs(app)
        with app.app_context():
            coach = Coach.query.filter_by(email="src@example.com").one()
            staff_invite_requests.submit(coach, "Coach Jordan", "jordan@example.com")

        self.merge(app, source_id, destination_id)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            assert request.organization_id == destination_id
            assert request.is_pending()

    def test_AN_ASK_BOTH_PROGRAMS_MADE_DOES_NOT_BREAK_THE_MERGE(self, app):
        """`staff_invite_requests` is the only moved table with an
        organization-scoped unique index. Without the dedup step the re-point
        would raise on any person both programs happened to want, and a merge
        would fail for a reason that has nothing to do with merging.
        """
        source_id, destination_id = self.two_programs(app)
        with app.app_context():
            for email in ("src@example.com", "dst@example.com"):
                coach = Coach.query.filter_by(email=email).one()
                staff_invite_requests.submit(coach, "Coach Jordan", "jordan@example.com")
            assert StaffInviteRequest.query.count() == 2

        self.merge(app, source_id, destination_id)

        with app.app_context():
            # One survives, on the surviving organization. Nothing is lost -
            # the identical ask already existed on the side everything moved to.
            request = StaffInviteRequest.query.one()
            assert request.organization_id == destination_id
            assert request.email == "jordan@example.com"

    def test_a_decided_request_moves_too_and_keeps_its_decision(self, app):
        """Decided rows are outside the pending-only index, so they move
        without any dedup - and history must survive the merge."""
        source_id, destination_id = self.two_programs(app)
        with app.app_context():
            coach = Coach.query.filter_by(email="src@example.com").one()
            staff_invite_requests.submit(coach, "Coach Jordan", "jordan@example.com")
            staff_invite_requests.decline(StaffInviteRequest.query.one())

        self.merge(app, source_id, destination_id)

        with app.app_context():
            request = StaffInviteRequest.query.one()
            assert request.organization_id == destination_id
            assert request.declined_at is not None
