"""A COACH CHOOSES THE DIGITS - setting one player's PIN by hand.

Peira still generates PINs in bulk; this adds the other half a staff needs:
"give this player 482915, I have already told them". The credential it stores
is indistinguishable from a generated one afterwards - same hashing, same
version bump, same revocation - and the plaintext exists only in the request
and the one response that hands it back.
"""

from datetime import timedelta

import pytest

from app.models import Answer, PlayerAttempt, PlayerCredential
from app.services.player_credentials import pin_matches
from tests.test_attempt_tokens import claim, credential_row, give_pin, make_player, make_quiz  # noqa: F401
from tests.test_player_enforcement import NOW, reason, token_headers
from tests.test_player_pin_org_setting import answer, results, set_security, submit, team


@pytest.fixture
def protected(app, monkeypatch, client, coach_headers):
    """Platform switch on, and this organization has chosen PIN security."""
    monkeypatch.setitem(app.config, "PLAYER_PIN_ENFORCEMENT", True)
    monkeypatch.setitem(app.config, "PLAYER_PIN_CUTOVER_AT", (NOW - timedelta(days=1)).isoformat())
    monkeypatch.setitem(app.config, "PLAYER_PIN_COMPAT_UNTIL", (NOW + timedelta(days=5)).isoformat())
    assert set_security(client, coach_headers, True).status_code == 200


def set_pin(client, headers, player_id, pin):
    return client.post(f"/api/players/{player_id}/pin", json={"pin": pin}, headers=headers)


class TestSettingAPin:
    def test_a_coach_chooses_the_digits_and_is_shown_them_once(self, client, coach_headers):
        player = make_player(client, coach_headers, "Jordan", "Smith", jersey_number="7")

        response = set_pin(client, coach_headers, player["id"], "482915")

        assert response.status_code == 200, response.get_json()
        body = response.get_json()
        assert body["issued"]["pin"] == "482915"
        assert body["issued"]["player_id"] == player["id"]
        assert body["issued"]["full_name"] == "Jordan Smith"
        assert body["pin_version"] == 1
        # A raw PIN must never sit in a cache a later reader could reach.
        assert response.headers["Cache-Control"] == "no-store"

    def test_only_a_hash_is_stored_and_nothing_reads_the_pin_back(self, client, coach_headers):
        player = make_player(client, coach_headers, "Jordan", "Smith")
        set_pin(client, coach_headers, player["id"], "482915")

        credential = credential_row(player["id"])

        assert credential.pin_hash.startswith("$2b$")
        assert "482915" not in credential.pin_hash
        assert pin_matches(credential.pin_hash, "482915")
        # Every later read of this player: never the PIN.
        for path in (f"/api/players/{player['id']}", f"/api/players/{player['id']}/history", "/api/players"):
            body = client.get(path, headers=coach_headers).get_data(as_text=True)
            assert "482915" not in body and "pin_hash" not in body

    def test_it_works_as_a_real_pin(self, client, coach_headers, protected):
        # The roster already has PINs (the activation gate insists on it), and
        # this is the coach handing one player digits they chose.
        t = team(client, coach_headers)
        set_pin(client, coach_headers, t.player["id"], "482915")

        assert claim(client, t.code, t.player["id"], "111111").status_code == 401
        claimed = claim(client, t.code, t.player["id"], "482915")

        assert claimed.status_code == 201, claimed.get_json()
        assert answer(client, t, claimed.get_json()["attempt_token"]).status_code == 204

    @pytest.mark.parametrize("bad", ["12345", "1234567", "abcdef", "48 915", "4829a5", "", "０１２３４５"])
    def test_a_pin_that_is_not_six_digits_is_refused_and_creates_nothing(self, client, coach_headers, bad):
        player = make_player(client, coach_headers, "Jordan", "Smith")

        response = set_pin(client, coach_headers, player["id"], bad)

        assert response.status_code == 422, (bad, response.get_json())
        assert PlayerCredential.query.filter_by(player_id=player["id"]).count() == 0

    @pytest.mark.parametrize("weak", ["000000", "123456", "654321", "121212", "123123"])
    def test_a_guessable_pin_is_refused_the_way_a_generated_one_would_be(self, client, coach_headers, weak):
        player = make_player(client, coach_headers, "Jordan", "Smith")

        response = set_pin(client, coach_headers, player["id"], weak)

        assert (response.status_code, reason(response)) == (422, "weak_pin")
        assert PlayerCredential.query.filter_by(player_id=player["id"]).count() == 0

    def test_a_missing_pin_field_is_a_plain_422(self, client, coach_headers):
        player = make_player(client, coach_headers, "Jordan", "Smith")
        assert client.post(f"/api/players/{player['id']}/pin", json={}, headers=coach_headers).status_code == 422


