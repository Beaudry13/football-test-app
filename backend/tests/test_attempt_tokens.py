"""PHASE 2 OF PLAYER ATTEMPT INTEGRITY: the private per-attempt token, and PIN
authentication with throttling.

WHAT THIS PHASE DOES NOT DO. Nothing requires a token or a PIN yet. /start,
/answers, /drawing, /submit and /results all behave exactly as they did, and
the impersonation the audit reproduced is STILL POSSIBLE. These tests pin both
halves: the foundation works, and nothing existing depends on it.

The properties that matter most:
* a token authenticates exactly one attempt, and only its current token;
* a coach resetting the PIN revokes every token issued under the old one;
* a PIN reclaim rotates the token, signing the old device out;
* a raw token or PIN is never stored, logged or echoed anywhere but the one
  response that issues it;
* wrong PINs are throttled per player, never per IP.
"""

import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.extensions import db
from app.models import Answer, PlayerAttempt, PlayerCredential
from app.services import attempt_tokens, player_credentials
from app.services.attempt_tokens import (
    LEGACY_ATTEMPT,
    MISMATCH,
    MISSING,
    NO_CREDENTIAL,
    NOT_ISSUED,
    REVOKED,
    TOKEN_HEADER,
    VALID,
    check_token,
    hash_token,
    issue_token,
    token_from_request,
)
from app.services.player_credentials import (
    PIN_COOLDOWN,
    PIN_HARD_LOCKED,
    PIN_NOT_SET,
    PIN_OK,
    PIN_WRONG,
    verify_player_pin,
)
from tests.conftest import make_image_file
from tests.test_play_and_grading import build_ready_quiz, start_and_submit

URLSAFE = re.compile(r"^[A-Za-z0-9_-]{43}$")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_player(client, headers, first="John", last="Smith", **extra):
    r = client.post("/api/players", json={"first_name": first, "last_name": last, **extra}, headers=headers)
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def give_pin(client, headers, player_id):
    r = client.post(f"/api/players/{player_id}/pin/reset", headers=headers)
    assert r.status_code == 200, r.get_json()
    return r.get_json()["issued"]["pin"]


def wrong_pin_for(pin):
    return "000001" if pin != "000001" else "000002"


def make_quiz(client, headers, title="Install", with_drawing=False):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    tf = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Cover 2?", "question_type": "true_false", "options": [
            {"option_text": "True", "is_correct_answer": True},
            {"option_text": "False", "is_correct_answer": False}]},
        headers=headers,
    ).get_json()
    draw = None
    if with_drawing:
        draw = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Draw it", "question_type": "draw_response", "options": []},
            headers=headers,
        ).get_json()
        buf, name = make_image_file("film.png", (40, 40))
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{draw['id']}/image",
            data={"image": (buf, name)}, content_type="multipart/form-data", headers=headers,
        )
    return quiz, tf, draw


def activate(client, headers, quiz_id, player_ids, name="Squad"):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": player_ids}, headers=headers)
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={"group_ids": [group["id"]]}, headers=headers
    ).get_json()
    assert "code" in code, code
    return code


def claim(client, code, player_id, pin):
    return client.post(
        "/api/play/claim", json={"access_code_id": code["id"], "player_id": player_id, "pin": pin}
    )


def attempt_row(attempt_id):
    return PlayerAttempt.query.populate_existing().filter_by(id=attempt_id).one()


def credential_row(player_id):
    return PlayerCredential.query.populate_existing().filter_by(player_id=player_id).one()


@pytest.fixture
def env(client, coach_headers):
    """One quiz, one canonical player with a PIN, activated for them."""
    player = make_player(client, coach_headers)
    pin = give_pin(client, coach_headers, player["id"])
    quiz, tf, _ = make_quiz(client, coach_headers)
    code = activate(client, coach_headers, quiz["id"], [player["id"]])
    return {"headers": coach_headers, "player": player, "pin": pin, "quiz": quiz, "tf": tf, "code": code}


