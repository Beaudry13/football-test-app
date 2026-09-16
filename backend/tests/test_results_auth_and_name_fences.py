"""PHASE 3B - results authentication and the name-only fences.

ENFORCEMENT STAYS OFF BY DEFAULT. Every refusal here turns it on for itself,
with dates, and the existing suite is the proof that off changes nothing.

What this slice closes, with enforcement on:
* canonical results need the attempt's token or the player's PIN, and a
  correct PIN re-issues the token for the attempt being returned (R3);
* a name can no longer start, resume or read a protected canonical attempt;
* a name can no longer begin a NEW unprotected legacy attempt for a canonical
  player - including through a roster snapshot name left behind by a rename.

What it keeps: legacy player_id IS NULL attempts resume and read by name as
before; results survive expiry, deactivation and roster changes; and the
compatibility window's exemptions are Phase 3a's, unchanged.

Not here: the activation PIN gate (3c) and every player-facing screen (3d).
"""

import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.extensions import db
from app.models import AccessCode, GroupPlayer, Player, PlayerAttempt, PlayerCredential
from app.services.attempt_tokens import TOKEN_HEADER, check_token, hash_token
from app.services.player_credentials import hash_pin
from tests.test_attempt_tokens import (
    attempt_row,
    claim,
    credential_row,
    give_pin,
    make_player,
    make_quiz,
    wrong_pin_for,
)
from tests.test_play_and_grading import build_ready_quiz
from tests.test_player_enforcement import (  # noqa: F401 - enforce/secured are fixtures
    NOW,
    build,
    claimed,
    enforce,
    in_thread,
    reason,
    secured,
    set_activated_at,
    token_headers,
    wait_for_lock_waiters,
)

NO_RESULTS = "No results found for that code and name"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def switch_on(enforce):
    """Enforcement on, with every code activated from now on secured. For tests
    that must build their history first, while enforcement is still off."""
    enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))


def old_code_window(enforce, code):
    """Enforcement on, and this code activated before the cutover, inside the window."""
    enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))
    set_activated_at(code["id"], NOW - timedelta(days=2))


def as_player(env, *, player=None, pin=None, code=None, **overrides):
    """The same quiz seen through another player and/or another code."""
    player = player or env.player
    code = code or env.code
    return SimpleNamespace(**{
        **env.__dict__,
        **overrides,
        "player": player,
        "pin": pin if player is not env.player else (pin or env.pin),
        "code": code,
        "who": {"access_code_id": code["id"], "player_name": player["full_name"], "player_id": player["id"]},
    })


def name_only(env):
    return SimpleNamespace(**{
        **env.__dict__,
        "who": {"access_code_id": env.code["id"], "player_name": env.player["full_name"]},
    })


def submit_answer(client, env, option_index=0, token=None):
    r = client.post("/api/play/submit", json={**env.who, "answers": [
        {"question_id": env.tf["id"], "selected_option_id": env.tf["options"][option_index]["id"]},
    ]}, headers=token_headers(token))
    assert r.status_code == 201, r.get_json()
    return r.get_json()["attempt_id"]


def finished(client, env, option_index=0):
    """Claim with the PIN, submit with the token. -> (token, attempt_id)"""
    token, attempt_id, _ = claimed(client, env)
    assert submit_answer(client, env, option_index, token) == attempt_id
    return token, attempt_id


def started_and_submitted(client, env, option_index=0):
    """The old flow - no PIN, no token. Run it while enforcement is OFF."""
    r = client.post("/api/play/start", json=env.who)
    assert r.status_code in (200, 201), r.get_json()
    return submit_answer(client, env, option_index)


def results(client, env, *, pin=None, token=None, player_id=True, name=None, code=None):
    body = {"code": (code or env.code)["code"], "player_name": name or env.player["full_name"]}
    if player_id is True:
        body["player_id"] = env.player["id"]
    elif player_id is not None:
        body["player_id"] = player_id
    if pin is not None:
        body["pin"] = pin
    return client.post("/api/play/results", json=body, headers=token_headers(token))


def your_answer(response):
    return response.get_json()["answers"][0]["your_answer"]


def change(model, pk, **values):
    row = db.session.get(model, pk)
    for key, value in values.items():
        setattr(row, key, value)
    db.session.commit()


def attempts_under(code):
    return PlayerAttempt.query.filter_by(access_code_id=code["id"]).count()


def new_code(client, headers, quiz, player_ids, name, practice=False):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": player_ids}, headers=headers)
    payload = {"group_ids": [group["id"]]}
    if practice:
        payload["mode"] = "PRACTICE"
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json=payload, headers=headers).get_json()
    assert "code" in code, code
    return code


