"""THE PLAYER PIN SYSTEM, TESTED AS A TEAMMATE WOULD ATTACK IT.

Phases 3a and 3b test each rule where it lives. This file asks the questions a
determined teammate would, end to end and against the finished system: can I
become somebody else with my OWN valid credentials, an old PIN, a different
route to the same PIN, or another team's code? And does a player who was
mid-quiz when enforcement switched on keep their work?

Enforcement is turned on per test, as everywhere else in the suite.
"""

from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.models import Answer, PlayerAttempt
from tests.test_attempt_tokens import (
    attempt_row,
    claim,
    credential_row,
    give_pin,
    make_player,
    make_quiz,
    wrong_pin_for,
)
from tests.test_player_enforcement import (  # noqa: F401 - enforce/secured are fixtures
    NOW,
    enforce,
    reason,
    secured,
    set_activated_at,
    token_headers,
)


def team(client, headers, *, practice=False):
    """One quiz, one code, two players on it who each have a PIN."""
    quiz, tf, _draw = make_quiz(client, headers, "Attack")
    me = make_player(client, headers, "Mia", "Rivera", jersey_number="7")
    mate = make_player(client, headers, "Tom", "Brady", jersey_number="12")
    pins = {me["id"]: give_pin(client, headers, me["id"]), mate["id"]: give_pin(client, headers, mate["id"])}
    group = client.post("/api/groups", json={"name": "Squad"}, headers=headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [me["id"], mate["id"]]}, headers=headers)
    payload = {"group_ids": [group["id"]], **({"mode": "PRACTICE"} if practice else {})}
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json=payload, headers=headers).get_json()
    assert "code" in code, code

    def who(player):
        return {"access_code_id": code["id"], "player_name": player["full_name"], "player_id": player["id"]}

    return SimpleNamespace(quiz=quiz, tf=tf, code=code, me=me, mate=mate, pins=pins, who=who)


def token_for(client, t, player):
    r = claim(client, t.code, player["id"], t.pins[player["id"]])
    assert r.status_code in (200, 201), r.get_json()
    return r.get_json()["attempt_token"], r.get_json()["attempt"]["attempt_id"]


def answer(client, t, player, token, option=0):
    return client.post("/api/play/answers", json={
        **t.who(player), "question_id": t.tf["id"], "selected_option_id": t.tf["options"][option]["id"],
    }, headers=token_headers(token))


def submit(client, t, player, token, option=0):
    return client.post("/api/play/submit", json={**t.who(player), "answers": [
        {"question_id": t.tf["id"], "selected_option_id": t.tf["options"][option]["id"]}]},
        headers=token_headers(token))


def results(client, t, player, *, token=None, pin=None, code=None):
    body = {"code": (code or t.code)["code"], "player_name": player["full_name"], "player_id": player["id"]}
    if pin is not None:
        body["pin"] = pin
    return client.post("/api/play/results", json=body, headers=token_headers(token))


def saved_option(attempt_id):
    row = Answer.query.filter_by(attempt_id=attempt_id).one_or_none()
    return None if row is None else row.selected_option_id


# ---------------------------------------------------------------------------
# My own valid token, pointed at a teammate
# ---------------------------------------------------------------------------


