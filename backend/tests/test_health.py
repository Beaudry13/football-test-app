"""/api/health - proves the app can actually reach the database, not just
that the Flask process is up (see render.yaml's healthCheckPath)."""

from sqlalchemy.exc import OperationalError

from app.extensions import db


def test_health_check_returns_ok_when_db_is_reachable(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_health_check_returns_503_when_db_is_unreachable(app, client):
    def _raise(*args, **kwargs):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    # Reverted via the `with` block, not the monkeypatch fixture's own
    # teardown - this session's ORM object is shared with the autouse
    # per-test cleanup fixture in conftest.py, which also calls
    # db.session.execute() at teardown and would otherwise inherit the patch.
    with app.app_context():
        original_execute = db.session.execute
        db.session.execute = _raise
        try:
            response = client.get("/api/health")
        finally:
            db.session.execute = original_execute

    assert response.status_code == 503
    assert response.get_json() == {"status": "error", "detail": "database unreachable"}