# ---------------------------------------------------------------------------
# Token generation and hashing
# ---------------------------------------------------------------------------


class TestTokenGeneration:
    def test_256_bits_urlsafe_and_unique(self):
        tokens = [issue_token(PlayerAttempt(), 1) for _ in range(300)]
        assert all(URLSAFE.match(t) for t in tokens)
        assert len(set(tokens)) == 300

    def test_only_the_sha256_is_kept_on_the_attempt(self):
        attempt = PlayerAttempt()
        raw = issue_token(attempt, 7)
        assert attempt.token_hash == hashlib.sha256(raw.encode()).hexdigest() == hash_token(raw)
        assert attempt.token_hash != raw and raw not in attempt.token_hash
        assert len(attempt.token_hash) == 64
        assert attempt.token_pin_version == 7
        assert attempt.token_issued_at is not None

    def test_the_header_name(self):
        assert TOKEN_HEADER == "X-Attempt-Token"

    def test_the_token_is_read_from_the_header(self, app):
        with app.test_request_context(headers={TOKEN_HEADER: "  abc  "}):
            assert token_from_request() == "abc"
        with app.test_request_context():
            assert token_from_request() is None


# ---------------------------------------------------------------------------
# Claiming with a PIN
# ---------------------------------------------------------------------------


class TestClaim:
    def test_a_first_claim_starts_the_attempt_and_issues_a_token(self, client, env):
        r = claim(client, env["code"], env["player"]["id"], env["pin"])

        assert r.status_code == 201, r.get_json()
        body = r.get_json()
        assert body["reclaimed"] is False
        assert body["token_header"] == "X-Attempt-Token"
        assert body["player"] == {"player_id": env["player"]["id"], "name": "John Smith"}
        assert body["attempt"]["questions"], "the quiz to play comes back with the token"
        assert URLSAFE.match(body["attempt_token"])
        assert r.headers["Cache-Control"] == "no-store"

        attempt = attempt_row(body["attempt"]["attempt_id"])
        assert attempt.player_id == env["player"]["id"]
        assert attempt.token_hash == hash_token(body["attempt_token"])
        assert attempt.token_pin_version == 1
        assert check_token(attempt, body["attempt_token"]).status == VALID

    def test_a_wrong_pin_learns_nothing_and_creates_nothing(self, client, env):
        r = claim(client, env["code"], env["player"]["id"], wrong_pin_for(env["pin"]))

        assert r.status_code == 401
        assert r.get_json()["reason"] == "pin_incorrect"
        assert "attempt_token" not in r.get_json()
        assert PlayerAttempt.query.filter_by(player_id=env["player"]["id"]).count() == 0

    def test_a_malformed_pin_is_a_422_and_never_counts_as_a_guess(self, client, env):
        for bad in ("12345", "1234567", "abcdef", ""):
            assert claim(client, env["code"], env["player"]["id"], bad).status_code == 422
        assert credential_row(env["player"]["id"]).consecutive_failures == 0

    def test_a_player_without_a_pin_is_told_so(self, client, env):
        other = make_player(client, env["headers"], "No", "Pin")
        r = claim(client, env["code"], other["id"], "482915")
        assert r.status_code == 403
        assert r.get_json()["reason"] == "pin_not_set"

    def test_another_organizations_player_is_refused_before_any_pin_is_tried(
        self, client, env, register_coach
    ):
        _c, _t, rival_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        theirs = make_player(client, rival_headers, "Their", "Player")
        their_pin = give_pin(client, rival_headers, theirs["id"])

        # A WRONG PIN is what proves the order. If this code's organization
        # were not checked first, the PIN would be evaluated: a 401, and a
        # failure counted against a player on another team. A correct PIN
        # cannot tell the difference - it would fail eligibility with a 422
        # either way - which is exactly how an earlier version of this test
        # passed with the organization check deleted.
        r = claim(client, env["code"], theirs["id"], wrong_pin_for(their_pin))

        assert r.status_code == 422
        assert r.get_json().get("reason") != "pin_incorrect"
        credential = credential_row(theirs["id"])
        assert (credential.consecutive_failures, credential.failures_in_window) == (0, 0)
        assert PlayerAttempt.query.filter_by(player_id=theirs["id"]).count() == 0

        # And their correct PIN is equally useless through this team's code.
        assert claim(client, env["code"], theirs["id"], their_pin).status_code == 422
        assert PlayerAttempt.query.filter_by(player_id=theirs["id"]).count() == 0

    def test_a_correct_pin_does_not_bypass_eligibility(self, client, env):
        outsider = make_player(client, env["headers"], "Not", "Grouped")
        pin = give_pin(client, env["headers"], outsider["id"])

        r = claim(client, env["code"], outsider["id"], pin)

        assert r.status_code == 422
        assert PlayerAttempt.query.filter_by(player_id=outsider["id"]).count() == 0

    def test_resuming_an_attempt_started_without_a_pin(self, client, env):
        who = {"access_code_id": env["code"]["id"], "player_name": "John Smith", "player_id": env["player"]["id"]}
        started = client.post("/api/play/start", json=who).get_json()

        r = claim(client, env["code"], env["player"]["id"], env["pin"])

        assert r.status_code == 200
        assert r.get_json()["reclaimed"] is True
        assert r.get_json()["attempt"]["attempt_id"] == started["attempt_id"]
        assert PlayerAttempt.query.filter_by(player_id=env["player"]["id"]).count() == 1

    def test_a_submitted_graded_attempt_gets_a_token_but_no_content(self, client, env):
        who = {"access_code_id": env["code"]["id"], "player_name": "John Smith", "player_id": env["player"]["id"]}
        client.post("/api/play/start", json=who)
        client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": env["tf"]["id"], "selected_option_id": env["tf"]["options"][0]["id"]}]})
        attempt = PlayerAttempt.query.filter_by(player_id=env["player"]["id"]).one()
        before = sorted((a.question_id, a.selected_option_id, a.is_correct) for a in
                        Answer.query.filter_by(attempt_id=attempt.id))

        r = claim(client, env["code"], env["player"]["id"], env["pin"])

        assert r.status_code == 200
        assert r.get_json()["attempt"] == {"attempt_id": attempt.id, "status": "submitted"}
        after = sorted((a.question_id, a.selected_option_id, a.is_correct) for a in
                       Answer.query.populate_existing().filter_by(attempt_id=attempt.id))
        assert after == before
        assert check_token(attempt_row(attempt.id), r.get_json()["attempt_token"]).ok


