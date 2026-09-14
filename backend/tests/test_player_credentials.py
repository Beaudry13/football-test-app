"""PHASE 1 OF PLAYER ATTEMPT INTEGRITY: the credential, and the coach who
issues it.

WHAT THIS PHASE DOES NOT DO, AND THESE TESTS HOLD IT TO THAT. No quiz route
reads a credential yet. A player with a PIN starts, answers and submits exactly
as before, and the vulnerability the repro proved is still open. What exists
now is the thing Phase 2 will check against - and the guarantee that building
it leaked nothing and changed nothing for players.

The properties that matter most:

* The raw PIN is never stored, never logged, and never leaves the server except
  in the one response to the coach who asked for it.
* "Generate missing" never replaces a PIN a coach has already handed out.
* A reset changes the credential and nothing else - never an attempt.
* One organization can never touch another's credentials.
"""

import csv
import io
import logging
import re

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models import Answer, Coach, Player, PlayerAttempt, PlayerCredential
from app.services import player_credentials
from app.services.player_credentials import (
    GENERATE_BATCH_LIMIT,
    PIN_LENGTH,
    generate_pin,
    is_weak_pin,
    pin_matches,
)

BCRYPT = re.compile(r"^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$")


def make_player(client, headers, first="Chris", last="Smith", **extra):
    response = client.post(
        "/api/players", json={"first_name": first, "last_name": last, **extra}, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def reset(client, headers, player_id):
    return client.post(f"/api/players/{player_id}/pin/reset", headers=headers)


def generate_missing(client, headers):
    return client.post("/api/players/pins/generate-missing", headers=headers)


def credential_for(player_id):
    return (
        PlayerCredential.query.populate_existing().filter_by(player_id=player_id).one_or_none()
    )


# ---------------------------------------------------------------------------
# Generating a PIN
# ---------------------------------------------------------------------------


class TestGeneration:
    def test_six_digits_from_the_csprng_and_never_weak(self):
        pins = [generate_pin() for _ in range(500)]
        for pin in pins:
            assert len(pin) == PIN_LENGTH and pin.isdigit()
            assert not is_weak_pin(pin)
        # Random, not a sequence: 500 draws from ~a million should all but
        # never collide.
        assert len(set(pins)) > 490

    @pytest.mark.parametrize(
        "pin",
        ["000000", "999999", "123456", "234567", "987654", "654321",
         "121212", "909090", "123123", "484848", "12345", "1234567", "12a456", ""],
    )
    def test_weak_or_malformed_pins_are_refused(self, pin):
        assert is_weak_pin(pin)

    @pytest.mark.parametrize("pin", ["482915", "103948", "112358", "200411"])
    def test_ordinary_pins_are_allowed(self, pin):
        assert not is_weak_pin(pin)

    def test_a_weak_draw_is_thrown_away_and_drawn_again(self):
        digits = iter([int(d) for d in "123456" + "000000" + "482915"])
        assert generate_pin(randbelow=lambda _n: next(digits)) == "482915"


# ---------------------------------------------------------------------------
# What is stored
# ---------------------------------------------------------------------------


class TestStorage:
    def test_only_a_bcrypt_hash_is_stored(self, client, coach_headers):
        player = make_player(client, coach_headers)
        body = reset(client, coach_headers, player["id"]).get_json()
        pin = body["issued"]["pin"]

        credential = credential_for(player["id"])
        assert BCRYPT.match(credential.pin_hash)
        assert pin not in credential.pin_hash
        assert pin_matches(credential.pin_hash, pin)
        assert not pin_matches(credential.pin_hash, "000001")

    def test_the_raw_pin_appears_in_no_column_of_the_row(self, client, coach_headers):
        player = make_player(client, coach_headers)
        pin = reset(client, coach_headers, player["id"]).get_json()["issued"]["pin"]

        row = db.session.execute(
            text("SELECT * FROM player_credentials WHERE player_id = :id"), {"id": player["id"]}
        ).mappings().one()
        for column, value in row.items():
            assert pin not in str(value), f"raw PIN found in column {column}"

    def test_the_database_itself_refuses_a_raw_pin(self, client, coach_headers):
        """Defence in depth: a future bug that writes the PIN instead of its
        hash must fail loudly, not quietly store every player's PIN."""
        player = make_player(client, coach_headers)
        db.session.add(PlayerCredential(player_id=player["id"], pin_hash="482915"))
        with pytest.raises(IntegrityError):
            db.session.commit()
        db.session.rollback()

    def test_pins_use_their_own_bcrypt_cost(self, app, client, coach_headers, monkeypatch):
        player = make_player(client, coach_headers)

        monkeypatch.setitem(app.config, "PIN_BCRYPT_ROUNDS", 10)
        reset(client, coach_headers, player["id"])
        assert credential_for(player["id"]).pin_hash.startswith("$2b$10$")

        monkeypatch.setitem(app.config, "PIN_BCRYPT_ROUNDS", 5)
        reset(client, coach_headers, player["id"])
        assert credential_for(player["id"]).pin_hash.startswith("$2b$05$")

    def test_the_production_default_is_cost_10(self):
        from app.config import BaseConfig, ProductionConfig

        assert BaseConfig.PIN_BCRYPT_ROUNDS == 10
        assert ProductionConfig.PIN_BCRYPT_ROUNDS == 10

    def test_coach_passwords_keep_their_own_cost(self, client, register_coach):
        """Adding a PIN cost must not have touched the password one."""
        coach, _token, _headers = register_coach(
            username="pwcheck", email="pwcheck@example.com", organization="PW Org"
        )
        stored = db.session.get(Coach, coach["id"]).password_hash
        assert stored.startswith("$2b$12$")


# ---------------------------------------------------------------------------
# Never leaks
# ---------------------------------------------------------------------------


class TestNothingLeaks:
    def test_player_to_dict_carries_no_credential_state(self, client, coach_headers):
        player = make_player(client, coach_headers)
        reset(client, coach_headers, player["id"])

        keys = set(db.session.get(Player, player["id"]).to_dict())
        assert keys == {
            "id", "organization_id", "first_name", "last_name", "full_name",
            "jersey_number", "position", "photo_url", "is_active", "created_at", "updated_at",
        }
        assert not hasattr(PlayerCredential, "to_dict")

    def test_ordinary_payloads_never_contain_the_pin_or_its_hash(
        self, client, coach_headers
    ):
        player = make_player(client, coach_headers, "Jordan", "Lee", jersey_number="12")
        pin = reset(client, coach_headers, player["id"]).get_json()["issued"]["pin"]
        group = client.post("/api/groups", json={"name": "D"}, headers=coach_headers).get_json()
        client.post(
            f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        quiz = client.post("/api/quizzes", json={"title": "Q"}, headers=coach_headers).get_json()
        client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "T?", "question_type": "true_false", "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False}]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]},
            headers=coach_headers,
        ).get_json()

        surfaces = {
            "roster list": client.get("/api/players?active=all", headers=coach_headers),
            "player": client.get(f"/api/players/{player['id']}", headers=coach_headers),
            "profile": client.get(f"/api/players/{player['id']}/history", headers=coach_headers),
            "group": client.get(f"/api/groups/{group['id']}", headers=coach_headers),
            "validate-code": client.post("/api/play/validate-code", json={"code": code["code"]}),
        }
        for label, response in surfaces.items():
            assert response.status_code == 200, (label, response.get_json())
            raw = response.get_data(as_text=True)
            assert pin not in raw, f"raw PIN leaked in {label}"
            assert "pin_hash" not in raw, f"hash field leaked in {label}"
            assert "$2b$" not in raw, f"bcrypt hash leaked in {label}"

    def test_the_pin_is_never_logged(self, client, coach_headers, caplog):
        player = make_player(client, coach_headers)
        make_player(client, coach_headers, "Alex", "Reed")
        with caplog.at_level(logging.DEBUG):
            one = reset(client, coach_headers, player["id"]).get_json()["issued"]["pin"]
            batch = generate_missing(client, coach_headers).get_json()["issued"]
        for pin in [one, *[entry["pin"] for entry in batch]]:
            assert pin not in caplog.text

    def test_pin_bearing_responses_are_never_cached(self, client, coach_headers):
        player = make_player(client, coach_headers)
        for response in (reset(client, coach_headers, player["id"]),
                         generate_missing(client, coach_headers)):
            assert response.headers["Cache-Control"] == "no-store"


# ---------------------------------------------------------------------------
# Generate missing
# ---------------------------------------------------------------------------


class TestGenerateMissing:
    def test_issues_pins_only_to_players_without_one(self, client, coach_headers):
        has_one = make_player(client, coach_headers, "Has", "Pin")
        needs_one = make_player(client, coach_headers, "Needs", "Pin")
        reset(client, coach_headers, has_one["id"])
        before = credential_for(has_one["id"])
        before_hash, before_version = before.pin_hash, before.pin_version

        body = generate_missing(client, coach_headers).get_json()

        assert [entry["player_id"] for entry in body["issued"]] == [needs_one["id"]]
        assert body["remaining"] == 0
        after = credential_for(has_one["id"])
        assert (after.pin_hash, after.pin_version) == (before_hash, before_version)

    def test_an_existing_pin_is_never_silently_replaced(self, client, coach_headers):
        player = make_player(client, coach_headers)
        first = generate_missing(client, coach_headers).get_json()["issued"][0]["pin"]
        again = generate_missing(client, coach_headers).get_json()

        assert again == {"issued": [], "remaining": 0}
        assert pin_matches(credential_for(player["id"]).pin_hash, first)

    def test_the_one_time_payload_has_what_the_sheet_needs(self, client, coach_headers):
        make_player(client, coach_headers, "Jordan", "Lee", jersey_number="12", position="WR")
        entry = generate_missing(client, coach_headers).get_json()["issued"][0]

        assert set(entry) == {
            "player_id", "first_name", "last_name", "full_name", "jersey_number", "position", "pin",
        }
        assert (entry["full_name"], entry["jersey_number"], entry["position"]) == (
            "Jordan Lee", "12", "WR",
        )
        assert len(entry["pin"]) == PIN_LENGTH

    def test_inactive_players_are_skipped(self, client, coach_headers):
        active = make_player(client, coach_headers, "Active", "One")
        inactive = make_player(client, coach_headers, "Inactive", "One")
        client.post(f"/api/players/{inactive['id']}/deactivate", headers=coach_headers)

        issued = generate_missing(client, coach_headers).get_json()["issued"]

        assert [e["player_id"] for e in issued] == [active["id"]]
        assert credential_for(inactive["id"]) is None

    def test_a_large_roster_is_issued_in_batches(self, client, coach_headers):
        for i in range(GENERATE_BATCH_LIMIT + 5):
            make_player(client, coach_headers, "Player", f"N{i:02d}")

        first = generate_missing(client, coach_headers).get_json()
        second = generate_missing(client, coach_headers).get_json()

        assert (len(first["issued"]), first["remaining"]) == (GENERATE_BATCH_LIMIT, 5)
        assert (len(second["issued"]), second["remaining"]) == (5, 0)
        ids = [e["player_id"] for e in first["issued"] + second["issued"]]
        assert len(ids) == len(set(ids)) == GENERATE_BATCH_LIMIT + 5

    def test_records_who_issued_it(self, client, register_coach):
        coach, _t, headers = register_coach(
            username="issuer", email="issuer@example.com", organization="Issuer Org"
        )
        player = make_player(client, headers)
        generate_missing(client, headers)
        credential = credential_for(player["id"])
        assert credential.set_by_coach_id == coach["id"]
        assert credential.pin_version == 1


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------


class TestReset:
    def test_creates_a_first_pin_when_there_is_none(self, client, coach_headers):
        player = make_player(client, coach_headers)
        body = reset(client, coach_headers, player["id"]).get_json()
        assert body["pin_version"] == 1
        assert pin_matches(credential_for(player["id"]).pin_hash, body["issued"]["pin"])

    def test_a_reset_replaces_the_pin_and_bumps_the_version(self, client, coach_headers):
        player = make_player(client, coach_headers)
        old = reset(client, coach_headers, player["id"]).get_json()["issued"]["pin"]
        body = reset(client, coach_headers, player["id"]).get_json()

        credential = credential_for(player["id"])
        assert body["pin_version"] == credential.pin_version == 2
        assert pin_matches(credential.pin_hash, body["issued"]["pin"])
        if body["issued"]["pin"] != old:
            assert not pin_matches(credential.pin_hash, old)

    def test_a_reset_clears_the_lock_and_every_throttle_field(self, client, coach_headers):
        from datetime import datetime, timezone

        player = make_player(client, coach_headers)
        reset(client, coach_headers, player["id"])
        now = datetime.now(timezone.utc)
        credential = credential_for(player["id"])
        credential.failures_in_window = 50
        credential.window_started_at = now
        credential.consecutive_failures = 9
        credential.next_attempt_at = now
        credential.locked_at = now
        db.session.commit()
        listed = client.get("/api/players", headers=coach_headers).get_json()
        assert listed[0]["pin_status"] == "locked"

        reset(client, coach_headers, player["id"])

        credential = credential_for(player["id"])
        assert credential.failures_in_window == 0
        assert credential.consecutive_failures == 0
        assert credential.window_started_at is None
        assert credential.next_attempt_at is None
        assert credential.locked_at is None
        assert client.get("/api/players", headers=coach_headers).get_json()[0]["pin_status"] == "set"

    def test_a_reset_never_deletes_or_changes_an_attempt(self, client, coach_headers):
        player = make_player(client, coach_headers, "Casey", "Victim")
        quiz = client.post("/api/quizzes", json={"title": "Q"}, headers=coach_headers).get_json()
        tf = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "T?", "question_type": "true_false", "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False}]},
            headers=coach_headers,
        ).get_json()
        group = client.post("/api/groups", json={"name": "G"}, headers=coach_headers).get_json()
        client.post(
            f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]},
            headers=coach_headers,
        ).get_json()
        who = {"access_code_id": code["id"], "player_name": "Casey Victim", "player_id": player["id"]}
        client.post("/api/play/start", json=who)
        client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}]})

        def snapshot():
            attempt = PlayerAttempt.query.populate_existing().filter_by(player_id=player["id"]).one()
            answers = Answer.query.populate_existing().filter_by(attempt_id=attempt.id).all()
            return (
                attempt.id, attempt.status, attempt.submitted_at, attempt.token_hash,
                sorted((a.question_id, a.selected_option_id, a.is_correct) for a in answers),
            )

        before = snapshot()
        reset(client, coach_headers, player["id"])
        reset(client, coach_headers, player["id"])
        assert snapshot() == before


