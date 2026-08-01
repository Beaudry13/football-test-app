"""Shared pytest fixtures.

Isolation strategy: create the schema once per test session, then wipe
every table's rows after each test. A per-test SAVEPOINT/rollback scheme
is faster but fragile here — Flask's test client pushes its own request
context per call, which doesn't reliably share a hand-bound session/
connection with fixture code, silently committing straight to the real
database instead of the intended nested transaction. Truncate-after-test
sidesteps that entirely at a small speed cost.
"""

import io

import pytest

from app import create_app
from app.extensions import db as _db


@pytest.fixture(scope="session")
def app():
    application = create_app("testing")
    return application


@pytest.fixture(scope="session", autouse=True)
def _database_schema(app):
    with app.app_context():
        _db.create_all()
        yield
        _db.drop_all()


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


def make_image_file(name: str = "play.png") -> tuple[io.BytesIO, str]:
    return io.BytesIO(b"fake-image-bytes"), name
