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

from flask_migrate import upgrade

from app import create_app
from app.extensions import db as _db


@pytest.fixture(scope="session")
def app():
    application = create_app("testing")
    return application


@pytest.fixture(scope="session", autouse=True)
def _database_schema(app):
    """Bring the test database to the ALEMBIC HEAD before anything runs.

    THIS USED TO CALL `create_all()`, AND THAT WAS THE BUG. `create_all()`
    issues CREATE TABLE IF NOT EXISTS - it creates missing tables and NEVER
    alters an existing one. The test database is deliberately persistent (see
    the module docstring on why it is not dropped), so every column added by a
    migration stayed invisible to it forever, and the schema silently drifted
    away from the migration chain.

    That cost real time twice: a Phase 4B migration and a Multi-Select one both
    had to be hand-applied with ALTER TABLE before their suites would run, and
    a developer who did not know that saw a wall of unrelated failures.

    Migrations are now the single source of schema truth for tests, exactly as
    they are for production. The full chain takes ~12s from empty and is a
    no-op afterwards, against a suite that runs for minutes.
    """
    with app.app_context():
        _terminate_other_connections()
        if _has_alembic_version():
            # Already migration-managed: apply anything new and carry on. This
            # is the steady state, and it is fast.
            upgrade()
        else:
            # A database built by the old `create_all()` path, or an empty one.
            # Its schema cannot be trusted to match any revision, and stamping
            # it would enshrine the drift this fixture exists to remove - so it
            # is rebuilt from the chain instead.
            #
            # DROP SCHEMA rather than `drop_all()`: one statement instead of a
            # dependency-ordered cascade of them, which is what used to hang on
            # a lock left by an interrupted run.
            _db.session.execute(text("DROP SCHEMA public CASCADE"))
            _db.session.execute(text("CREATE SCHEMA public"))
            _db.session.commit()
            upgrade()
        yield


def _has_alembic_version() -> bool:
    return bool(
        _db.session.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'alembic_version'"
            )
        ).first()
    )


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


def make_image_file(name: str = "play.png", size: tuple[int, int] = (20, 20)) -> tuple[io.BytesIO, str]:
    """A real, decodable image - uploads now go through Pillow-based
    compression (see app/services/file_storage.py), so fake placeholder
    bytes no longer survive the upload route."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, color=(0, 128, 255)).save(buffer, format="PNG")
    buffer.seek(0)
    return buffer, name
