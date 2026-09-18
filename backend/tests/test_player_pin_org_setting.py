"""PLAYER PIN SECURITY IS EACH ORGANIZATION'S OWN CHOICE.

Protection applies only when BOTH switches are on: the platform's
PLAYER_PIN_ENFORCEMENT (the rollout gate and kill switch) AND that
organization's `player_pin_security_enabled`. Everything else in the suite
assumes the organization half is on; this file is where the column itself is
exercised - its OFF default, who may change it, the four combinations, what a
change does and does not touch, and one organization's choice never reaching
another's players.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import Answer, Organization, PlayerAttempt, PlayerCredential
from tests.test_attempt_tokens import claim, credential_row, give_pin, make_player, make_quiz
from tests.test_player_enforcement import NOW, reason, set_activated_at, token_headers

CUTOVER = NOW - timedelta(days=1)
COMPAT = NOW + timedelta(days=5)


@pytest.fixture
def platform_on(app, monkeypatch):
    """The PLATFORM switch only. No organization has chosen anything yet."""
    monkeypatch.setitem(app.config, "PLAYER_PIN_ENFORCEMENT", True)
    monkeypatch.setitem(app.config, "PLAYER_PIN_CUTOVER_AT", CUTOVER.isoformat())
    monkeypatch.setitem(app.config, "PLAYER_PIN_COMPAT_UNTIL", COMPAT.isoformat())


def team(client, headers, *, pin=True, name=("Jordan", "Smith")):
    """A quiz, a group, one canonical player with a PIN, and a live code."""
    player = make_player(client, headers, *name, jersey_number="7", position="QB")
    player_pin = give_pin(client, headers, player["id"]) if pin else None
    quiz, tf, _draw = make_quiz(client, headers, with_drawing=False)
    group = client.post("/api/groups", json={"name": f"G{player['id']}"}, headers=headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes",
                       json={"group_ids": [group["id"]]}, headers=headers).get_json()
    assert "code" in code, code
    who = {"access_code_id": code["id"], "player_name": player["full_name"], "player_id": player["id"]}
    return type("Team", (), {"player": player, "pin": player_pin, "quiz": quiz, "tf": tf,
                             "group": group, "code": code, "who": who})


def set_security(client, headers, enabled):
    return client.patch("/api/organizations/player-pin-security", json={"enabled": enabled}, headers=headers)


def org_row(organization_id):
    return db.session.get(Organization, organization_id)


def org_id_of(client, headers):
    return client.get("/api/organizations", headers=headers).get_json()["id"]


def start(client, t):
    return client.post("/api/play/start", json=t.who)


def answer(client, t, token=None, option=0):
    return client.post("/api/play/answers", json={
        **t.who, "question_id": t.tf["id"], "selected_option_id": t.tf["options"][option]["id"],
    }, headers=token_headers(token))


def submit(client, t, token=None, option=0):
    return client.post("/api/play/submit", json={**t.who, "answers": [
        {"question_id": t.tf["id"], "selected_option_id": t.tf["options"][option]["id"]}]},
        headers=token_headers(token))


def results(client, t, *, pin=None, token=None):
    body = {"code": t.code["code"], "player_name": t.player["full_name"], "player_id": t.player["id"]}
    if pin is not None:
        body["pin"] = pin
    return client.post("/api/play/results", json=body, headers=token_headers(token))


# ---------------------------------------------------------------------------
# The setting itself
# ---------------------------------------------------------------------------


class TestTheSetting:
    def test_a_new_organization_starts_off(self, client, coach_headers):
        body = client.get("/api/organizations", headers=coach_headers).get_json()
        assert body["player_pin_security_enabled"] is False
        assert body["players_without_pins"] == 0

    def test_an_admin_turns_it_on_and_off(self, client, coach_headers):
        on = set_security(client, coach_headers, True)
        assert on.status_code == 200, on.get_json()
        assert on.get_json()["player_pin_security_enabled"] is True
        assert client.get("/api/organizations", headers=coach_headers).get_json()[
            "player_pin_security_enabled"] is True

        off = set_security(client, coach_headers, False)

        assert off.get_json()["player_pin_security_enabled"] is False

    def test_it_says_how_many_players_still_need_a_pin(self, client, coach_headers):
        make_player(client, coach_headers, "No", "Pin")
        ready = make_player(client, coach_headers, "Has", "Pin")
        give_pin(client, coach_headers, ready["id"])

        body = set_security(client, coach_headers, True).get_json()

        assert body["players_without_pins"] == 1

    def test_turning_it_on_issues_no_pins_and_off_deletes_nothing(self, client, coach_headers):
        t = team(client, coach_headers)
        before = credential_row(t.player["id"])
        version, pin_hash = before.pin_version, before.pin_hash
        others = PlayerCredential.query.count()

        set_security(client, coach_headers, True)
        set_security(client, coach_headers, False)

        after = credential_row(t.player["id"])
        assert (after.pin_version, after.pin_hash) == (version, pin_hash)
        assert PlayerCredential.query.count() == others

    def test_an_ordinary_coach_cannot_change_it(self, client, coach_headers, invite_teammate):
        _coach, _token, mate_headers = invite_teammate(coach_headers)

        refused = set_security(client, mate_headers, True)

        assert refused.status_code == 403
        assert client.get("/api/organizations", headers=mate_headers).get_json()[
            "player_pin_security_enabled"] is False

    def test_a_coach_can_still_see_the_policy(self, client, coach_headers, invite_teammate):
        """It explains why their players are asked for a PIN - it is not a secret
        from the staff it applies to."""
        _coach, _token, mate_headers = invite_teammate(coach_headers)
        set_security(client, coach_headers, True)

        assert client.get("/api/organizations", headers=mate_headers).get_json()[
            "player_pin_security_enabled"] is True

    def test_the_response_carries_no_credential_internals(self, client, coach_headers):
        t = team(client, coach_headers)
        raw = set_security(client, coach_headers, True).get_data(as_text=True).lower()
        for leak in ("pin_hash", "$2b$", "token", "pin_version", t.pin):
            assert leak not in raw, f"leaked {leak!r}"


# ---------------------------------------------------------------------------
# One organization's choice is its own
# ---------------------------------------------------------------------------


class TestCrossOrganization:
    @pytest.fixture
    def rivals(self, client, register_coach):
        _c, _t, headers = register_coach(username="rival", email="rival@example.com", organization="Rivals")
        return headers

    def test_an_admin_cannot_reach_another_organizations_setting(self, client, coach_headers, rivals):
        mine = org_id_of(client, coach_headers)
        theirs = org_id_of(client, rivals)

        set_security(client, coach_headers, True)

        assert org_row(mine).player_pin_security_enabled is True
        assert org_row(theirs).player_pin_security_enabled is False
        # There is no route parameter to name another organization, and the
        # obvious attempts are not routes at all.
        for path in (f"/api/organizations/{theirs}/player-pin-security", "/api/organizations/player-pin-security/2"):
            assert client.patch(path, json={"enabled": True}, headers=coach_headers).status_code in (404, 405)
        assert org_row(theirs).player_pin_security_enabled is False

    def test_protection_is_per_organization(self, client, coach_headers, rivals, platform_on):
        """A protected organization next door changes nothing here."""
        mine = team(client, coach_headers)
        theirs = team(client, rivals, name=("Riley", "Jones"))
        set_security(client, coach_headers, True)

        protected = start(client, mine)
        unprotected = start(client, theirs)

        assert (protected.status_code, reason(protected)) == (401, "pin_required")
        assert unprotected.status_code == 201, unprotected.get_json()


# ---------------------------------------------------------------------------
# The four combinations
# ---------------------------------------------------------------------------


class TestBothSwitches:
    def test_platform_off_org_on_is_not_protected(self, client, coach_headers):
        t = team(client, coach_headers)
        set_security(client, coach_headers, True)

        assert start(client, t).status_code == 201
        assert answer(client, t).status_code == 204

    def test_platform_on_org_off_is_not_protected(self, client, coach_headers, platform_on):
        t = team(client, coach_headers)

        assert start(client, t).status_code == 201
        assert answer(client, t).status_code == 204

    def test_platform_on_org_on_is_protected(self, client, coach_headers, platform_on):
        t = team(client, coach_headers)
        set_security(client, coach_headers, True)

        refused = start(client, t)

        assert (refused.status_code, reason(refused)) == (401, "pin_required")
        assert claim(client, t.code, t.player["id"], t.pin).status_code == 201

    def test_the_kill_switch_beats_the_organization(self, client, coach_headers, app, monkeypatch, platform_on):
        """Pulling the platform switch stops protection everywhere, at once,
        without touching any organization's setting."""
        t = team(client, coach_headers)
        set_security(client, coach_headers, True)
        assert reason(start(client, t)) == "pin_required"

        monkeypatch.setitem(app.config, "PLAYER_PIN_ENFORCEMENT", False)

        assert start(client, t).status_code == 201
        assert org_row(org_id_of(client, coach_headers)).player_pin_security_enabled is True