class TestChangingAnExistingPin:
    def test_the_old_pin_stops_working_the_new_one_resumes_the_same_attempt(
        self, client, coach_headers, protected
    ):
        t = team(client, coach_headers)
        old_pin = t.pin
        first = claim(client, t.code, t.player["id"], old_pin).get_json()
        attempt_id = first["attempt"]["attempt_id"]
        assert answer(client, t, first["attempt_token"], option=1).status_code == 204
        version_before = credential_row(t.player["id"]).pin_version

        set_pin(client, coach_headers, t.player["id"], "730146")

        stale_pin = claim(client, t.code, t.player["id"], old_pin)
        stale_token = answer(client, t, first["attempt_token"])
        fresh = claim(client, t.code, t.player["id"], "730146")

        assert (stale_pin.status_code, reason(stale_pin)) == (401, "pin_incorrect")
        assert (stale_token.status_code, reason(stale_token)) == (401, "token_revoked")
        assert fresh.status_code == 200
        body = fresh.get_json()
        assert body["attempt"]["attempt_id"] == attempt_id
        assert [a["selected_option_id"] for a in body["attempt"]["answers"]] == [t.tf["options"][1]["id"]]
        assert credential_row(t.player["id"]).pin_version == version_before + 1

    def test_attempts_answers_and_results_survive_the_change(self, client, coach_headers, protected):
        t = team(client, coach_headers)
        token = claim(client, t.code, t.player["id"], t.pin).get_json()["attempt_token"]
        assert submit(client, t, token).status_code == 201
        before = results(client, t, token=token).get_json()
        attempt_id = PlayerAttempt.query.filter_by(player_id=t.player["id"]).one().id

        set_pin(client, coach_headers, t.player["id"], "730146")

        assert PlayerAttempt.query.filter_by(id=attempt_id).one().status.value == "submitted"
        assert Answer.query.filter_by(attempt_id=attempt_id).count() == 1
        after = results(client, t, pin="730146")
        assert after.status_code == 200
        assert after.get_json()["answers"] == before["answers"]

    def test_it_clears_a_lockout(self, client, coach_headers, protected):
        t = team(client, coach_headers)
        credential = credential_row(t.player["id"])
        credential.locked_at = NOW
        credential.consecutive_failures = 9
        from app.extensions import db as _db

        _db.session.commit()

        set_pin(client, coach_headers, t.player["id"], "730146")

        after = credential_row(t.player["id"])
        assert (after.locked_at, after.consecutive_failures) == (None, 0)
        assert claim(client, t.code, t.player["id"], "730146").status_code == 201

    def test_generate_missing_still_never_replaces_a_hand_set_pin(self, client, coach_headers):
        player = make_player(client, coach_headers, "Jordan", "Smith")
        set_pin(client, coach_headers, player["id"], "482915")
        make_player(client, coach_headers, "Alex", "Lee")

        generated = client.post("/api/players/pins/generate-missing", headers=coach_headers).get_json()

        assert [p["full_name"] for p in generated["issued"]] == ["Alex Lee"]
        assert pin_matches(credential_row(player["id"]).pin_hash, "482915")


class TestWhoMayDoIt:
    def test_another_organizations_player_is_simply_not_found(self, client, coach_headers, register_coach):
        _c, _t, rival_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        theirs = make_player(client, rival_headers, "Their", "Player")
        give_pin(client, rival_headers, theirs["id"])
        before = credential_row(theirs["id"]).pin_hash

        refused = set_pin(client, coach_headers, theirs["id"], "482915")

        assert refused.status_code == 404
        assert credential_row(theirs["id"]).pin_hash == before

    def test_a_teammate_coach_may_manage_pins_exactly_as_they_already_could(
        self, client, coach_headers, invite_teammate
    ):
        """NOT A WIDENING. Every player-management route in this file - including
        the reset that already existed - is scoped to the organization, not to
        the admin role. Setting the digits follows the same rule; pinning it here
        so a future change to either is deliberate."""
        _coach, _token, mate_headers = invite_teammate(coach_headers)
        player = make_player(client, coach_headers, "Jordan", "Smith")

        by_teammate = set_pin(client, mate_headers, player["id"], "482915")
        reset_by_teammate = client.post(f"/api/players/{player['id']}/pin/reset", headers=mate_headers)

        assert by_teammate.status_code == 200
        assert reset_by_teammate.status_code == 200

    def test_an_unauthenticated_caller_is_refused(self, client, coach_headers):
        player = make_player(client, coach_headers, "Jordan", "Smith")
        assert client.post(f"/api/players/{player['id']}/pin", json={"pin": "482915"}).status_code == 401


class TestNothingLeaks:
    def test_the_pin_never_reaches_the_logs(self, client, coach_headers, caplog):
        import logging

        player = make_player(client, coach_headers, "Jordan", "Smith")
        with caplog.at_level(logging.DEBUG):
            set_pin(client, coach_headers, player["id"], "482915")

        assert "482915" not in caplog.text

    def test_no_row_anywhere_holds_the_plaintext(self, client, coach_headers, protected):
        t = team(client, coach_headers)
        set_pin(client, coach_headers, t.player["id"], "482915")
        claimed = claim(client, t.code, t.player["id"], "482915").get_json()
        assert submit(client, t, claimed["attempt_token"]).status_code == 201

        from app.extensions import db as _db

        tables = ("player_credentials", "player_attempts", "players", "answers")
        for table in tables:
            rows = _db.session.execute(_db.text(f"SELECT * FROM {table}")).mappings().all()
            assert "482915" not in str([dict(r) for r in rows]), table