def start(client, env, *, name=None, player_id=None):
    body = {"access_code_id": env.code["id"], "player_name": name or env.player["full_name"]}
    if player_id is not None:
        body["player_id"] = player_id
    return client.post("/api/play/start", json=body)


# ---------------------------------------------------------------------------
# Results with the attempt token
# ---------------------------------------------------------------------------


class TestResultsByToken:
    def test_the_attempts_token_opens_its_results(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        token, _ = finished(client, env)

        r = results(client, env, token=token)

        assert r.status_code == 200, r.get_json()
        assert "player_auth" not in r.get_json()
        assert token not in r.get_data(as_text=True)
        assert r.headers["Cache-Control"] == "no-store"

    def test_no_credentials_is_pin_required_and_says_nothing_else(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)

        r = results(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert set(r.get_json()) == {"error", "reason"}

    def test_a_forged_token_is_token_invalid(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        r = results(client, env, token="forged-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_a_token_whose_pin_was_reset_is_token_revoked(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        token, _ = finished(client, env)
        give_pin(client, coach_headers, env.player["id"])

        r = results(client, env, token=token)

        assert (r.status_code, reason(r)) == (401, "token_revoked")

    def test_a_token_from_another_code_is_invalid(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        first_token, _ = finished(client, env)
        quiz2, tf2, _ = make_quiz(client, coach_headers, "Install 2")
        code2 = new_code(client, coach_headers, quiz2, [env.player["id"]], "Second")
        env2 = as_player(env, code=code2, quiz=quiz2, tf=tf2)
        second_token, _ = finished(client, env2)
        assert results(client, env2, token=second_token).status_code == 200

        r = results(client, env2, token=first_token)

        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_another_players_token_is_invalid(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        mate = make_player(client, coach_headers, "Mike", "Beaudry")
        mate_pin = give_pin(client, coach_headers, mate["id"])
        code = new_code(client, coach_headers, env.quiz, [env.player["id"], mate["id"]], "Both")
        mine = as_player(env, code=code)
        theirs = as_player(env, player=mate, pin=mate_pin, code=code)
        my_token, _ = finished(client, mine)
        finished(client, theirs)

        r = results(client, theirs, token=my_token)

        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_a_token_for_an_attempt_not_yet_submitted_opens_nothing(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        token, _, _ = claimed(client, env)

        r = results(client, env, token=token)

        # Not the 404 a PIN holder would get: a token proves nothing about a
        # submission it was never issued for.
        assert (r.status_code, reason(r)) == (401, "token_invalid")


# ---------------------------------------------------------------------------
# Results with the PIN (R3: re-issues the token)
# ---------------------------------------------------------------------------


class TestResultsByPin:
    def test_a_correct_pin_returns_results_and_reissues_the_token(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        old_token, attempt_id = finished(client, env)

        r = results(client, env, pin=env.pin)

        assert r.status_code == 200, r.get_json()
        assert r.headers["Cache-Control"] == "no-store"
        body = r.get_json()
        assert body["answers"] and body["player_name"] == env.player["full_name"]
        assert set(body["player_auth"]) == {"attempt_token", "token_header"}
        assert body["player_auth"]["token_header"] == TOKEN_HEADER
        new_token = body["player_auth"]["attempt_token"]
        row = attempt_row(attempt_id)
        assert check_token(row, new_token).ok
        assert not check_token(row, old_token).ok
        assert results(client, env, token=new_token).status_code == 200
        stale = results(client, env, token=old_token)
        assert (stale.status_code, reason(stale)) == (401, "token_invalid")

    def test_a_typed_pin_wins_over_a_stale_token(self, client, coach_headers, secured):
        """The recovery path: another device took the token, the player types
        their PIN, and their phone is still attaching the old token."""
        env = build(client, coach_headers, with_drawing=False)
        stale_token, attempt_id = finished(client, env)
        assert results(client, env, pin=env.pin).status_code == 200  # rotates it away

        r = results(client, env, pin=env.pin, token=stale_token)

        assert r.status_code == 200, r.get_json()
        assert check_token(attempt_row(attempt_id), r.get_json()["player_auth"]["attempt_token"]).ok

    def test_a_wrong_pin_is_counted_and_reveals_nothing(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id = finished(client, env)

        r = results(client, env, pin=wrong_pin_for(env.pin))

        assert (r.status_code, reason(r)) == (401, "pin_incorrect")
        assert "answers" not in r.get_json() and "player_auth" not in r.get_json()
        assert credential_row(env.player["id"]).consecutive_failures == 1
        assert attempt_row(attempt_id).token_hash == hash_token(token)

    def test_a_cooldown_refuses_even_the_right_pin(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        for _ in range(6):
            results(client, env, pin=wrong_pin_for(env.pin))

        r = results(client, env, pin=env.pin)

        assert (r.status_code, reason(r)) == (429, "pin_cooldown")
        assert int(r.headers["Retry-After"]) > 0

    def test_a_locked_pin(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        change(PlayerCredential, env.player["id"], locked_at=datetime.now(timezone.utc))

        r = results(client, env, pin=env.pin)

        assert (r.status_code, reason(r)) == (423, "pin_locked")

    def test_a_player_without_a_pin(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        started_and_submitted(client, env)
        switch_on(enforce)

        r = results(client, env, pin="482915")

        assert (r.status_code, reason(r)) == (403, "pin_not_set")

    def test_the_pin_is_judged_before_anything_about_a_submission(self, client, coach_headers, secured):
        """No submission yet. A wrong PIN is a PIN error; only the right PIN
        learns there is nothing to show - and a request with no credentials is
        refused exactly as it would be for a player who HAD submitted."""
        env = build(client, coach_headers, with_drawing=False)

        wrong = results(client, env, pin=wrong_pin_for(env.pin))
        right = results(client, env, pin=env.pin)
        bare = results(client, env)

        assert (wrong.status_code, reason(wrong)) == (401, "pin_incorrect")
        assert (right.status_code, right.get_json()["error"]) == (404, NO_RESULTS)
        assert (bare.status_code, reason(bare)) == (401, "pin_required")

    def test_a_pin_needs_a_player_id(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)

        r = results(client, env, pin=env.pin, player_id=None)

        assert r.status_code == 422
        assert credential_row(env.player["id"]).consecutive_failures == 0

    def test_a_malformed_pin_is_never_a_guess(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        for bad in ("12", "1234567", "abcdef"):
            assert results(client, env, pin=bad).status_code == 422
        assert credential_row(env.player["id"]).consecutive_failures == 0

    def test_another_organisations_player_is_simply_not_found(
        self, client, coach_headers, register_coach, secured
    ):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        _, _, other_headers = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        outsider = make_player(client, other_headers, "Out", "Sider")
        outsider_pin = give_pin(client, other_headers, outsider["id"])

        # A WRONG PIN is what proves the order. Were the organisation not checked
        # first, it would be evaluated: a 401 and a counted failure against a
        # player on another team. A correct PIN cannot tell - nothing is
        # submitted under this code for them, so it would be a 404 either way.
        r = results(client, env, pin=wrong_pin_for(outsider_pin), player_id=outsider["id"])
        unknown = results(client, env, player_id=999999)

        assert (r.status_code, r.get_json()["error"]) == (404, NO_RESULTS)
        credential = credential_row(outsider["id"])
        assert (credential.consecutive_failures, credential.failures_in_window) == (0, 0)
        assert (unknown.status_code, unknown.get_json()["error"]) == (404, NO_RESULTS)


# ---------------------------------------------------------------------------
# Authentication and content come from the SAME attempt
# ---------------------------------------------------------------------------


class TestTheExactAttemptReturned:
    def two_practice_runs(self, client, headers):
        env = build(client, headers, practice=True, with_drawing=False)
        first_token, first_id = finished(client, env, option_index=0)
        second_token, second_id = finished(client, env, option_index=1)
        assert second_id > first_id
        return env, (first_token, first_id), (second_token, second_id)

    def test_the_newest_run_is_returned_and_only_its_token_opens_it(self, client, coach_headers, secured):
        env, (first_token, first_id), (second_token, second_id) = self.two_practice_runs(client, coach_headers)

        newest = results(client, env, token=second_token)
        older = results(client, env, token=first_token)
        by_pin = results(client, env, pin=env.pin)

        assert newest.status_code == 200 and your_answer(newest) == "False"
        assert (older.status_code, reason(older)) == (401, "token_invalid")
        assert by_pin.status_code == 200 and your_answer(by_pin) == "False"
        issued = by_pin.get_json()["player_auth"]["attempt_token"]
        assert check_token(attempt_row(second_id), issued).ok
        assert attempt_row(first_id).token_hash == hash_token(first_token), "the older run is untouched"

    def test_a_submitted_at_tie_goes_to_the_higher_id_for_both(self, client, coach_headers, secured):
        env, (first_token, first_id), (_second_token, second_id) = self.two_practice_runs(client, coach_headers)
        moment = datetime.now(timezone.utc)
        change(PlayerAttempt, first_id, submitted_at=moment)
        change(PlayerAttempt, second_id, submitted_at=moment)

        r = results(client, env, pin=env.pin)

        assert your_answer(r) == "False"
        assert check_token(attempt_row(second_id), r.get_json()["player_auth"]["attempt_token"]).ok
        assert attempt_row(first_id).token_hash == hash_token(first_token)

    def test_the_newest_submitted_at_wins_over_the_higher_id(self, client, coach_headers, secured):
        env, (_first_token, first_id), (_second_token, second_id) = self.two_practice_runs(client, coach_headers)
        change(PlayerAttempt, first_id, submitted_at=datetime.now(timezone.utc) + timedelta(minutes=5))

        r = results(client, env, pin=env.pin)

        assert your_answer(r) == "True"
        assert check_token(attempt_row(first_id), r.get_json()["player_auth"]["attempt_token"]).ok


# ---------------------------------------------------------------------------
# Historical results do not depend on current eligibility
# ---------------------------------------------------------------------------


def make_history(client, headers, env, what):
    if what == "expired":
        change(AccessCode, env.code["id"], expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    elif what == "deactivated":
        change(AccessCode, env.code["id"], is_active=False)
    elif what == "player_deactivated":
        change(Player, env.player["id"], is_active=False)
    elif what in ("removed_from_group", "roster_changed"):
        membership = GroupPlayer.query.filter_by(player_id=env.player["id"]).one()
        group_id = membership.group_id
        db.session.delete(membership)
        db.session.commit()
        if what == "roster_changed":
            newcomer = make_player(client, headers, "New", "Comer")
            added = client.post(f"/api/groups/{group_id}/members", json={"player_ids": [newcomer["id"]]}, headers=headers)
            assert added.status_code in (200, 201), added.get_json()
    else:
        raise AssertionError(what)


HISTORY = ["expired", "deactivated", "player_deactivated", "removed_from_group", "roster_changed"]


class TestHistoricalResults:
    @pytest.mark.parametrize("auth", ["token", "pin"])
    @pytest.mark.parametrize("what", HISTORY)
    def test_results_survive(self, client, coach_headers, secured, what, auth):
        env = build(client, coach_headers, with_drawing=False)
        token, _ = finished(client, env)
        make_history(client, coach_headers, env, what)

        r = results(client, env, token=token) if auth == "token" else results(client, env, pin=env.pin)

        assert r.status_code == 200, r.get_json()
        assert r.get_json()["answers"]


# ---------------------------------------------------------------------------
# The compatibility window, for results
# ---------------------------------------------------------------------------


class TestResultsCompatibility:
    def test_enforcement_off_is_unchanged(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)

        assert results(client, env).status_code == 200
        # The manual results form sends a name only - canonical players use it today.
        assert results(client, env, player_id=None).status_code == 200

    def test_old_code_no_pin_never_tokened_stays_open(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        started_and_submitted(client, env)
        old_code_window(enforce, env.code)
        assert results(client, env).status_code == 200

    def test_old_code_player_with_a_pin_needs_auth(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        started_and_submitted(client, env)  # never tokened
        old_code_window(enforce, env.code)

        bare = results(client, env)

        assert (bare.status_code, reason(bare)) == (401, "pin_required")
        assert results(client, env, pin=env.pin).status_code == 200

    def test_old_code_previously_tokened_needs_auth(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        PlayerCredential.query.filter_by(player_id=env.player["id"]).delete()
        db.session.commit()
        old_code_window(enforce, env.code)

        r = results(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_after_compat_until_every_code_is_secured(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        started_and_submitted(client, env)
        enforce(NOW - timedelta(days=10), NOW - timedelta(days=1))
        set_activated_at(env.code["id"], NOW - timedelta(days=11))

        r = results(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_an_extended_expiry_does_not_extend_the_exemption(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        started_and_submitted(client, env)
        enforce(NOW - timedelta(days=10), NOW - timedelta(days=1))
        set_activated_at(env.code["id"], NOW - timedelta(days=11))
        change(AccessCode, env.code["id"], expires_at=datetime.now(timezone.utc) + timedelta(days=90))

        r = results(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_a_new_code_after_cutover_is_secured_without_a_pin(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        started_and_submitted(client, env)
        switch_on(enforce)

        r = results(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")


# ---------------------------------------------------------------------------
# Name-only results
# ---------------------------------------------------------------------------


class TestNameOnlyResults:
    def test_a_name_cannot_read_a_canonical_attempt(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)

        r = results(client, env, player_id=None)

        assert (r.status_code, r.get_json()["error"]) == (404, NO_RESULTS)

    def test_a_name_still_reads_a_legacy_attempt(self, client, coach_headers, secured):
        _quiz, tf, _written, code = build_ready_quiz(client, coach_headers)
        who = {"access_code_id": code["id"], "player_name": "Alex Lee"}
        assert client.post("/api/play/start", json=who).status_code == 201
        assert client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}]}).status_code == 201

        r = client.post("/api/play/results", json={"code": code["code"], "player_name": "alex lee"})

        assert r.status_code == 200, r.get_json()

    def test_with_both_under_one_name_a_name_gets_only_the_legacy_one(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        twin = make_player(client, coach_headers, "John", "Smith")
        code = new_code(client, coach_headers, env.quiz, [env.player["id"], twin["id"]], "Twins")
        canonical = as_player(env, code=code)
        legacy = as_player(env, player=twin, code=code)
        canonical_id = started_and_submitted(client, canonical, option_index=0)  # "True"
        legacy_id = started_and_submitted(client, legacy, option_index=1)  # "False"
        change(PlayerAttempt, legacy_id, player_id=None)
        # The canonical attempt is made the NEWEST, so an unfenced lookup returns it.
        change(PlayerAttempt, canonical_id, submitted_at=datetime.now(timezone.utc) + timedelta(minutes=5))

        before = results(client, canonical, player_id=None)
        switch_on(enforce)
        after = results(client, canonical, player_id=None)

        assert your_answer(before) == "True", "enforcement off: today's name lookup, newest of either"
        assert after.status_code == 200 and your_answer(after) == "False"


# ---------------------------------------------------------------------------
# The results identities endpoint
# ---------------------------------------------------------------------------


class TestResultsIdentities:
    def squad(self, client, headers):
        quiz, tf, _ = make_quiz(client, headers, "Identities")
        wr = make_player(client, headers, "Chris", "Smith", jersey_number="2", position="WR")
        lb = make_player(client, headers, "Chris", "Smith", jersey_number="44", position="LB")
        waiting = make_player(client, headers, "Still", "Going")
        gone = make_player(client, headers, "Dee", "Legacy")
        code = new_code(client, headers, quiz, [wr["id"], lb["id"], waiting["id"], gone["id"]], "Squad", practice=True)

        def seen_as(player):
            return SimpleNamespace(tf=tf, quiz=quiz, draw=None, code=code, player=player, who={
                "access_code_id": code["id"], "player_name": player["full_name"], "player_id": player["id"]})

        started_and_submitted(client, seen_as(wr), 0)
        started_and_submitted(client, seen_as(wr), 1)  # a second practice run
        started_and_submitted(client, seen_as(lb), 0)
        assert client.post("/api/play/start", json=seen_as(waiting).who).status_code == 201
        legacy_id = started_and_submitted(client, seen_as(gone), 0)
        change(PlayerAttempt, legacy_id, player_id=None)
        return code, wr, lb

    def identities(self, client, code):
        return client.post("/api/play/results/identities", json={"code": code["code"]})

    def test_each_submitted_identity_once_and_nothing_else(self, client, coach_headers):
        code, wr, lb = self.squad(client, coach_headers)

        r = self.identities(client, code)

        assert r.status_code == 200, r.get_json()
        assert r.headers["Cache-Control"] == "no-store"
        assert r.get_json() == {"identities": [
            {"player_id": wr["id"], "name": "Chris Smith", "jersey_number": "2", "position": "WR"},
            {"player_id": lb["id"], "name": "Chris Smith", "jersey_number": "44", "position": "LB"},
            {"player_id": None, "name": "Dee Legacy"},
        ]}
        raw = r.get_data(as_text=True).lower()
        for leak in ("attempt", "status", "submitted", "score", "answer", "correct", "feedback",
                     "drawing", "token", "pin", "credential", "mode", "still going"):
            assert leak not in raw, f"identities leaked {leak!r}"

    def test_it_works_after_expiry_and_deactivation(self, client, coach_headers):
        code, _wr, _lb = self.squad(client, coach_headers)
        before = self.identities(client, code).get_json()
        change(AccessCode, code["id"], expires_at=datetime.now(timezone.utc) - timedelta(minutes=1), is_active=False)

        after = self.identities(client, code)

        assert after.status_code == 200 and after.get_json() == before

    def test_it_is_identifiers_only_with_enforcement_on_too(self, client, coach_headers, enforce):
        code, _wr, _lb = self.squad(client, coach_headers)
        switch_on(enforce)
        r = self.identities(client, code)
        assert r.status_code == 200 and len(r.get_json()["identities"]) == 3

    def test_nobody_finished_yet(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        assert client.post("/api/play/start", json=env.who).status_code == 201
        assert self.identities(client, env.code).get_json() == {"identities": []}

    def test_an_unknown_code(self, client):
        r = client.post("/api/play/results/identities", json={"code": "ZZZZZZ"})
        assert (r.status_code, r.get_json()["error"]) == (404, NO_RESULTS)


# ---------------------------------------------------------------------------
# The name-only /start fence
# ---------------------------------------------------------------------------


class TestStartFence:
    def test_a_free_text_name_still_starts_a_legacy_attempt(self, client, coach_headers, secured):
        _quiz, _tf, _written, code = build_ready_quiz(client, coach_headers)
        r = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "Alex Lee"})
        assert r.status_code == 201, r.get_json()
        assert attempt_row(r.get_json()["attempt_id"]).player_id is None

    def test_one_canonical_match_is_pin_required_and_creates_nothing(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)

        r = start(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert r.get_json()["details"] == {"player_id": env.player["id"]}
        assert set(r.get_json()) == {"error", "reason", "details"}
        assert attempts_under(env.code) == 0

    def test_it_holds_for_a_player_without_a_pin_on_a_secured_code(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        r = start(client, env)
        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert attempts_under(env.code) == 0

    def test_several_canonical_matches_is_pick_player(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        twin = make_player(client, coach_headers, "John", "Smith")
        code = new_code(client, coach_headers, env.quiz, [env.player["id"], twin["id"]], "Twins")

        r = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "John Smith"})

        assert (r.status_code, reason(r)) == (409, "pick_player")
        assert "details" not in r.get_json()
        assert attempts_under(code) == 0

    def test_a_renamed_players_old_roster_name_is_still_fenced(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        renamed = client.patch(f"/api/players/{env.player['id']}", json={
            "first_name": "Johnny", "last_name": "Smith", "jersey_number": "7", "position": "QB"}, headers=coach_headers)
        assert renamed.status_code == 200, renamed.get_json()

        r = start(client, env, name="John Smith")

        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert attempts_under(env.code) == 0

    def test_a_renamed_and_re_added_player_cannot_resume_by_the_new_name(self, client, coach_headers, secured):
        """The safety net resolves a CURRENT name to its player and hands back
        that player's attempt, which still carries the OLD name. Here a player
        started as John Smith, was renamed, and was re-added to the group under
        the new name: the new name must not resume the protected attempt."""
        env = build(client, coach_headers, with_drawing=False)
        claimed(client, env)
        renamed = client.patch(f"/api/players/{env.player['id']}", json={
            "first_name": "Johnny", "last_name": "Smith", "jersey_number": "7", "position": "QB"}, headers=coach_headers)
        assert renamed.status_code == 200, renamed.get_json()
        membership = GroupPlayer.query.filter_by(player_id=env.player["id"]).one()
        group_id = membership.group_id
        db.session.delete(membership)
        db.session.commit()
        readded = client.post(f"/api/groups/{group_id}/members", json={"player_ids": [env.player["id"]]},
                              headers=coach_headers)
        assert readded.status_code in (200, 201), readded.get_json()

        r = start(client, env, name="Johnny Smith")

        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert "questions" not in r.get_json()
        assert attempts_under(env.code) == 1

    def test_a_direct_player_id_cannot_skip_claim(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        r = start(client, env, player_id=env.player["id"])
        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert r.get_json()["details"] == {"player_id": env.player["id"]}
        assert attempts_under(env.code) == 0

    def test_neither_id_nor_name_resumes_a_protected_attempt(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        claimed(client, env)

        by_id = start(client, env, player_id=env.player["id"])
        by_name = start(client, env)

        for r in (by_id, by_name):
            assert (r.status_code, reason(r)) == (401, "pin_required")
            assert "questions" not in r.get_json() and "answers" not in r.get_json()
        assert attempts_under(env.code) == 1

    def test_a_protected_submission_is_not_revealed_as_already_submitted(self, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        finished(client, env)
        r = start(client, env, player_id=env.player["id"])
        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_enforcement_off_keeps_todays_safety_net(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        r = start(client, env)
        assert r.status_code == 201
        assert attempt_row(r.get_json()["attempt_id"]).player_id == env.player["id"]

    def test_old_code_no_pin_keeps_todays_safety_net(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        old_code_window(enforce, env.code)
        r = start(client, env)
        assert r.status_code == 201, r.get_json()
        assert attempt_row(r.get_json()["attempt_id"]).player_id == env.player["id"]

    def test_old_code_player_with_a_pin_is_fenced(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        old_code_window(enforce, env.code)
        for r in (start(client, env), start(client, env, player_id=env.player["id"])):
            assert (r.status_code, reason(r)) == (401, "pin_required")
        assert attempts_under(env.code) == 0

    def test_old_code_previously_tokened_player_is_fenced(self, client, coach_headers, enforce):
        env = build(client, coach_headers, practice=True, with_drawing=False)
        finished(client, env)
        PlayerCredential.query.filter_by(player_id=env.player["id"]).delete()
        db.session.commit()
        old_code_window(enforce, env.code)

        for r in (start(client, env), start(client, env, player_id=env.player["id"])):
            assert (r.status_code, reason(r)) == (401, "pin_required")
        assert attempts_under(env.code) == 1

    def test_after_compat_until_a_player_without_a_pin_is_fenced(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        enforce(NOW - timedelta(days=10), NOW - timedelta(days=1))
        set_activated_at(env.code["id"], NOW - timedelta(days=11))
        r = start(client, env)
        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_an_ambiguous_name_on_an_old_code_without_pins_keeps_todays_behaviour(
        self, client, coach_headers, enforce
    ):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        twin = make_player(client, coach_headers, "John", "Smith")
        code = new_code(client, coach_headers, env.quiz, [env.player["id"], twin["id"]], "Twins")
        old_code_window(enforce, code)

        r = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "John Smith"})

        assert r.status_code == 201, r.get_json()
        assert attempt_row(r.get_json()["attempt_id"]).player_id is None


# ---------------------------------------------------------------------------
# Existing legacy attempts are never stranded or rewritten
# ---------------------------------------------------------------------------


class TestLegacyAttempts:
    def legacy(self, client, env):
        """A player_id IS NULL attempt named like the canonical player - how an
        attempt started before that player was linked looks."""
        r = client.post("/api/play/start", json=env.who)
        assert r.status_code == 201, r.get_json()
        attempt_id = r.get_json()["attempt_id"]
        change(PlayerAttempt, attempt_id, player_id=None)
        return attempt_id

    def snapshot(self, attempt_id):
        row = attempt_row(attempt_id)
        return (row.player_id, row.player_name, row.status, row.token_hash, row.position_at_attempt, row.mode)

    def test_it_resumes_by_name_though_a_canonical_player_has_that_name(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        attempt_id = self.legacy(client, env)
        before = self.snapshot(attempt_id)
        switch_on(enforce)

        r = start(client, env)

        assert r.status_code == 200, r.get_json()
        assert r.get_json()["attempt_id"] == attempt_id
        assert self.snapshot(attempt_id) == before
        assert attempts_under(env.code) == 1

    def test_it_resumes_the_legacy_one_when_both_exist(self, client, coach_headers, enforce):
        """A legacy John Smith AND a newer, protected canonical John Smith under
        one code. A name reaches the legacy attempt - never the canonical one,
        which today's newest-first name lookup would have returned."""
        env = build(client, coach_headers, with_drawing=False)
        twin = make_player(client, coach_headers, "John", "Smith")
        code = new_code(client, coach_headers, env.quiz, [env.player["id"], twin["id"]], "Twins")
        first = client.post("/api/play/start", json=as_player(env, player=twin, code=code).who)
        assert first.status_code == 201, first.get_json()
        legacy_id = first.get_json()["attempt_id"]
        _token, canonical_id, _ = claimed(client, as_player(env, code=code))
        assert canonical_id > legacy_id
        change(PlayerAttempt, legacy_id, player_id=None)
        before = self.snapshot(legacy_id)
        switch_on(enforce)

        r = client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "John Smith"})

        assert r.status_code == 200, r.get_json()
        assert r.get_json()["attempt_id"] == legacy_id
        assert self.snapshot(legacy_id) == before

    def test_claim_leaves_it_alone(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        attempt_id = self.legacy(client, env)
        before = self.snapshot(attempt_id)
        switch_on(enforce)

        r = claim(client, env.code, env.player["id"], env.pin)

        assert (r.status_code, reason(r)) == (409, "legacy_attempt")
        assert self.snapshot(attempt_id) == before
        assert attempts_under(env.code) == 1

    def test_it_still_saves_answers(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        self.legacy(client, env)
        switch_on(enforce)

        r = client.post("/api/play/answers", json={**name_only(env).who, "question_id": env.tf["id"],
                                                   "selected_option_id": env.tf["options"][0]["id"]})

        assert r.status_code == 204, r.get_json()

    def test_its_results_still_read_by_name(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        self.legacy(client, env)
        submit_answer(client, name_only(env))
        switch_on(enforce)

        assert results(client, env, player_id=None).status_code == 200

    def test_a_finished_legacy_practice_run_does_not_open_a_new_legacy_attempt(
        self, client, coach_headers, enforce
    ):
        env = build(client, coach_headers, practice=True, with_drawing=False)
        self.legacy(client, env)
        submit_answer(client, name_only(env))
        switch_on(enforce)

        r = start(client, env)

        assert (r.status_code, reason(r)) == (401, "pin_required")
        assert attempts_under(env.code) == 1


# ---------------------------------------------------------------------------
# Concurrency: results by PIN takes the same locks, in the same order, as /claim
# ---------------------------------------------------------------------------


def results_body(env, pin):
    return {"code": env.code["code"], "player_name": env.player["full_name"],
            "player_id": env.player["id"], "pin": pin}


def holding_the_credential_lock(player_id):
    conn = db.engine.connect()
    trans = conn.begin()
    conn.execute(text("SELECT player_id FROM player_credentials WHERE player_id = :id FOR UPDATE"), {"id": player_id})
    return conn, trans


class TestResultsConcurrency:
    def test_two_results_pin_reclaims_serialize(self, app, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        _, attempt_id = finished(client, env)
        body = results_body(env, env.pin)

        conn, trans = holding_the_credential_lock(env.player["id"])
        try:
            t1, r1 = in_thread(app, lambda c: c.post("/api/play/results", json=body))
            t2, r2 = in_thread(app, lambda c: c.post("/api/play/results", json=body))
            wait_for_lock_waiters(2)
            trans.rollback()
        finally:
            conn.close()
        t1.join(30)
        t2.join(30)

        for out in (r1, r2):
            assert "error" not in out, out.get("error")
            assert out["status"] == 200, out["json"]
        row = attempt_row(attempt_id)
        tokens = [out["json"]["player_auth"]["attempt_token"] for out in (r1, r2)]
        assert sum(check_token(row, token).ok for token in tokens) == 1

    def test_results_by_pin_and_claim_serialize(self, app, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        _, attempt_id = finished(client, env)

        conn, trans = holding_the_credential_lock(env.player["id"])
        try:
            t1, by_claim = in_thread(app, lambda c: claim(c, env.code, env.player["id"], env.pin))
            t2, by_results = in_thread(app, lambda c: c.post("/api/play/results", json=results_body(env, env.pin)))
            wait_for_lock_waiters(2)
            trans.rollback()
        finally:
            conn.close()
        t1.join(30)
        t2.join(30)

        for out in (by_claim, by_results):
            assert "error" not in out, out.get("error")
            assert out["status"] == 200, out["json"]
        row = attempt_row(attempt_id)
        tokens = [by_claim["json"]["attempt_token"], by_results["json"]["player_auth"]["attempt_token"]]
        assert sum(check_token(row, token).ok for token in tokens) == 1

    def test_a_pin_reset_that_wins_the_lock_refuses_the_old_pin(self, app, client, coach_headers, secured):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id = finished(client, env)
        new_hash = hash_pin("829301")

        conn, trans = holding_the_credential_lock(env.player["id"])
        try:
            thread, out = in_thread(app, lambda c: c.post("/api/play/results", json=results_body(env, env.pin)))
            wait_for_lock_waiters(1)
            conn.execute(text(
                "UPDATE player_credentials SET pin_hash = :h, pin_version = pin_version + 1 WHERE player_id = :id"
            ), {"h": new_hash, "id": env.player["id"]})
            trans.commit()
        finally:
            conn.close()
        thread.join(30)

        assert "error" not in out, out.get("error")
        assert (out["status"], out["json"]["reason"]) == (401, "pin_incorrect")
        assert attempt_row(attempt_id).token_hash == hash_token(token), "no token was issued"


# ---------------------------------------------------------------------------
# Nothing leaks
# ---------------------------------------------------------------------------


class TestNoLeaks:
    def test_results_by_pin_keep_the_pin_and_token_out_of_logs_and_rows(
        self, client, coach_headers, secured, caplog
    ):
        env = build(client, coach_headers, with_drawing=False)
        _, attempt_id = finished(client, env)

        with caplog.at_level(logging.DEBUG):
            r = results(client, env, pin=env.pin)

        token = r.get_json()["player_auth"]["attempt_token"]
        assert env.pin not in caplog.text
        assert token not in caplog.text
        assert r.get_data(as_text=True).count(token) == 1
        row = db.session.execute(
            text("SELECT * FROM player_attempts WHERE id = :id"), {"id": attempt_id}
        ).mappings().one()
        assert all(token not in str(value) for value in row.values())
        assert row["token_hash"] == hash_token(token)

    def test_an_unauthenticated_secured_request_learns_nothing_about_a_submission(
        self, client, coach_headers, secured
    ):
        submitted = build(client, coach_headers, with_drawing=False)
        finished(client, submitted)
        waiting = build(client, coach_headers, with_drawing=False, name=("Mike", "Beaudry"))

        a = results(client, submitted)
        b = results(client, waiting)

        assert (a.status_code, a.get_json()) == (b.status_code, b.get_json())
