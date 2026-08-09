"""Per-coach read state for What's New.

The backend stores one opaque string. What is worth guarding is that it is
genuinely per coach, that NULL means "never opened" (which is what gives
existing coaches the indicator without a backfill), and that it cannot leak
across coaches or organizations.
"""

from app.extensions import db
from app.models import Coach


def state(client, headers):
    response = client.get("/api/whats-new", headers=headers)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def mark_seen(client, headers, version):
    return client.post("/api/whats-new/seen", json={"version": version}, headers=headers)


class TestReadState:
    def test_a_coach_who_never_opened_it_has_seen_nothing(self, client, coach_headers):
        # NULL, not "". This is the case that makes every coach who existed
        # before What's New shipped see the unread indicator exactly once.
        assert state(client, coach_headers)["seen_version"] is None

    def test_marking_seen_records_the_version(self, client, coach_headers):
        response = mark_seen(client, coach_headers, "2026.08.3")

        assert response.status_code == 200
        assert response.get_json()["seen_version"] == "2026.08.3"

    def test_the_version_survives_a_fresh_request(self, client, coach_headers):
        # The whole reason this is a column and not localStorage: it has to
        # still be true on the coach's other device.
        mark_seen(client, coach_headers, "2026.08.3")

        assert state(client, coach_headers)["seen_version"] == "2026.08.3"

    def test_marking_seen_twice_is_harmless(self, client, coach_headers):
        mark_seen(client, coach_headers, "2026.08.3")
        response = mark_seen(client, coach_headers, "2026.08.3")

        assert response.status_code == 200
        assert response.get_json()["seen_version"] == "2026.08.3"

    def test_a_newer_release_replaces_the_old_one(self, client, coach_headers):
        # Plain assignment, not max(): "seen" means "matches the newest
        # release", and this column deliberately has no ordering rules.
        mark_seen(client, coach_headers, "2026.08.3")
        mark_seen(client, coach_headers, "2026.09.1")

        assert state(client, coach_headers)["seen_version"] == "2026.09.1"


class TestValidation:
    # 422 is this app's schema-validation status (see utils/validation.py),
    # not 400 - the request was understood and rejected on its contents.
    def test_a_missing_version_is_rejected(self, client, coach_headers):
        assert client.post("/api/whats-new/seen", json={}, headers=coach_headers).status_code == 422

    def test_an_empty_version_is_rejected(self, client, coach_headers):
        assert mark_seen(client, coach_headers, "").status_code == 422

    def test_an_over_long_version_is_rejected(self, client, coach_headers):
        # Capped to the column width rather than truncated, so a bad client
        # gets an error instead of a silently different value.
        assert mark_seen(client, coach_headers, "x" * 33).status_code == 422

    def test_both_endpoints_require_authentication(self, client):
        assert client.get("/api/whats-new").status_code == 401
        assert client.post("/api/whats-new/seen", json={"version": "1"}).status_code == 401


class TestIsolation:
    def test_read_state_is_per_coach_not_per_organization(
        self, client, coach_headers, invite_teammate
    ):
        # Two coaches on the same team read the notes independently.
        _, _, teammate_headers = invite_teammate(coach_headers)
        mark_seen(client, coach_headers, "2026.08.3")

        assert state(client, teammate_headers)["seen_version"] is None
        assert state(client, coach_headers)["seen_version"] == "2026.08.3"

    def test_nothing_leaks_between_organizations(self, client, coach_headers, register_coach):
        _, _, other_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        mark_seen(client, coach_headers, "2026.08.3")

        assert state(client, other_headers)["seen_version"] is None

    def test_a_teammates_mark_does_not_move_yours(
        self, client, coach_headers, invite_teammate
    ):
        _, _, teammate_headers = invite_teammate(coach_headers)
        mark_seen(client, coach_headers, "2026.08.3")
        mark_seen(client, teammate_headers, "2026.09.1")

        assert state(client, coach_headers)["seen_version"] == "2026.08.3"


class TestStoredState:
    def test_this_is_the_only_help_column_on_coach(self, app):
        # Guards the architecture: onboarding stays fully derived apart from
        # its dismissal, and What's New adds exactly one field of its own.
        with app.app_context():
            names = [c.name for c in Coach.__table__.columns]

        assert "whats_new_seen_version" in names
        assert [n for n in names if "whats_new" in n] == ["whats_new_seen_version"]
        assert [n for n in names if "onboarding" in n] == ["onboarding_dismissed_at"]

    def test_existing_coaches_start_unread(self, app, client, coach_headers):
        # Simulates an account created before this shipped: the column is
        # simply NULL, and nothing had to backfill it.
        with app.app_context():
            coach = Coach.query.filter_by(username="coach1").first()
            coach.whats_new_seen_version = None
            db.session.commit()

        assert state(client, coach_headers)["seen_version"] is None
