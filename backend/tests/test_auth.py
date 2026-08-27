"""Coach registration and login.

PEIRA IS INVITE-ONLY. There is no open registration endpoint, so every test
here creates a coach by spending an invitation - the same path production
serves. `test_open_registration_is_gone` pins the absence directly, because a
suite that simply stopped calling the old route would pass just as happily if
the route were still there.
"""
from tests.conftest import register_via_invite


def test_open_registration_is_gone(client):
    """The only way in is an invitation.

    Asserted directly rather than left implicit: a suite that merely stopped
    calling the open route would be equally green if the route still existed,
    which is exactly the hole this closes.
    """
    refused = client.post(
        "/api/auth/register",
        json={
            "username": "walkup",
            "email": "walkup@example.com",
            "password": "password123",
            "organization": "Walk Up Program",
        },
    )

    assert refused.status_code == 404


def test_register_creates_coach_and_returns_token(client):
    response = register_via_invite(
        client, username="coach1", email="coach1@example.com",
        password="password123", organization="Wildcats",
    )

    assert response.status_code == 201
    body = response.get_json()
    assert body["coach"]["username"] == "coach1"
    assert "password" not in body["coach"]
    assert "password_hash" not in body["coach"]
    assert body["access_token"]


def test_register_rejects_duplicate_email(client, register_coach):
    register_coach(username="coach1", email="dup@example.com")

    response = register_via_invite(
        client, username="coach2", email="dup@example.com",
        password="password123", organization="Wildcats",
    )

    assert response.status_code == 409


def test_register_rejects_short_password(client):
    response = register_via_invite(
        client, username="coach1", email="coach1@example.com",
        password="short", organization="Wildcats",
    )

    assert response.status_code == 422


def test_login_with_correct_credentials(client, register_coach):
    register_coach(email="coach1@example.com", password="password123")

    response = client.post(
        "/api/auth/login", json={"email": "coach1@example.com", "password": "password123"}
    )

    assert response.status_code == 200
    assert response.get_json()["access_token"]


def test_login_with_wrong_password_is_rejected(client, register_coach):
    register_coach(email="coach1@example.com", password="password123")

    response = client.post(
        "/api/auth/login", json={"email": "coach1@example.com", "password": "wrong-password"}
    )

    assert response.status_code == 401


def test_me_requires_authentication(client):
    response = client.get("/api/auth/me")
    assert response.status_code == 401


def test_me_returns_current_coach(client, coach_headers):
    response = client.get("/api/auth/me", headers=coach_headers)
    assert response.status_code == 200
    assert response.get_json()["username"] == "coach1"