# ---------------------------------------------------------------------------
# Player behaviour is unchanged in Phase 1
# ---------------------------------------------------------------------------


class TestPlayersAreNotAffectedYet:
    def test_a_player_with_a_pin_still_plays_without_one(self, client, coach_headers):
        """Phase 1 must not change the player flow. This is the test that
        fails the day someone wires the credential in early."""
        player = make_player(client, coach_headers, "Pat", "Late")
        reset(client, coach_headers, player["id"])
        quiz = client.post("/api/quizzes", json={"title": "Q"}, headers=coach_headers).get_json()
        tf = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "T?", "question_type": "true_false", "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False}]},
            headers=coach_headers,
        ).get_json()
        group = client.post("/api/groups", json={"name": "G"}, headers=coach_headers).get_json()
        client.post(
            f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]},
            headers=coach_headers,
        ).get_json()
        who = {"access_code_id": code["id"], "player_name": "Pat Late", "player_id": player["id"]}

        assert client.post("/api/play/start", json=who).status_code == 201
        assert client.post("/api/play/answers", json={
            **who, "question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}
        ).status_code == 204
        assert client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}]}
        ).status_code == 201
        results = client.post(
            "/api/play/results",
            json={"code": code["code"], "player_name": "Pat Late", "player_id": player["id"]},
        )
        assert results.status_code == 200
        # And no token was issued - that is Phase 2.
        attempt = PlayerAttempt.query.populate_existing().filter_by(player_id=player["id"]).one()
        assert (attempt.token_hash, attempt.token_pin_version, attempt.token_issued_at) == (
            None, None, None,
        )