# ---------------------------------------------------------------------------
# Turning it on, off, and on again
# ---------------------------------------------------------------------------


class TestTransitions:
    def test_off_to_on_to_off_to_on_keeps_the_same_credential(self, client, coach_headers, platform_on):
        t = team(client, coach_headers)
        version = credential_row(t.player["id"]).pin_version

        set_security(client, coach_headers, True)
        first = claim(client, t.code, t.player["id"], t.pin)
        token = first.get_json()["attempt_token"]
        attempt_id = first.get_json()["attempt"]["attempt_id"]
        set_security(client, coach_headers, False)
        off_write = answer(client, t)  # no token needed while off
        set_security(client, coach_headers, True)
        on_again = answer(client, t, token)

        assert first.status_code == 201
        assert off_write.status_code == 204
        # The SAME token still works: turning the setting off revoked nothing.
        assert on_again.status_code == 204
        assert credential_row(t.player["id"]).pin_version == version
        assert PlayerAttempt.query.filter_by(player_id=t.player["id"]).count() == 1
        assert PlayerAttempt.query.filter_by(id=attempt_id).one().status.value == "in_progress"

    def test_turned_on_mid_attempt_the_player_proves_it_once_and_keeps_their_work(
        self, client, coach_headers, platform_on
    ):
        t = team(client, coach_headers)
        assert start(client, t).status_code == 201
        assert answer(client, t, option=1).status_code == 204
        attempt_id = PlayerAttempt.query.filter_by(player_id=t.player["id"]).one().id

        set_security(client, coach_headers, True)
        tokenless = answer(client, t)
        claimed = claim(client, t.code, t.player["id"], t.pin)

        assert (tokenless.status_code, reason(tokenless)) == (401, "token_missing")
        assert claimed.status_code == 200
        body = claimed.get_json()
        assert body["attempt"]["attempt_id"] == attempt_id
        assert [a["selected_option_id"] for a in body["attempt"]["answers"]] == [t.tf["options"][1]["id"]]
        assert answer(client, t, body["attempt_token"]).status_code == 204

    def test_turned_off_mid_attempt_the_player_simply_carries_on(self, client, coach_headers, platform_on):
        t = team(client, coach_headers)
        set_security(client, coach_headers, True)
        claimed = claim(client, t.code, t.player["id"], t.pin).get_json()
        attempt_id = claimed["attempt"]["attempt_id"]

        set_security(client, coach_headers, False)
        tokenless = answer(client, t)
        finished = submit(client, t)

        assert tokenless.status_code == 204
        assert finished.status_code == 201
        assert Answer.query.filter_by(attempt_id=attempt_id).count() == 1
        assert credential_row(t.player["id"]) is not None

    def test_a_submitted_attempt_reads_the_same_before_and_after_a_toggle(
        self, client, coach_headers, platform_on
    ):
        t = team(client, coach_headers)
        assert start(client, t).status_code == 201
        assert submit(client, t).status_code == 201
        before = results(client, t).get_json()

        set_security(client, coach_headers, True)
        protected = results(client, t)
        by_pin = results(client, t, pin=t.pin)
        set_security(client, coach_headers, False)
        after = results(client, t)

        assert (protected.status_code, reason(protected)) == (401, "pin_required")
        assert by_pin.status_code == 200
        assert by_pin.get_json()["answers"] == before["answers"]
        assert after.get_json() == before  # history is untouched by the switch

    def test_a_token_issued_while_on_still_opens_results_after_off_and_on(
        self, client, coach_headers, platform_on
    ):
        t = team(client, coach_headers)
        set_security(client, coach_headers, True)
        token = claim(client, t.code, t.player["id"], t.pin).get_json()["attempt_token"]
        assert submit(client, t, token).status_code == 201

        set_security(client, coach_headers, False)
        while_off = results(client, t, token=token)
        set_security(client, coach_headers, True)
        while_on = results(client, t, token=token)

        assert while_off.status_code == 200
        assert while_on.status_code == 200

    def test_a_pin_reset_before_the_setting_was_on_still_governs(self, client, coach_headers, platform_on):
        t = team(client, coach_headers)
        old_pin = t.pin
        new_pin = give_pin(client, coach_headers, t.player["id"])
        set_security(client, coach_headers, True)

        stale = claim(client, t.code, t.player["id"], old_pin)
        fresh = claim(client, t.code, t.player["id"], new_pin)

        assert (stale.status_code, reason(stale)) == (401, "pin_incorrect")
        assert fresh.status_code == 201


