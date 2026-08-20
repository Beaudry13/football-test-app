"""ASKING TO BE LET IN, AND LEARNING NOTHING BY ASKING.

WHAT THIS IS
------------
The other side of a beta invite. An invite is the owner reaching out; this is
a coach putting their hand up. It grants nothing - no account, no
organization, no entitlement. Somebody still has to decide and issue an
invite, which is the whole point of an invite-only beta.

THE PROPERTY THAT MATTERS
-------------------------
`TestItRevealsNothing` is why the answer is a constant. This form is open to
the whole internet by design, so an answer that varied - "you already asked",
"that email has an account" - would make it a way to test whether a particular
coach uses Peira. Every submission gets the same words and the same status.

PUBLIC REGISTRATION IS STILL OPEN, DELIBERATELY. This lands BEFORE the
decision to close it, so that the front door exists before the other one is
shut. Pinned by a test so it cannot close as a side effect.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.extensions import db
from app.models import AccessRequest, Coach, Organization
from app.services import access_requests


def ask(client, **overrides):
    body = {"name": "Coach Smith", "email": "smith@example.com", "team": "Madeira Mustangs"}
    body.update(overrides)
    return client.post("/api/auth/request-access", json=body)


class TestTheOrdinaryPath:
    def test_it_records_who_asked(self, app, client):
        received = ask(client)

        assert received.status_code == 202
        with app.app_context():
            row = AccessRequest.query.one()
            assert row.name == "Coach Smith"
            assert row.email == "smith@example.com"
            assert row.team == "Madeira Mustangs"
            assert row.requested_at is not None

    def test_the_team_is_optional(self, app, client):
        """A coach who has not named a program yet must not be stopped at the
        door by a field that only helps the owner recognise them."""
        received = client.post(
            "/api/auth/request-access",
            json={"name": "Coach Smith", "email": "smith@example.com"},
        )

        assert received.status_code == 202
        with app.app_context():
            assert AccessRequest.query.one().team is None

    def test_a_blank_team_is_stored_as_nothing(self, app, client):
        """One representation of "did not say", not two."""
        ask(client, team="   ")

        with app.app_context():
            assert AccessRequest.query.one().team is None

    def test_it_grants_nothing(self, app, client):
        """THE POINT OF AN INVITE-ONLY BETA. Asking is not being let in."""
        ask(client)

        with app.app_context():
            assert Coach.query.count() == 0
            assert Organization.query.count() == 0

    def test_the_answer_carries_no_account_and_no_token(self, client):
        body = ask(client).get_json()

        assert body == {"message": access_requests.REQUEST_RECEIVED}


class TestTheAddressIsNormalised:
    @pytest.mark.parametrize(
        "typed",
        ["Smith@Example.com", "  smith@example.com  ", "SMITH@EXAMPLE.COM"],
    )
    def test_case_and_spacing_are_the_same_person(self, app, client, typed):
        ask(client, email=typed)

        with app.app_context():
            assert AccessRequest.query.one().email == "smith@example.com"

    def test_a_plus_tag_is_a_DIFFERENT_person(self, app, client):
        """DELIBERATELY NOT stripped. `+tags` and dots are Gmail conventions,
        not email ones - applying them everywhere would silently merge two
        genuinely different addresses at providers that keep them apart.
        Wrongly merging two coaches is worse than keeping two rows."""
        ask(client, email="smith+wildcats@example.com")
        ask(client, email="smith@example.com")

        with app.app_context():
            assert AccessRequest.query.count() == 2


class TestAskingTwiceIsHarmless:
    def test_a_repeat_request_does_not_create_a_second_row(self, app, client):
        assert ask(client).status_code == 202
        assert ask(client).status_code == 202

        with app.app_context():
            assert AccessRequest.query.count() == 1

    def test_a_repeat_request_KEEPS_THE_FIRST_TIME(self, app, client):
        """How long somebody has been waiting is the useful number, not when
        they last got impatient."""
        ask(client)
        with app.app_context():
            first = AccessRequest.query.one().requested_at

        ask(client, name="Coach Smith Again", team="Somewhere Else")

        with app.app_context():
            row = AccessRequest.query.one()
            assert row.requested_at == first
            assert row.name == "Coach Smith"

    def test_a_repeat_submission_answers_calmly(self, app, client):
        """A second submission of the same form must not become a 500.

        WEAK ON ITS OWN, AND SAID SO ON PURPOSE. This passes against a naive
        check-then-insert too - measured, not assumed - because the competing
        row commits before this request even starts, so the naive lookup sees
        it and skips. `TestTheInsertIsAnUpsert` is what actually pins the
        mechanism.
        """
        with app.app_context():
            # render_as_string, not str(): str() masks the password, and a
            # second engine built from a masked URL cannot authenticate.
            url = db.engine.url.render_as_string(hide_password=False)

        other = create_engine(url)
        try:
            with Session(other) as elsewhere:
                elsewhere.add(
                    AccessRequest(name="Coach Smith", email="smith@example.com", team=None)
                )
                elsewhere.commit()
        finally:
            other.dispose()

        received = ask(client)

        assert received.status_code == 202, received.get_json()
        with app.app_context():
            assert AccessRequest.query.count() == 1


class TestTheInsertIsAnUpsert:
    """THE MECHANISM, PINNED, because the behaviour above cannot pin it.

    Two submissions of the same form - a double click, a retried request - are
    a genuine race, and neither request can see the other's uncommitted work.
    A check-then-insert lets both pass the check and one of them raise an
    IntegrityError, so somebody who did nothing wrong sees a server error for
    daring to click twice.

    Constructing that interleaving deterministically inside one process is not
    something a test here can do honestly - the window is between two
    statements of the same transaction, and holding it open would deadlock on
    the unique index rather than reproduce the race. So this asserts the
    property that makes the race impossible instead: the database is asked to
    resolve the conflict, and nothing looks first.

    Same rule as `services/attempts`, and recorded in CLAUDE.md: do not
    replace an upsert with check-then-insert.
    """

    def _statements_for_one_request(self, app):
        from sqlalchemy import event

        seen: list[str] = []

        with app.app_context():

            def record_statement(_conn, _cursor, statement, *_rest):
                seen.append(statement)

            event.listen(db.engine, "before_cursor_execute", record_statement)
            try:
                access_requests.record("Coach Smith", "smith@example.com", "Mustangs")
            finally:
                event.remove(db.engine, "before_cursor_execute", record_statement)

        return [s for s in seen if "access_requests" in s]

    def test_the_conflict_is_resolved_by_the_database(self, app):
        statements = self._statements_for_one_request(app)

        assert any("ON CONFLICT" in s.upper() for s in statements), statements

    def test_NOTHING_LOOKS_BEFORE_IT_WRITES(self, app):
        """The half that fails against check-then-insert: a SELECT of
        access_requests before the INSERT is exactly the race."""
        statements = self._statements_for_one_request(app)
        first_write = next(
            i for i, s in enumerate(statements) if s.strip().upper().startswith("INSERT")
        )

        assert not [s for s in statements[:first_write] if s.strip().upper().startswith("SELECT")]


class TestItRevealsNothing:
    def test_a_new_and_a_repeat_request_are_indistinguishable(self, client):
        """A form open to the whole internet must not answer "is this address
        known to Peira"."""
        first = ask(client)
        second = ask(client)

        assert first.status_code == second.status_code
        assert first.get_json() == second.get_json()

    def test_AN_ADDRESS_THAT_ALREADY_HAS_AN_ACCOUNT_LOOKS_THE_SAME(self, app, client):
        """The version that would actually leak something: confirming that a
        named coach uses this product."""
        with app.app_context():
            org = Organization(name="Wildcats")
            db.session.add(org)
            db.session.flush()
            coach = Coach(
                username="coachsmith", email="smith@example.com", organization_id=org.id
            )
            coach.set_password("password123")
            db.session.add(coach)
            db.session.commit()

        known = ask(client)
        unknown = ask(client, email="nobody@example.com")

        assert known.status_code == unknown.status_code == 202
        assert known.get_json() == unknown.get_json()

    def test_it_stores_nothing_it_was_not_given(self, app, client):
        """NOT AN IP, NOT A USER AGENT, NOT A REFERRER. Every extra column is a
        CRM feature bought with an unknown future benefit and a real data
        protection cost."""
        ask(client)

        with app.app_context():
            stored = set(AccessRequest.query.one().to_dict())

        assert stored == {"id", "name", "email", "team", "requested_at"}


class TestBadInput:
    @pytest.mark.parametrize(
        "bad",
        [
            {"email": "smith@example.com"},
            {"name": "Coach Smith"},
            {"name": "", "email": "smith@example.com"},
            {"name": "Coach Smith", "email": "not-an-email"},
        ],
    )
    def test_an_incomplete_form_is_refused(self, client, bad):
        assert client.post("/api/auth/request-access", json=bad).status_code == 422

    def test_a_refused_form_records_nothing(self, app, client):
        client.post("/api/auth/request-access", json={"name": "x", "email": "nope"})

        with app.app_context():
            assert AccessRequest.query.count() == 0


class TestNothingElseChanged:
    def test_public_registration_is_still_open(self, client):
        """DELIBERATE, and pinned. Request Access lands BEFORE the decision to
        close public signup, so the new front door exists before the old one
        is shut. Closing it is a separate, explicit change."""
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

    def test_it_is_a_separate_concept_from_both_invite_types(self, app):
        from app.models import OrganizationInvite
        from app.models.beta_invite import BetaInvite

        assert AccessRequest.__tablename__ == "access_requests"
        assert BetaInvite.__tablename__ == "beta_invites"
        assert OrganizationInvite.__tablename__ == "organization_invites"
