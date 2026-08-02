"""Shared pytest fixtures.

Isolation strategy: create the schema once per test session, then wipe
every table's rows after each test. A per-test SAVEPOINT/rollback scheme
is faster but fragile here — Flask's test client pushes its own request
context per call, which doesn't reliably share a hand-bound session/
connection with fixture code, silently committing straight to the real
database instead of the intended nested transaction. Truncate-after-test
sidesteps that entirely at a small speed cost.

Note: we deliberately never drop_all() at session end. That's a DDL
statement requiring an exclusive table lock, and if any earlier test
leaked a connection that's still "idle in transaction" (a Flask app/
request-context edge case, not something this fixture file controls),
drop_all() hangs waiting on that lock instead of failing fast. Since the
schema is idempotent (create_all() is a no-op on existing tables) there's
nothing to gain from dropping it, so we just leave it in place between runs.
"""

import io

import pytest
from sqlalchemy import text

from app import create_app
from app.extensions import db as _db


@pytest.fixture(scope="session")
def app():
    application = create_app("testing")
    return application


@pytest.fixture(scope="session", autouse=True)
def _database_schema(app):
    with app.app_context():
        _terminate_other_connections()
        _db.create_all()
        yield


def _terminate_other_connections() -> None:
    """Best-effort cleanup of connections leaked by a previous interrupted run."""
    _db.session.execute(
        text(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND pid <> pg_backend_pid()"
        )
    )
    _db.session.commit()


@pytest.fixture(autouse=True)
def _clean_database(app):
    yield
    with app.app_context():
        for table in reversed(_db.metadata.sorted_tables):
            _db.session.execute(table.delete())
        _db.session.commit()


@pytest.fixture
def register_coach(client):
    """Registers a coach through the real API and returns (coach, token, auth_headers)."""

    def _register(username="coach1", email="coach1@example.com", password="password123", organization="Wildcats"):
        response = client.post(
            "/api/auth/register",
            json={
                "username": username,
                "email": email,
                "password": password,
                "organization": organization,
            },
        )
        assert response.status_code == 201, response.get_json()
        body = response.get_json()
        headers = {"Authorization": f"Bearer {body['access_token']}"}
        return body["coach"], body["access_token"], headers

    return _register


@pytest.fixture
def coach_headers(register_coach):
    _, _, headers = register_coach()
    return headers


@pytest.fixture
def invite_teammate(client):
    """Adds a second coach to an existing coach's organization, the same way
    a real one joins: the admin mints an invite, the teammate registers with
    it. Returns (coach, token, auth_headers) for the new teammate.

    `register_coach` always creates a *separate* organization, so this is the
    only fixture that produces two coaches who can see each other's data -
    without it, org-sharing behaviour can't be tested at all.
    """

    def _invite(
        admin_headers,
        username="teammate",
        email="teammate@example.com",
        password="password123",
    ):
        invite = client.post("/api/organizations/invites", headers=admin_headers)
        assert invite.status_code == 201, invite.get_json()
        code = invite.get_json()["code"]

        response = client.post(
            "/api/auth/register-with-invite",
            json={
                "username": username,
                "email": email,
                "password": password,
                "invite_code": code,
            },
        )
        assert response.status_code == 201, response.get_json()
        body = response.get_json()
        headers = {"Authorization": f"Bearer {body['access_token']}"}
        return body["coach"], body["access_token"], headers

    return _invite


def make_image_file(name: str = "play.png") -> tuple[io.BytesIO, str]:
    return io.BytesIO(b"fake-image-bytes"), name