# ---------------------------------------------------------------------------
# Activation and the results picker
# ---------------------------------------------------------------------------


class TestActivationAndResultsPicker:
    def test_activation_is_untouched_while_the_organization_is_off(self, client, coach_headers, platform_on):
        t = team(client, coach_headers, pin=False)
        second = client.post(f"/api/quizzes/{t.quiz['id']}/access-codes",
                             json={"group_ids": [t.group["id"]]}, headers=coach_headers)
        assert second.status_code == 201, second.get_json()

    def test_activation_is_gated_once_the_organization_is_on(self, client, coach_headers, platform_on):
        t = team(client, coach_headers, pin=False)
        set_security(client, coach_headers, True)

        refused = client.post(f"/api/quizzes/{t.quiz['id']}/access-codes",
                              json={"group_ids": [t.group["id"]]}, headers=coach_headers)

        assert (refused.status_code, reason(refused)) == (422, "players_need_pins")
        assert [p["player_id"] for p in refused.get_json()["details"]["players_without_pins"]] == [t.player["id"]]

        give_pin(client, coach_headers, t.player["id"])
        assert client.post(f"/api/quizzes/{t.quiz['id']}/access-codes",
                           json={"group_ids": [t.group["id"]]}, headers=coach_headers).status_code == 201

    def test_the_results_picker_is_the_same_list_either_way(self, client, coach_headers, platform_on):
        """The privacy fix holds across the setting: the roster, never who has
        results."""
        t = team(client, coach_headers)
        assert start(client, t).status_code == 201
        assert submit(client, t).status_code == 201
        identities = lambda: client.post("/api/play/results/identities",  # noqa: E731
                                         json={"code": t.code["code"]}).get_data()
        off = identities()

        set_security(client, coach_headers, True)

        assert identities() == off
        raw = identities().decode().lower()
        for leak in ("submitted", "attempt", "pin", "token", "status"):
            assert leak not in raw