# ---------------------------------------------------------------------------
# Binding: one token, one attempt
# ---------------------------------------------------------------------------


class TestBinding:
    def test_a_token_authenticates_only_its_own_attempt(self, client, env):
        second_quiz, _tf, _ = make_quiz(client, env["headers"], "Install 2")
        second_code = activate(client, env["headers"], second_quiz["id"], [env["player"]["id"]], "Squad 2")

        a = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        b = claim(client, second_code, env["player"]["id"], env["pin"]).get_json()
        attempt_a = attempt_row(a["attempt"]["attempt_id"])
        attempt_b = attempt_row(b["attempt"]["attempt_id"])

        assert check_token(attempt_a, a["attempt_token"]).status == VALID
        assert check_token(attempt_b, a["attempt_token"]).status == MISMATCH
        assert check_token(attempt_a, b["attempt_token"]).status == MISMATCH

    def test_another_players_attempt_rejects_it(self, client, env):
        mate = make_player(client, env["headers"], "Mike", "Beaudry")
        mate_pin = give_pin(client, env["headers"], mate["id"])
        client.post(f"/api/groups", json={"name": "unused"}, headers=env["headers"])
        code = activate(client, env["headers"], env["quiz"]["id"], [env["player"]["id"], mate["id"]], "Both")

        mine = claim(client, code, env["player"]["id"], env["pin"]).get_json()
        theirs = claim(client, code, mate["id"], mate_pin).get_json()

        assert check_token(attempt_row(theirs["attempt"]["attempt_id"]), mine["attempt_token"]).status == MISMATCH

    def test_the_expected_player_must_own_the_attempt(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        attempt = attempt_row(body["attempt"]["attempt_id"])
        assert check_token(attempt, body["attempt_token"], player_id=env["player"]["id"]).ok
        assert check_token(attempt, body["attempt_token"], player_id=env["player"]["id"] + 999).status == MISMATCH

    def test_missing_and_never_issued_are_their_own_reasons(self, client, env):
        who = {"access_code_id": env["code"]["id"], "player_name": "John Smith", "player_id": env["player"]["id"]}
        started = client.post("/api/play/start", json=who).get_json()
        attempt = attempt_row(started["attempt_id"])
        assert check_token(attempt, "anything").status == NOT_ISSUED
        assert check_token(attempt, None).status == MISSING
        assert check_token(attempt, "   ").status == MISSING


# ---------------------------------------------------------------------------
# PIN version and rotation
# ---------------------------------------------------------------------------


class TestRevocationAndRotation:
    def test_a_pin_reset_revokes_the_token_and_keeps_the_attempt(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        attempt_id = body["attempt"]["attempt_id"]

        new_pin = give_pin(client, env["headers"], env["player"]["id"])

        attempt = attempt_row(attempt_id)
        assert check_token(attempt, body["attempt_token"]).status == REVOKED
        assert attempt.player_id == env["player"]["id"]
        # The new PIN brings a new, valid token for the same attempt.
        again = claim(client, env["code"], env["player"]["id"], new_pin).get_json()
        assert again["attempt"]["attempt_id"] == attempt_id
        assert check_token(attempt_row(attempt_id), again["attempt_token"]).status == VALID
        assert attempt_row(attempt_id).token_pin_version == 2

    def test_a_reclaim_rotates_the_token_and_signs_the_old_device_out(self, client, env):
        first = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        attempt_id = first["attempt"]["attempt_id"]
        issued_first = attempt_row(attempt_id).token_issued_at

        second = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()

        assert second["reclaimed"] is True
        assert second["attempt_token"] != first["attempt_token"]
        attempt = attempt_row(attempt_id)
        assert check_token(attempt, first["attempt_token"]).status == MISMATCH
        assert check_token(attempt, second["attempt_token"]).status == VALID
        assert attempt.token_issued_at > issued_first

    def test_a_deleted_credential_is_its_own_reason(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        db.session.execute(text("DELETE FROM player_credentials WHERE player_id = :id"),
                           {"id": env["player"]["id"]})
        db.session.commit()
        attempt = attempt_row(body["attempt"]["attempt_id"])
        assert check_token(attempt, body["attempt_token"]).status == NO_CREDENTIAL


# ---------------------------------------------------------------------------
# Throttle
# ---------------------------------------------------------------------------


T0 = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)


class TestThrottle:
    def _wrong(self, env, now):
        return verify_player_pin(env["player"]["id"], wrong_pin_for(env["pin"]), now=now)

    def test_five_free_then_a_wait_that_refuses_even_the_right_pin(self, env):
        for _ in range(5):
            assert self._wrong(env, T0) == player_credentials.PinCheck(PIN_WRONG)
        sixth = self._wrong(env, T0)
        assert (sixth.outcome, sixth.retry_after_seconds) == (PIN_WRONG, 60)

        during = verify_player_pin(env["player"]["id"], env["pin"], now=T0 + timedelta(seconds=30))
        assert during.outcome == PIN_COOLDOWN
        assert during.retry_after_seconds == 30

        after = verify_player_pin(env["player"]["id"], env["pin"], now=T0 + timedelta(seconds=61))
        assert after.outcome == PIN_OK and after.pin_version == 1

    def test_a_refused_guess_during_a_wait_is_not_counted(self, env):
        for _ in range(6):
            self._wrong(env, T0)
        before = credential_row(env["player"]["id"]).failures_in_window
        self._wrong(env, T0 + timedelta(seconds=10))
        assert credential_row(env["player"]["id"]).failures_in_window == before

    def test_the_wait_doubles_to_fifteen_minutes(self, env):
        now = T0
        for _ in range(5):
            self._wrong(env, now)
        waits = []
        for _ in range(7):
            check = self._wrong(env, now)
            waits.append(check.retry_after_seconds)
            now = credential_row(env["player"]["id"]).next_attempt_at
        assert waits == [60, 120, 240, 480, 900, 900, 900]

    def test_the_wait_never_overflows_however_long_a_guesser_keeps_going(self):
        """REGRESSION. Doubling before capping overflowed timedelta at ~47
        consecutive wrong PINs, which would have made /claim a 500 for exactly
        the player being attacked."""
        from app.services.player_credentials import MAX_WAIT, wait_after

        for count in (15, 47, 60, 1_000, 10_000):
            assert wait_after(count) == MAX_WAIT

    def test_an_hour_without_a_wrong_pin_clears_the_run(self, env):
        for _ in range(6):
            self._wrong(env, T0)
        later = self._wrong(env, T0 + timedelta(minutes=61))
        assert later.retry_after_seconds is None
        assert credential_row(env["player"]["id"]).consecutive_failures == 1

    def test_free_typos_age_out_after_fifteen_minutes(self, env):
        for _ in range(5):
            self._wrong(env, T0)
        assert self._wrong(env, T0 + timedelta(minutes=16)).retry_after_seconds is None

    def test_fifty_wrong_in_the_current_failure_window_locks_until_a_coach_resets(
        self, client, env
    ):
        now = T0
        outcome = None
        for _ in range(50):
            outcome = self._wrong(env, now).outcome
            now = credential_row(env["player"]["id"]).next_attempt_at
        assert outcome == PIN_HARD_LOCKED
        assert verify_player_pin(env["player"]["id"], env["pin"], now=now + timedelta(days=2)).outcome == PIN_HARD_LOCKED

        new_pin = give_pin(client, env["headers"], env["player"]["id"])
        assert verify_player_pin(env["player"]["id"], new_pin).outcome == PIN_OK

    # --- THE HARD LOCK'S FIXED 24-HOUR FAILURE WINDOW (an intentional V1 rule) ---
    #
    # A window opens with the first counted wrong PIN after the previous one
    # expired, and lasts 24 hours from that failure. It is NOT rolling. These
    # tests pin both edges and the one consequence that makes it different from
    # a rolling window, so nobody later "fixes" it without deciding to.

    def _seed_window(self, env, *, failures, opened_at):
        credential = credential_row(env["player"]["id"])
        credential.failures_in_window = failures
        credential.window_started_at = opened_at
        credential.consecutive_failures = 0
        credential.next_attempt_at = None
        credential.locked_at = None
        db.session.commit()

    def test_the_50th_failure_inside_the_current_window_locks(self, env):
        self._seed_window(env, failures=49, opened_at=T0)

        just_inside = T0 + timedelta(hours=24) - timedelta(seconds=1)
        assert self._wrong(env, just_inside).outcome == PIN_HARD_LOCKED
        credential = credential_row(env["player"]["id"])
        assert credential.failures_in_window == 50
        assert credential.window_started_at == T0

    def test_once_the_window_expires_the_next_failure_opens_a_new_one(self, env):
        self._seed_window(env, failures=49, opened_at=T0)

        at_expiry = T0 + timedelta(hours=24)
        assert self._wrong(env, at_expiry).outcome == PIN_WRONG
        credential = credential_row(env["player"]["id"])
        assert credential.failures_in_window == 1
        assert credential.window_started_at == at_expiry
        assert credential.locked_at is None

    def test_the_window_is_fixed_not_rolling(self, env):
        """THE DOCUMENTED BOUNDARY. 49 wrong PINs in the last hour of one
        window and a 50th just after it are 50 wrong PINs inside about an hour
        of real time - a rolling 24-hour rule would lock here. The fixed window
        deliberately does not: they fall in two different windows."""
        self._seed_window(env, failures=49, opened_at=T0)

        after_expiry = T0 + timedelta(hours=24, minutes=1)
        assert self._wrong(env, after_expiry).outcome == PIN_WRONG
        assert credential_row(env["player"]["id"]).locked_at is None

    def test_a_cooldown_refusal_does_not_open_a_window(self, env):
        """Only a COUNTED wrong PIN opens a window; a guess refused during a
        wait is not counted, so it must not start the clock either."""
        for _ in range(6):
            self._wrong(env, T0)
        self._seed_window(env, failures=0, opened_at=None)
        credential = credential_row(env["player"]["id"])
        credential.consecutive_failures = 6
        credential.next_attempt_at = T0 + timedelta(minutes=1)
        db.session.commit()

        assert self._wrong(env, T0 + timedelta(seconds=10)).outcome == PIN_COOLDOWN
        assert credential_row(env["player"]["id"]).window_started_at is None

    def test_a_correct_pin_does_not_reset_the_current_window_count(self, env):
        for _ in range(3):
            self._wrong(env, T0)
        verify_player_pin(env["player"]["id"], env["pin"], now=T0 + timedelta(seconds=1))
        credential = credential_row(env["player"]["id"])
        assert credential.failures_in_window == 3
        assert credential.consecutive_failures == 0

    def test_no_credential_is_not_set(self, client, env):
        other = make_player(client, env["headers"], "No", "Pin")
        assert verify_player_pin(other["id"], "482915").outcome == PIN_NOT_SET

    def test_the_route_returns_429_with_retry_after_and_423_when_locked(self, client, env):
        for _ in range(6):
            claim(client, env["code"], env["player"]["id"], wrong_pin_for(env["pin"]))
        r = claim(client, env["code"], env["player"]["id"], env["pin"])
        assert r.status_code == 429
        assert r.get_json()["reason"] == "pin_cooldown"
        assert int(r.headers["Retry-After"]) > 0

        credential = credential_row(env["player"]["id"])
        credential.locked_at = datetime.now(timezone.utc)
        db.session.commit()
        locked = claim(client, env["code"], env["player"]["id"], env["pin"])
        assert (locked.status_code, locked.get_json()["reason"]) == (423, "pin_locked")

    def test_a_device_already_holding_a_token_is_unaffected(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        for _ in range(8):
            claim(client, env["code"], env["player"]["id"], wrong_pin_for(env["pin"]))
        attempt = attempt_row(body["attempt"]["attempt_id"])
        assert check_token(attempt, body["attempt_token"]).status == VALID


# ---------------------------------------------------------------------------
# Legacy and the unchanged player flow
# ---------------------------------------------------------------------------


class TestLegacyAndUnchangedFlow:
    def test_a_legacy_attempt_never_receives_a_token(self, client, coach_headers):
        quiz, tf_question, _written, code = build_ready_quiz(client, coach_headers)
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "Jordan Smith"})
        legacy = PlayerAttempt.query.filter_by(access_code_id=code["id"], player_name="Jordan Smith").one()
        assert legacy.player_id is None
        # Only now does a canonical Jordan Smith exist, with a PIN.
        jordan = make_player(client, coach_headers, "Jordan", "Smith")
        pin = give_pin(client, coach_headers, jordan["id"])

        r = claim(client, code, jordan["id"], pin)

        assert r.status_code == 409
        assert r.get_json()["reason"] == "legacy_attempt"
        legacy = attempt_row(legacy.id)
        assert (legacy.player_id, legacy.token_hash) == (None, None)
        assert check_token(legacy, "anything").status == LEGACY_ATTEMPT

    def test_free_text_players_keep_playing_exactly_as_before(self, client, coach_headers):
        _quiz, tf_question, _written, code = build_ready_quiz(client, coach_headers)
        r = start_and_submit(client, code["id"], "Alex Lee", [{"question_id": tf_question["id"]}])
        assert r.status_code == 201
        results = client.post("/api/play/results", json={"code": code["code"], "player_name": "Alex Lee"})
        assert results.status_code == 200

    def test_a_tokened_attempt_still_accepts_every_unauthenticated_write(self, client, coach_headers):
        """PHASE 2 IS NOT ENFORCEMENT. This is the test that fails the day
        somebody wires the token in early."""
        player = make_player(client, coach_headers)
        pin = give_pin(client, coach_headers, player["id"])
        quiz, tf, draw = make_quiz(client, coach_headers, with_drawing=True)
        code = activate(client, coach_headers, quiz["id"], [player["id"]])
        body = claim(client, code, player["id"], pin).get_json()
        image_id = next(q for q in body["attempt"]["questions"] if q["id"] == draw["id"])["image"]["id"]
        who = {"access_code_id": code["id"], "player_name": "John Smith", "player_id": player["id"]}

        # No header anywhere below.
        assert client.post("/api/play/start", json=who).status_code == 200
        assert client.post("/api/play/answers", json={
            **who, "question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]}).status_code == 204
        drawing = {"format": "peira.drawing", "version": 1, "coordinate_width": 1200,
                   "coordinate_height": 800, "source": {"image_id": str(image_id)},
                   "strokes": [{"tool": "pen", "color": "#ff0000", "width": 4, "points": [1, 1, 3, 3]}]}
        assert client.put("/api/play/drawing", json={
            **who, "question_id": draw["id"], "document": drawing, "base_revision": None}).status_code == 200
        assert client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]},
            {"question_id": draw["id"], "drawing": drawing}]}).status_code == 201
        assert client.post("/api/play/results", json={
            "code": code["code"], "player_name": "John Smith", "player_id": player["id"]}).status_code == 200


