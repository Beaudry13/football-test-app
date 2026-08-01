"""Rate limiting on public, unauthenticated endpoints.

Disabled everywhere else in the suite (see TestingConfig.RATELIMIT_ENABLED)
since it's abuse-prevention infrastructure, not business logic under test.
These tests build their own app instance with it switched back on to verify
the limits are real - Flask-Limiter reads RATELIMIT_ENABLED once at
init_app() time, so toggling app.config afterward has no effect and won't
do here either.
"""

from app import create_app
from app.config import TestingConfig


def make_rate_limited_client(monkeypatch):
    monkeypatch.setattr(TestingConfig, "RATELIMIT_ENABLED", True)
    app = create_app("testing")
    return app.test_client()


def test_validate_code_is_rate_limited(monkeypatch):
    client = make_rate_limited_client(monkeypatch)

    responses = [client.post("/api/play/validate-code", json={"code": "BADCOD"}) for _ in range(21)]

    statuses = [r.status_code for r in responses]
    assert statuses.count(404) == 20  # the configured "20 per minute" limit
    assert statuses[-1] == 429


def test_login_is_rate_limited(monkeypatch):
    client = make_rate_limited_client(monkeypatch)
    payload = {"email": "nobody@example.com", "password": "wrong-password"}

    responses = [client.post("/api/auth/login", json=payload) for _ in range(11)]

    statuses = [r.status_code for r in responses]
    assert statuses.count(401) == 10  # the configured "10 per minute" limit
    assert statuses[-1] == 429