# ---------------------------------------------------------------------------
# The compatibility window still belongs to the platform
# ---------------------------------------------------------------------------


class TestWindowStillApplies:
    def test_an_old_code_keeps_its_exemption_when_an_organization_turns_protection_on(
        self, client, coach_headers, platform_on
    ):
        t = team(client, coach_headers, pin=False)
        set_activated_at(t.code["id"], NOW - timedelta(days=2))
        set_security(client, coach_headers, True)

        # No PIN, never tokened, code activated before cutover: still exempt.
        assert start(client, t).status_code == 201
        assert answer(client, t).status_code == 204

    def test_after_the_hard_date_the_organization_setting_is_what_decides(
        self, client, coach_headers, app, monkeypatch
    ):
        t = team(client, coach_headers, pin=False)
        monkeypatch.setitem(app.config, "PLAYER_PIN_ENFORCEMENT", True)
        monkeypatch.setitem(app.config, "PLAYER_PIN_CUTOVER_AT", (NOW - timedelta(days=8)).isoformat())
        monkeypatch.setitem(app.config, "PLAYER_PIN_COMPAT_UNTIL", (NOW - timedelta(days=1)).isoformat())
        set_activated_at(t.code["id"], NOW - timedelta(days=10))

        while_off = start(client, t)
        set_security(client, coach_headers, True)
        while_on = start(client, t)

        assert while_off.status_code == 201
        assert (while_on.status_code, reason(while_on)) == (401, "pin_required")


def test_the_column_defaults_false_for_a_row_inserted_without_it(app):
    """Existing organizations were not opted in by the migration's default."""
    with app.app_context():
        db.session.execute(db.text("INSERT INTO organizations (name, created_at, updated_at) "
                                   "VALUES ('Legacy HS', :t, :t)"), {"t": datetime.now(timezone.utc)})
        db.session.commit()
        row = Organization.query.filter_by(name="Legacy HS").one()
        assert row.player_pin_security_enabled is False