# ---------------------------------------------------------------------------
# Roster status
# ---------------------------------------------------------------------------


class TestStatus:
    def test_the_roster_reports_status_not_the_pin(self, client, coach_headers):
        with_pin = make_player(client, coach_headers, "With", "Pin")
        make_player(client, coach_headers, "Without", "Pin")
        reset(client, coach_headers, with_pin["id"])

        listed = {p["full_name"]: p["pin_status"] for p in
                  client.get("/api/players", headers=coach_headers).get_json()}
        assert listed == {"With Pin": "set", "Without Pin": "missing"}

    def test_the_profile_reports_status(self, client, coach_headers):
        player = make_player(client, coach_headers)
        history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers)
        assert history.get_json()["pin_status"] == "missing"
        reset(client, coach_headers, player["id"])
        history = client.get(f"/api/players/{player['id']}/history", headers=coach_headers)
        assert history.get_json()["pin_status"] == "set"


# ---------------------------------------------------------------------------
# Organization boundary
# ---------------------------------------------------------------------------


class TestOrganizationBoundary:
    def test_another_organization_cannot_reset_a_pin(self, client, register_coach):
        _a, _t, a_headers = register_coach()
        _b, _t2, b_headers = register_coach(
            username="other", email="other@example.com", organization="Rivals"
        )
        player = make_player(client, a_headers)
        pin = reset(client, a_headers, player["id"]).get_json()["issued"]["pin"]

        response = reset(client, b_headers, player["id"])

        # 404, not 403: another organization's player looks like no player.
        assert response.status_code == 404
        assert "pin" not in (response.get_json() or {}).get("issued", {})
        assert pin_matches(credential_for(player["id"]).pin_hash, pin)

    def test_generate_missing_only_touches_the_callers_organization(
        self, client, register_coach
    ):
        _a, _t, a_headers = register_coach()
        _b, _t2, b_headers = register_coach(
            username="other", email="other@example.com", organization="Rivals"
        )
        theirs = make_player(client, a_headers, "Their", "Player")
        mine = make_player(client, b_headers, "My", "Player")

        issued = generate_missing(client, b_headers).get_json()["issued"]

        assert [e["player_id"] for e in issued] == [mine["id"]]
        assert credential_for(theirs["id"]) is None

    def test_another_organization_sees_no_status_for_my_players(self, client, register_coach):
        _a, _t, a_headers = register_coach()
        _b, _t2, b_headers = register_coach(
            username="other", email="other@example.com", organization="Rivals"
        )
        player = make_player(client, a_headers)
        reset(client, a_headers, player["id"])

        assert client.get("/api/players", headers=b_headers).get_json() == []
        assert client.get(
            f"/api/players/{player['id']}/history", headers=b_headers
        ).status_code == 404

    def test_requires_authentication(self, client, coach_headers):
        player = make_player(client, coach_headers)
        assert client.post(f"/api/players/{player['id']}/pin/reset").status_code == 401
        assert client.post("/api/players/pins/generate-missing").status_code == 401

    def test_a_teammate_in_the_same_organization_may_manage_pins(
        self, client, coach_headers, invite_teammate
    ):
        """Same boundary as editing a player: org-shared."""
        _mate, _t, mate_headers = invite_teammate(coach_headers)
        player = make_player(client, coach_headers)
        assert reset(client, mate_headers, player["id"]).status_code == 200


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