# ---------------------------------------------------------------------------
# Nothing leaks
# ---------------------------------------------------------------------------


class TestNothingLeaks:
    def test_the_raw_token_appears_only_in_the_claim_response(self, client, env, caplog):
        with caplog.at_level(logging.DEBUG):
            body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        token = body["attempt_token"]
        who = {"access_code_id": env["code"]["id"], "player_name": "John Smith", "player_id": env["player"]["id"]}

        surfaces = {
            "start (resume)": client.post("/api/play/start", json=who),
            "validate-code": client.post("/api/play/validate-code", json={"code": env["code"]["code"]}),
            "roster": client.get("/api/players", headers=env["headers"]),
            "submit": client.post("/api/play/submit", json={**who, "answers": [
                {"question_id": env["tf"]["id"], "selected_option_id": env["tf"]["options"][0]["id"]}]}),
            "results": client.post("/api/play/results", json={
                "code": env["code"]["code"], "player_name": "John Smith", "player_id": env["player"]["id"]}),
            "coach responses": client.get(f"/api/quizzes/{env['quiz']['id']}/responses", headers=env["headers"]),
            "profile": client.get(f"/api/players/{env['player']['id']}/history", headers=env["headers"]),
        }
        stored_hash = hash_token(token)
        for label, response in surfaces.items():
            raw = response.get_data(as_text=True)
            assert token not in raw, f"raw token leaked in {label}"
            assert stored_hash not in raw, f"token hash leaked in {label}"
            assert "token_hash" not in raw and "token_pin_version" not in raw, label
            assert env["pin"] not in raw, f"PIN leaked in {label}"
        assert token not in caplog.text
        assert env["pin"] not in caplog.text

    def test_attempt_serialisers_carry_no_token_fields(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        attempt = attempt_row(body["attempt"]["attempt_id"])
        assert not any(k.startswith("token") for k in attempt.to_dict(include_answers=True))
        assert not any(k.startswith("token") for k in body["attempt"])

    def test_no_raw_token_is_stored_anywhere_on_the_row(self, client, env):
        body = claim(client, env["code"], env["player"]["id"], env["pin"]).get_json()
        row = db.session.execute(
            text("SELECT * FROM player_attempts WHERE id = :id"), {"id": body["attempt"]["attempt_id"]}
        ).mappings().one()
        for column, value in row.items():
            assert body["attempt_token"] not in str(value), f"raw token in column {column}"