class TestMyTokenForMyTeammate:
    def test_it_cannot_write_their_answers(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        mine, _ = token_for(client, t, t.me)
        _theirs, their_attempt = token_for(client, t, t.mate)

        r = answer(client, t, t.mate, mine, option=1)

        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert saved_option(their_attempt) is None

    def test_it_cannot_submit_for_them(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        mine, _ = token_for(client, t, t.me)
        _theirs, their_attempt = token_for(client, t, t.mate)

        r = submit(client, t, t.mate, mine)

        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert attempt_row(their_attempt).status.value == "in_progress"

    def test_it_cannot_continue_as_them(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        mine, _ = token_for(client, t, t.me)
        token_for(client, t, t.mate)

        r = client.post("/api/play/claim", json={"access_code_id": t.code["id"], "player_id": t.mate["id"]},
                        headers=token_headers(mine))

        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_it_cannot_read_their_results(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        mine, _ = token_for(client, t, t.me)
        theirs, _ = token_for(client, t, t.mate)
        assert submit(client, t, t.me, mine).status_code == 201
        assert submit(client, t, t.mate, theirs).status_code == 201

        r = results(client, t, t.mate, token=mine)

        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert "answers" not in r.get_json()

    def test_changing_only_the_name_in_the_body_changes_nothing(self, client, coach_headers, secured):
        """player_id is the identity; a name in the body is display text."""
        t = team(client, coach_headers)
        mine, my_attempt = token_for(client, t, t.me)
        _theirs, their_attempt = token_for(client, t, t.mate)

        r = client.post("/api/play/answers", json={
            "access_code_id": t.code["id"], "player_name": t.mate["full_name"], "player_id": t.me["id"],
            "question_id": t.tf["id"], "selected_option_id": t.tf["options"][1]["id"],
        }, headers=token_headers(mine))

        assert r.status_code == 204
        assert saved_option(my_attempt) == t.tf["options"][1]["id"]
        assert saved_option(their_attempt) is None


# ---------------------------------------------------------------------------
# PINs: old ones, and one throttle however you ask
# ---------------------------------------------------------------------------


class TestPins:
    def test_an_old_pin_after_a_reset_is_simply_wrong_and_the_new_one_resumes(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        old_pin = t.pins[t.me["id"]]
        old_token, attempt_id = token_for(client, t, t.me)
        assert answer(client, t, t.me, old_token).status_code == 204

        new_pin = give_pin(client, coach_headers, t.me["id"])
        stale = claim(client, t.code, t.me["id"], old_pin)
        old_device = answer(client, t, t.me, old_token)
        fresh = claim(client, t.code, t.me["id"], new_pin)

        assert new_pin != old_pin
        assert (stale.status_code, reason(stale)) == (401, "pin_incorrect")
        assert (old_device.status_code, reason(old_device)) == (401, "token_revoked")
        assert fresh.status_code == 200 and fresh.get_json()["attempt"]["attempt_id"] == attempt_id
        # Nothing about the attempt was touched by the reset.
        assert saved_option(attempt_id) == t.tf["options"][0]["id"]
        assert answer(client, t, t.me, fresh.get_json()["attempt_token"]).status_code == 204

    def test_an_old_pin_cannot_open_results_either(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        old_pin = t.pins[t.me["id"]]
        token, _ = token_for(client, t, t.me)
        assert submit(client, t, t.me, token).status_code == 201
        give_pin(client, coach_headers, t.me["id"])

        r = results(client, t, t.me, pin=old_pin)

        assert (r.status_code, reason(r)) == (401, "pin_incorrect")

    def test_claim_and_results_share_one_throttle(self, client, coach_headers, secured):
        """Switching routes must not buy a guesser a fresh allowance."""
        t = team(client, coach_headers)
        pin = t.pins[t.mate["id"]]
        for _ in range(5):
            assert reason(claim(client, t.code, t.mate["id"], wrong_pin_for(pin))) == "pin_incorrect"

        sixth = results(client, t, t.mate, pin=wrong_pin_for(pin))
        right_but_waiting = claim(client, t.code, t.mate["id"], pin)

        assert reason(sixth) == "pin_incorrect"
        assert (right_but_waiting.status_code, reason(right_but_waiting)) == (429, "pin_cooldown")
        assert credential_row(t.mate["id"]).consecutive_failures == 6

    @pytest.mark.parametrize("bad", ["", "12345", "1234567", "abcdef", "12 345", " 123456"])
    def test_a_malformed_pin_is_refused_without_counting(self, client, coach_headers, secured, bad):
        t = team(client, coach_headers)
        r = claim(client, t.code, t.mate["id"], bad)
        assert r.status_code == 422
        assert credential_row(t.mate["id"]).consecutive_failures == 0

    def test_a_missing_pin_with_no_token_is_pin_required(self, client, coach_headers, secured):
        t = team(client, coach_headers)
        r = client.post("/api/play/claim", json={"access_code_id": t.code["id"], "player_id": t.mate["id"]})
        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert PlayerAttempt.query.filter_by(player_id=t.mate["id"]).count() == 0


# ---------------------------------------------------------------------------
# Another organization
# ---------------------------------------------------------------------------


class TestAnotherOrganization:
    @pytest.fixture
    def rivals(self, client, register_coach):
        _c, _t, headers = register_coach(username="rival", email="rival@example.com", organization="Rivals")
        return team(client, headers)

    def test_their_player_on_our_code_is_not_eligible_before_any_pin_is_tried(
        self, client, coach_headers, secured, rivals
    ):
        ours = team(client, coach_headers)
        start = client.post("/api/play/start", json={
            "access_code_id": ours.code["id"], "player_name": rivals.me["full_name"], "player_id": rivals.me["id"]})
        pin = claim(client, ours.code, rivals.me["id"], rivals.pins[rivals.me["id"]])

        assert (start.status_code, reason(start)) == (422, "not_eligible")
        assert pin.status_code == 422
        assert PlayerAttempt.query.filter_by(access_code_id=ours.code["id"]).count() == 0

    def test_their_code_with_our_player_reads_nothing(self, client, coach_headers, secured, rivals):
        ours = team(client, coach_headers)
        token, _ = token_for(client, ours, ours.me)
        assert submit(client, ours, ours.me, token).status_code == 201

        by_token = results(client, ours, ours.me, token=token, code=rivals.code)
        by_pin = results(client, ours, ours.me, pin=ours.pins[ours.me["id"]], code=rivals.code)

        assert by_token.status_code == 404 and by_pin.status_code == 404
        assert credential_row(ours.me["id"]).consecutive_failures == 0

    def test_our_token_does_not_open_their_attempt(self, client, coach_headers, secured, rivals):
        ours = team(client, coach_headers)
        our_token, _ = token_for(client, ours, ours.me)
        _their_token, their_attempt = token_for(client, rivals, rivals.me)

        r = answer(client, rivals, rivals.me, our_token)

        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert saved_option(their_attempt) is None


# ---------------------------------------------------------------------------
# A quiz in progress while enforcement switches on
# ---------------------------------------------------------------------------


class TestRolloutBoundary:
    def test_a_player_mid_quiz_with_a_pin_proves_it_once_and_keeps_every_answer(
        self, client, coach_headers, enforce
    ):
        t = team(client, coach_headers)
        # Enforcement OFF: the old flow, no PIN, no token.
        start = client.post("/api/play/start", json=t.who(t.me))
        assert start.status_code == 201
        attempt_id = start.get_json()["attempt_id"]
        assert answer(client, t, t.me, None, option=1).status_code == 204

        # The switch flips while this code is inside the compatibility window.
        enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))
        set_activated_at(t.code["id"], NOW - timedelta(days=2))

        tokenless = answer(client, t, t.me, None, option=0)
        restart = client.post("/api/play/start", json=t.who(t.me))
        claimed = claim(client, t.code, t.me["id"], t.pins[t.me["id"]])

        # The player has a PIN, so their device is asked for it...
        assert (tokenless.status_code, reason(tokenless)) == (401, "token_missing")
        assert (restart.status_code, reason(restart)) == (401, "pin_required")
        # ...and proving it resumes the SAME attempt with its work intact.
        assert claimed.status_code == 200
        body = claimed.get_json()
        assert body["attempt"]["attempt_id"] == attempt_id
        assert [a["selected_option_id"] for a in body["attempt"]["answers"]] == [t.tf["options"][1]["id"]]
        token = body["attempt_token"]
        assert submit(client, t, t.me, token, option=1).status_code == 201
        assert results(client, t, t.me, token=token).status_code == 200

    def test_a_player_mid_quiz_without_a_pin_finishes_inside_the_window(self, client, coach_headers, enforce):
        quiz, tf, _draw = make_quiz(client, coach_headers, "Window")
        player = make_player(client, coach_headers, "No", "Pin")
        group = client.post("/api/groups", json={"name": "W"}, headers=coach_headers).get_json()
        client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]},
                           headers=coach_headers).get_json()
        who = {"access_code_id": code["id"], "player_name": "No Pin", "player_id": player["id"]}
        assert client.post("/api/play/start", json=who).status_code == 201

        enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))
        set_activated_at(code["id"], NOW - timedelta(days=2))
        r = client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}]})

        assert r.status_code == 201, r.get_json()

    def test_the_same_player_after_the_hard_date_is_sent_to_their_coach(self, client, coach_headers, enforce):
        quiz, _tf, _draw = make_quiz(client, coach_headers, "Closed")
        player = make_player(client, coach_headers, "Late", "Arrival")
        group = client.post("/api/groups", json={"name": "L"}, headers=coach_headers).get_json()
        client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]},
                           headers=coach_headers).get_json()
        who = {"access_code_id": code["id"], "player_name": "Late Arrival", "player_id": player["id"]}
        assert client.post("/api/play/start", json=who).status_code == 201

        enforce(NOW - timedelta(days=8), NOW - timedelta(days=1))
        restart = client.post("/api/play/start", json=who)
        pinless = claim(client, code, player["id"], "482915")

        assert (restart.status_code, reason(restart)) == (401, "pin_required")
        assert (pinless.status_code, reason(pinless)) == (403, "pin_not_set")