class TestLifecycle:
    def test_deleting_a_player_deletes_their_credential(self, client, coach_headers):
        player = make_player(client, coach_headers)
        reset(client, coach_headers, player["id"])

        assert client.delete(f"/api/players/{player['id']}", headers=coach_headers).status_code == 204

        count = db.session.execute(
            text("SELECT count(*) FROM player_credentials WHERE player_id = :id"),
            {"id": player["id"]},
        ).scalar()
        assert count == 0

    def test_removing_the_issuing_coach_keeps_the_credential(
        self, client, coach_headers, invite_teammate
    ):
        mate, _t, mate_headers = invite_teammate(coach_headers)
        player = make_player(client, coach_headers)
        pin = reset(client, mate_headers, player["id"]).get_json()["issued"]["pin"]
        assert credential_for(player["id"]).set_by_coach_id == mate["id"]

        removed = client.delete(f"/api/organizations/members/{mate['id']}", headers=coach_headers)
        assert removed.status_code in (200, 204), removed.get_json()

        credential = credential_for(player["id"])
        assert credential is not None
        assert credential.set_by_coach_id is None
        assert pin_matches(credential.pin_hash, pin)


# ---------------------------------------------------------------------------
# Existing roster creation is unchanged
# ---------------------------------------------------------------------------


class TestExistingCreationUnchanged:
    def test_creating_a_player_returns_exactly_what_it_did(self, client, coach_headers):
        player = make_player(client, coach_headers)
        assert "pin" not in player and "pin_status" not in player
        assert credential_for(player["id"]) is None

    def test_import_creates_players_without_credentials(self, client, coach_headers):
        confirmed = client.post(
            "/api/players/import/confirm",
            json={"rows": [
                {"action": "create", "first_name": "Imp", "last_name": "One", "jersey_number": "3"},
                {"action": "create", "first_name": "Imp", "last_name": "Two"},
            ]},
            headers=coach_headers,
        )
        assert confirmed.status_code == 201, confirmed.get_json()
        raw = confirmed.get_data(as_text=True)
        assert '"pin"' not in raw
        ids = [p["id"] for p in confirmed.get_json()["players"]]
        assert all(credential_for(pid) is None for pid in ids)
        # Generate-missing picks them straight up afterwards.
        issued = generate_missing(client, coach_headers).get_json()["issued"]
        assert sorted(e["player_id"] for e in issued) == sorted(ids)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class TestSchema:
    def test_the_migration_created_the_table_and_the_unused_token_columns(self, app):
        inspector = inspect(db.engine)
        columns = {c["name"] for c in inspector.get_columns("player_credentials")}
        assert columns == {
            "player_id", "pin_hash", "pin_version", "set_at", "set_by_coach_id",
            "failures_in_window", "window_started_at", "consecutive_failures",
            "next_attempt_at", "locked_at",
        }
        attempt_columns = {c["name"] for c in inspector.get_columns("player_attempts")}
        assert {"token_hash", "token_pin_version", "token_issued_at"} <= attempt_columns

        fks = {fk["referred_table"]: fk["options"].get("ondelete") for fk in
               inspector.get_foreign_keys("player_credentials")}
        assert fks == {"players": "CASCADE", "coaches": "SET NULL"}
