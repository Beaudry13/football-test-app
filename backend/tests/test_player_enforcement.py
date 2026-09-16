"""PHASE 3A - the backend authentication core.

ENFORCEMENT IS OFF BY DEFAULT, AND THE EXISTING SUITE IS THE PROOF THAT OFF
CHANGES NOTHING. Every test here that expects a refusal turns enforcement on
explicitly, with dates, for itself.

What this slice builds and these tests pin:
* the cutover configuration, validated at startup;
* which codes are secured - by activation time and a hard date, never expiry;
* /claim as ONE transaction, and a token alternative to the PIN;
* token checks on answers, check, drawing and submit, made against a
  row-locked attempt so a rotation cannot slip between check and write;
* the reason-code contract;
* the newest submitted attempt on /results.

What it does NOT do: results authentication, the name-only fences, the
activation gate, and any frontend. The impersonation vulnerability is not
closed by this slice.
"""

import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app import create_app
from app.config import BaseConfig, TestingConfig
from app.extensions import db
from app.models import Answer, AttemptStatus, PlayerAttempt, PlayerCredential
from app.models.assessment_mode import PRACTICE
from app.services import player_credentials
from app.services.attempt_tokens import TOKEN_HEADER, check_token, hash_token
from app.services.player_enforcement import (
    MAX_COMPAT_WINDOW,
    EnforcementConfigError,
    EnforcementSettings,
    is_code_secured,
    parse_settings,
)
from tests.test_attempt_tokens import (
    activate,
    attempt_row,
    claim,
    credential_row,
    give_pin,
    make_player,
    make_quiz,
    wrong_pin_for,
)
from tests.test_play_and_grading import build_ready_quiz

NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def enforce(app, monkeypatch):
    """Turn enforcement on for this test only, with the given window."""

    def _set(cutover: datetime, compat: datetime):
        monkeypatch.setitem(app.config, "PLAYER_PIN_ENFORCEMENT", True)
        monkeypatch.setitem(app.config, "PLAYER_PIN_CUTOVER_AT", cutover.isoformat())
        monkeypatch.setitem(app.config, "PLAYER_PIN_COMPAT_UNTIL", compat.isoformat())

    return _set


@pytest.fixture
def secured(enforce):
    """Enforcement on; any code activated from now on is secured."""
    enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))


def build(client, headers, *, practice=False, with_drawing=True, pin=True, name=("John", "Smith")):
    player = make_player(client, headers, *name)
    player_pin = give_pin(client, headers, player["id"]) if pin else None
    quiz, tf, draw = make_quiz(client, headers, with_drawing=with_drawing)
    group = client.post("/api/groups", json={"name": f"G{player['id']}"}, headers=headers).get_json()
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=headers)
    payload = {"group_ids": [group["id"]]}
    if practice:
        payload["mode"] = "PRACTICE"
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json=payload, headers=headers).get_json()
    assert "code" in code, code
    who = {"access_code_id": code["id"], "player_name": player["full_name"], "player_id": player["id"]}
    return SimpleNamespace(player=player, pin=player_pin, quiz=quiz, tf=tf, draw=draw, code=code, who=who)


def token_headers(token):
    return {TOKEN_HEADER: token} if token else {}


def drawing_for(image_id):
    return {"format": "peira.drawing", "version": 1, "coordinate_width": 1200,
            "coordinate_height": 800, "source": {"image_id": str(image_id)},
            "strokes": [{"tool": "pen", "color": "#ff0000", "width": 4, "points": [1, 1, 3, 3]}]}


def send(client, route, env, token=None, image_id=None):
    """One protected write, as its route expects it."""
    headers = token_headers(token)
    answer = {"question_id": env.tf["id"], "selected_option_id": env.tf["options"][0]["id"]}
    if route == "answers":
        return client.post("/api/play/answers", json={**env.who, **answer}, headers=headers)
    if route == "check":
        return client.post("/api/play/check", json={**env.who, "question_id": env.tf["id"]}, headers=headers)
    if route == "drawing":
        return client.put("/api/play/drawing", json={
            **env.who, "question_id": env.draw["id"], "document": drawing_for(image_id), "base_revision": None,
        }, headers=headers)
    if route == "submit":
        answers = [answer]
        if env.draw is not None:
            answers.append({"question_id": env.draw["id"], "drawing": drawing_for(image_id)})
        return client.post("/api/play/submit", json={**env.who, "answers": answers}, headers=headers)
    raise AssertionError(route)


SUCCESS = {"answers": 204, "check": 200, "drawing": 200, "submit": 201}


def claimed(client, env):
    r = claim(client, env.code, env.player["id"], env.pin)
    assert r.status_code in (200, 201), r.get_json()
    body = r.get_json()
    image_id = None
    if env.draw is not None and "questions" in body["attempt"]:
        image_id = next(q for q in body["attempt"]["questions"] if q["id"] == env.draw["id"])["image"]["id"]
    return body["attempt_token"], body["attempt"]["attempt_id"], image_id


def reason(response):
    return (response.get_json() or {}).get("reason")


def set_activated_at(code_id, when):
    db.session.execute(text("UPDATE access_codes SET activated_at = :w WHERE id = :id"),
                       {"w": when, "id": code_id})
    db.session.commit()


# Thread helpers for the lock tests. Each thread gets its own test client, so its
# own application context, session and database connection.

def in_thread(app, fn):
    out = {}

    def run():
        with app.test_client() as c:
            try:
                response = fn(c)
                out["status"], out["json"] = response.status_code, response.get_json()
            except Exception as exc:  # surfaced by the assertions below
                out["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    return thread, out


def wait_for_lock_waiters(count, timeout=15.0):
    deadline = time.monotonic() + timeout
    with db.engine.connect() as conn:
        while time.monotonic() < deadline:
            waiting = conn.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND wait_event_type = 'Lock'"
            )).scalar()
            if waiting >= count:
                return
            time.sleep(0.05)
    raise AssertionError(f"expected {count} request(s) blocked on a row lock; none arrived")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class TestConfig:
    def test_enforcement_defaults_off(self):
        assert BaseConfig.PLAYER_PIN_ENFORCEMENT is False
        assert TestingConfig.PLAYER_PIN_ENFORCEMENT is False

    def test_missing_dates_are_fine_while_off(self):
        assert parse_settings({"PLAYER_PIN_ENFORCEMENT": False}) == EnforcementSettings(enabled=False)
        # Even garbage is not read while off.
        assert not parse_settings({"PLAYER_PIN_ENFORCEMENT": "false",
                                   "PLAYER_PIN_CUTOVER_AT": "nonsense"}).enabled

    @pytest.mark.parametrize("missing", ["PLAYER_PIN_CUTOVER_AT", "PLAYER_PIN_COMPAT_UNTIL"])
    def test_on_without_a_date_fails(self, missing):
        config = {"PLAYER_PIN_ENFORCEMENT": True,
                  "PLAYER_PIN_CUTOVER_AT": "2026-10-01T06:00:00+00:00",
                  "PLAYER_PIN_COMPAT_UNTIL": "2026-10-08T06:00:00+00:00"}
        config[missing] = None
        with pytest.raises(EnforcementConfigError, match=missing):
            parse_settings(config)

    def test_a_naive_timestamp_fails(self):
        with pytest.raises(EnforcementConfigError, match="timezone"):
            parse_settings({"PLAYER_PIN_ENFORCEMENT": True,
                            "PLAYER_PIN_CUTOVER_AT": "2026-10-01T06:00:00",
                            "PLAYER_PIN_COMPAT_UNTIL": "2026-10-08T06:00:00+00:00"})

    def test_an_unparseable_timestamp_fails(self):
        with pytest.raises(EnforcementConfigError, match="ISO 8601"):
            parse_settings({"PLAYER_PIN_ENFORCEMENT": True,
                            "PLAYER_PIN_CUTOVER_AT": "next tuesday",
                            "PLAYER_PIN_COMPAT_UNTIL": "2026-10-08T06:00:00+00:00"})

    @pytest.mark.parametrize("compat", ["2026-10-01T06:00:00+00:00", "2026-09-30T06:00:00+00:00"])
    def test_compat_must_come_after_cutover(self, compat):
        with pytest.raises(EnforcementConfigError, match="after"):
            parse_settings({"PLAYER_PIN_ENFORCEMENT": True,
                            "PLAYER_PIN_CUTOVER_AT": "2026-10-01T06:00:00+00:00",
                            "PLAYER_PIN_COMPAT_UNTIL": compat})

    def test_a_window_over_fourteen_days_fails(self):
        with pytest.raises(EnforcementConfigError, match="14 days"):
            parse_settings({"PLAYER_PIN_ENFORCEMENT": True,
                            "PLAYER_PIN_CUTOVER_AT": "2026-10-01T06:00:00+00:00",
                            "PLAYER_PIN_COMPAT_UNTIL": "2026-10-15T06:00:01+00:00"})

    def test_a_valid_configuration_parses(self):
        settings = parse_settings({"PLAYER_PIN_ENFORCEMENT": "true",
                                   "PLAYER_PIN_CUTOVER_AT": "2026-10-01T06:00:00Z",
                                   "PLAYER_PIN_COMPAT_UNTIL": "2026-10-15T06:00:00+00:00"})
        assert settings.enabled
        assert settings.compat_until - settings.cutover_at == MAX_COMPAT_WINDOW

    def test_startup_fails_loudly_on_a_bad_configuration(self, monkeypatch):
        monkeypatch.setattr(TestingConfig, "PLAYER_PIN_ENFORCEMENT", True)
        with pytest.raises(EnforcementConfigError):
            create_app("testing")

    def test_startup_succeeds_with_a_valid_configuration(self, monkeypatch):
        monkeypatch.setattr(TestingConfig, "PLAYER_PIN_ENFORCEMENT", True)
        monkeypatch.setattr(TestingConfig, "PLAYER_PIN_CUTOVER_AT", "2026-10-01T06:00:00+00:00")
        monkeypatch.setattr(TestingConfig, "PLAYER_PIN_COMPAT_UNTIL", "2026-10-08T06:00:00+00:00")
        assert create_app("testing").config["PLAYER_PIN_ENFORCEMENT"] is True


# ---------------------------------------------------------------------------
# Secured codes
# ---------------------------------------------------------------------------


class TestSecuredCodes:
    CUTOVER = datetime(2026, 10, 1, 6, tzinfo=timezone.utc)
    COMPAT = datetime(2026, 10, 8, 6, tzinfo=timezone.utc)
    ON = EnforcementSettings(enabled=True, cutover_at=CUTOVER, compat_until=COMPAT)

    def code(self, activated_at, expires_at=None):
        return SimpleNamespace(activated_at=activated_at, expires_at=expires_at)

    def test_off_secures_nothing(self):
        code = self.code(self.CUTOVER + timedelta(days=1))
        assert not is_code_secured(code, now=self.COMPAT + timedelta(days=30),
                                   settings=EnforcementSettings(enabled=False))

    def test_a_code_activated_at_or_after_cutover_is_secured(self):
        assert is_code_secured(self.code(self.CUTOVER), now=self.CUTOVER, settings=self.ON)
        assert is_code_secured(self.code(self.CUTOVER + timedelta(hours=1)),
                               now=self.CUTOVER + timedelta(hours=1), settings=self.ON)

    def test_an_old_code_during_the_window_is_not(self):
        old = self.code(self.CUTOVER - timedelta(days=2))
        assert not is_code_secured(old, now=self.COMPAT - timedelta(seconds=1), settings=self.ON)

    def test_an_old_code_after_the_hard_date_is(self):
        old = self.code(self.CUTOVER - timedelta(days=2))
        assert is_code_secured(old, now=self.COMPAT, settings=self.ON)

    def test_extending_expiry_does_not_extend_the_exemption(self):
        extended = self.code(self.CUTOVER - timedelta(days=2),
                             expires_at=self.COMPAT + timedelta(days=90))
        assert is_code_secured(extended, now=self.COMPAT + timedelta(minutes=1), settings=self.ON)


# ---------------------------------------------------------------------------
# /claim as one transaction
# ---------------------------------------------------------------------------


class TestClaimTransaction:
    def test_a_correct_pin_claim_issues_a_token(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id, _ = claimed(client, env)
        assert check_token(attempt_row(attempt_id), token).ok

    def test_a_correct_pin_is_not_committed_before_the_claim_finishes(self, client, coach_headers):
        """THE AUDIT FINDING. A correct PIN used to commit on its own, before the
        attempt was found. Now a claim that fails after the PIN leaves the
        throttle exactly as it was - the success bookkeeping rolls back with it."""
        env = build(client, coach_headers, with_drawing=False)
        outsider = make_player(client, coach_headers, "Not", "Grouped")
        outsider_pin = give_pin(client, coach_headers, outsider["id"])
        credential = credential_row(outsider["id"])
        credential.consecutive_failures = 3
        db.session.commit()

        r = claim(client, env.code, outsider["id"], outsider_pin)

        assert (r.status_code, reason(r)) == (422, "not_eligible")
        assert credential_row(outsider["id"]).consecutive_failures == 3
        assert PlayerAttempt.query.filter_by(player_id=outsider["id"]).count() == 0

    def test_verify_without_commit_holds_the_success_uncommitted(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        credential = credential_row(env.player["id"])
        credential.consecutive_failures = 2
        db.session.commit()

        check = player_credentials.verify_player_pin(env.player["id"], env.pin, commit_on_success=False)

        assert check.ok
        with db.engine.connect() as other:
            committed = other.execute(
                text("SELECT consecutive_failures FROM player_credentials WHERE player_id = :id"),
                {"id": env.player["id"]},
            ).scalar()
        assert committed == 2, "a correct PIN must not commit on its own"
        db.session.rollback()

    def test_a_wrong_pin_failure_still_persists(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        r = claim(client, env.code, env.player["id"], wrong_pin_for(env.pin))
        assert (r.status_code, reason(r)) == (401, "pin_incorrect")
        assert credential_row(env.player["id"]).consecutive_failures == 1

    def test_a_cooldown_persists(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        for _ in range(6):
            claim(client, env.code, env.player["id"], wrong_pin_for(env.pin))
        assert credential_row(env.player["id"]).next_attempt_at is not None
        r = claim(client, env.code, env.player["id"], env.pin)
        assert (r.status_code, reason(r)) == (429, "pin_cooldown")

    def test_neither_pin_nor_token_is_pin_required(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        r = client.post("/api/play/claim", json={"access_code_id": env.code["id"], "player_id": env.player["id"]})
        assert (r.status_code, reason(r)) == (401, "pin_required")

    def test_concurrent_correct_claims_serialize(self, app, client, coach_headers):
        """Two devices, the right PIN, the same instant. Both are held on the
        credential lock; the first creates the attempt, the second resumes and
        rotates it - so exactly one attempt exists and exactly one token works,
        the one from the claim that committed last."""
        env = build(client, coach_headers, with_drawing=False)
        pid = env.player["id"]

        with db.engine.connect() as conn:
            trans = conn.begin()
            conn.execute(text("SELECT player_id FROM player_credentials WHERE player_id = :id FOR UPDATE"),
                         {"id": pid})
            t1, r1 = in_thread(app, lambda c: claim(c, env.code, pid, env.pin))
            t2, r2 = in_thread(app, lambda c: claim(c, env.code, pid, env.pin))
            wait_for_lock_waiters(2)
            trans.rollback()
        t1.join(30)
        t2.join(30)

        for out in (r1, r2):
            assert "error" not in out, out.get("error")
        assert sorted([r1["status"], r2["status"]]) == [200, 201]
        attempts = PlayerAttempt.query.filter_by(player_id=pid).all()
        assert len(attempts) == 1
        attempt = attempt_row(attempts[0].id)
        valid = [out for out in (r1, r2) if check_token(attempt, out["json"]["attempt_token"]).ok]
        assert len(valid) == 1
        assert valid[0]["json"]["reclaimed"] is True, "the last to commit resumed and rotated"


# ---------------------------------------------------------------------------
# /claim with a token (R1)
# ---------------------------------------------------------------------------


class TestTokenClaim:
    def token_claim(self, client, env, token, player_id=None, code=None):
        code = code or env.code
        return client.post(
            "/api/play/claim",
            json={"access_code_id": code["id"], "player_id": player_id or env.player["id"]},
            headers=token_headers(token),
        )

    def test_a_valid_token_continues_without_rotating(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id, _ = claimed(client, env)
        before = attempt_row(attempt_id)
        before_hash, before_issued = before.token_hash, before.token_issued_at

        r = self.token_claim(client, env, token)

        assert r.status_code == 200
        body = r.get_json()
        assert body["attempt_token"] is None
        assert body["attempt"]["attempt_id"] == attempt_id
        assert body["attempt"]["questions"]
        after = attempt_row(attempt_id)
        assert (after.token_hash, after.token_issued_at) == (before_hash, before_issued)
        assert check_token(after, token).ok
        # The throttle is never touched by a token claim.
        assert credential_row(env.player["id"]).consecutive_failures == 0

    def test_another_attempts_token_fails(self, client, coach_headers):
        first = build(client, coach_headers, with_drawing=False)
        token, _, _ = claimed(client, first)
        # Same player, a second quiz and code.
        quiz2, _tf, _ = make_quiz(client, coach_headers, "Install 2")
        code2 = activate(client, coach_headers, quiz2["id"], [first.player["id"]], "Second")
        claim(client, code2, first.player["id"], first.pin)

        r = self.token_claim(client, first, token, code=code2)
        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_a_code_with_no_attempt_for_the_player_fails(self, client, coach_headers):
        first = build(client, coach_headers, with_drawing=False)
        token, _, _ = claimed(client, first)
        quiz2, _tf, _ = make_quiz(client, coach_headers, "Install 3")
        code2 = activate(client, coach_headers, quiz2["id"], [first.player["id"]], "Third")
        r = self.token_claim(client, first, token, code=code2)
        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_another_players_token_fails(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, _, _ = claimed(client, env)
        mate = make_player(client, coach_headers, "Mike", "Beaudry")
        mate_pin = give_pin(client, coach_headers, mate["id"])
        code = activate(client, coach_headers, env.quiz["id"], [env.player["id"], mate["id"]], "Both")
        claim(client, code, env.player["id"], env.pin)
        mine = claim(client, code, env.player["id"], env.pin).get_json()["attempt_token"]
        claim(client, code, mate["id"], mate_pin)

        r = client.post("/api/play/claim", json={"access_code_id": code["id"], "player_id": mate["id"]},
                        headers=token_headers(mine))
        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert token  # the first code's token is unrelated and unused here

    def test_a_revoked_token_says_so(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, _, _ = claimed(client, env)
        give_pin(client, coach_headers, env.player["id"])

        r = self.token_claim(client, env, token)
        assert (r.status_code, reason(r)) == (401, "token_revoked")

    def test_a_typed_pin_wins_over_a_stale_token(self, client, coach_headers):
        """The recovery path. After token_revoked the player types the new PIN,
        and their device is still attaching the old token - that must work."""
        env = build(client, coach_headers, with_drawing=False)
        old_token, attempt_id, _ = claimed(client, env)
        new_pin = give_pin(client, coach_headers, env.player["id"])

        r = client.post("/api/play/claim", json={
            "access_code_id": env.code["id"], "player_id": env.player["id"], "pin": new_pin,
        }, headers=token_headers(old_token))

        assert r.status_code == 200, r.get_json()
        body = r.get_json()
        assert body["attempt"]["attempt_id"] == attempt_id
        assert check_token(attempt_row(attempt_id), body["attempt_token"]).ok
        assert not check_token(attempt_row(attempt_id), old_token).ok

    def test_a_valid_token_does_not_excuse_a_wrong_pin(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id, _ = claimed(client, env)

        r = client.post("/api/play/claim", json={
            "access_code_id": env.code["id"], "player_id": env.player["id"], "pin": wrong_pin_for(env.pin),
        }, headers=token_headers(token))

        assert (r.status_code, reason(r)) == (401, "pin_incorrect")
        assert credential_row(env.player["id"]).consecutive_failures == 1
        assert check_token(attempt_row(attempt_id), token).ok, "a refused claim rotates nothing"

    def test_a_forged_token_is_generic_invalid_never_revoked(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        claimed(client, env)
        give_pin(client, coach_headers, env.player["id"])  # version is now stale too
        r = self.token_claim(client, env, "not-the-token-at-all-aaaaaaaaaaaaaaaaaaaaaa")
        assert (r.status_code, reason(r)) == (401, "token_invalid")

    def test_a_legacy_attempt_can_never_be_reached_by_token(self, client, coach_headers):
        quiz, _tf, _written, code = build_ready_quiz(client, coach_headers)
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": "Jordan Smith"})
        jordan = make_player(client, coach_headers, "Jordan", "Smith")
        give_pin(client, coach_headers, jordan["id"])

        r = client.post("/api/play/claim", json={"access_code_id": code["id"], "player_id": jordan["id"]},
                        headers=token_headers("anything-at-all-aaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        assert (r.status_code, reason(r)) == (401, "token_invalid")
        legacy = PlayerAttempt.query.filter_by(access_code_id=code["id"], player_name="Jordan Smith").one()
        assert (legacy.player_id, legacy.token_hash) == (None, None)

    def test_a_submitted_graded_attempt_returns_its_status_only(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False)
        token, attempt_id, _ = claimed(client, env)
        send(client, "submit", SimpleNamespace(**{**env.__dict__, "draw": None}))

        r = self.token_claim(client, env, token)
        assert r.status_code == 200
        assert r.get_json()["attempt"] == {"attempt_id": attempt_id, "status": "submitted"}
        assert r.get_json()["attempt_token"] is None

    def test_a_finished_practice_run_retakes_with_a_new_token(self, client, coach_headers):
        env = build(client, coach_headers, practice=True, with_drawing=False)
        token, attempt_id, _ = claimed(client, env)
        send(client, "submit", SimpleNamespace(**{**env.__dict__, "draw": None}))

        r = self.token_claim(client, env, token)

        assert r.status_code == 201
        body = r.get_json()
        assert body["attempt"]["attempt_id"] != attempt_id
        assert check_token(attempt_row(body["attempt"]["attempt_id"]), body["attempt_token"]).ok
        assert PlayerAttempt.query.filter_by(player_id=env.player["id"]).count() == 2


# ---------------------------------------------------------------------------
# Write authorization
# ---------------------------------------------------------------------------

ROUTES = ["answers", "check", "drawing", "submit"]


def env_for(client, headers, route, **kw):
    return build(client, headers, practice=(route == "check"), with_drawing=(route != "check"), **kw)


class TestWriteAuthSecured:
    @pytest.mark.parametrize("route", ROUTES)
    def test_no_token_is_token_missing(self, client, coach_headers, secured, route):
        env = env_for(client, coach_headers, route)
        _token, _id, image_id = claimed(client, env)
        r = send(client, route, env, None, image_id)
        assert (r.status_code, reason(r)) == (401, "token_missing")

    @pytest.mark.parametrize("route", ROUTES)
    def test_a_wrong_token_is_token_invalid(self, client, coach_headers, secured, route):
        env = env_for(client, coach_headers, route)
        _token, _id, image_id = claimed(client, env)
        r = send(client, route, env, "wrong-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", image_id)
        assert (r.status_code, reason(r)) == (401, "token_invalid")

    @pytest.mark.parametrize("route", ROUTES)
    def test_a_matching_token_under_a_reset_pin_is_token_revoked(self, client, coach_headers, secured, route):
        env = env_for(client, coach_headers, route)
        token, _id, image_id = claimed(client, env)
        give_pin(client, coach_headers, env.player["id"])
        r = send(client, route, env, token, image_id)
        assert (r.status_code, reason(r)) == (401, "token_revoked")

    @pytest.mark.parametrize("route", ROUTES)
    def test_a_valid_token_writes(self, client, coach_headers, secured, route):
        env = env_for(client, coach_headers, route)
        token, _id, image_id = claimed(client, env)
        if route == "check":
            assert send(client, "answers", env, token).status_code == 204
        r = send(client, route, env, token, image_id)
        assert r.status_code == SUCCESS[route], r.get_json()

    def test_an_unauthenticated_caller_learns_nothing_about_submission(self, client, coach_headers, secured):
        env = env_for(client, coach_headers, "submit")
        token, _id, image_id = claimed(client, env)
        assert send(client, "submit", env, token, image_id).status_code == 201
        # Auth is checked BEFORE "already submitted", so a tokenless caller
        # cannot use the error to learn that the player finished.
        r = send(client, "answers", env, None)
        assert (r.status_code, reason(r)) == (401, "token_missing")

    def test_a_legacy_free_text_attempt_still_writes_without_a_token(self, client, coach_headers, secured):
        _quiz, tf, _written, code = build_ready_quiz(client, coach_headers)
        who = {"access_code_id": code["id"], "player_name": "Alex Lee"}
        client.post("/api/play/start", json=who)
        r = client.post("/api/play/answers", json={
            **who, "question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]})
        assert r.status_code == 204


class TestWriteAuthOff:
    @pytest.mark.parametrize("route", ROUTES)
    def test_enforcement_off_writes_without_a_token_exactly_as_before(self, client, coach_headers, route):
        env = env_for(client, coach_headers, route)
        _token, _id, image_id = claimed(client, env)  # a token exists and is ignored
        if route == "check":
            assert send(client, "answers", env, None).status_code == 204
        r = send(client, route, env, None, image_id)
        assert r.status_code == SUCCESS[route], r.get_json()


class TestCompatibilityWindow:
    def old_code_window(self, enforce, code_id):
        enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))
        set_activated_at(code_id, NOW - timedelta(days=2))

    def test_a_player_without_a_pin_on_an_old_code_writes_tokenless(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        self.old_code_window(enforce, env.code["id"])
        assert client.post("/api/play/start", json=env.who).status_code == 201
        assert send(client, "answers", env).status_code == 204

    def test_a_player_with_a_pin_on_an_old_code_needs_the_token(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        # Started BEFORE enforcement is on. Since Phase 3b, /start itself refuses
        # a player with a PIN on a protected code, so this is how a never-tokened
        # attempt of such a player comes to exist.
        assert client.post("/api/play/start", json=env.who).status_code == 201  # never tokened
        self.old_code_window(enforce, env.code["id"])
        r = send(client, "answers", env)
        assert (r.status_code, reason(r)) == (401, "token_missing")

    def test_once_tokened_always_tokened(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False)
        self.old_code_window(enforce, env.code["id"])
        token, attempt_id, _ = claimed(client, env)
        # Even if the player's credential disappeared, the tokened attempt keeps
        # requiring a token.
        db.session.execute(text("DELETE FROM player_credentials WHERE player_id = :id"),
                           {"id": env.player["id"]})
        db.session.commit()
        r = send(client, "answers", env)
        assert (r.status_code, reason(r)) == (401, "token_missing")
        assert attempt_row(attempt_id).token_hash == hash_token(token)

    def test_an_old_code_after_the_hard_date_is_secured(self, client, coach_headers, enforce):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        client.post("/api/play/start", json=env.who)
        enforce(NOW - timedelta(days=10), NOW - timedelta(days=1))
        set_activated_at(env.code["id"], NOW - timedelta(days=11))
        r = send(client, "answers", env)
        assert (r.status_code, reason(r)) == (401, "token_missing")


# ---------------------------------------------------------------------------
# Row locks: the token is checked under the attempt lock
# ---------------------------------------------------------------------------


class TestRowLocking:
    @pytest.mark.parametrize("route", ["answers", "submit"])
    def test_a_rotation_while_a_write_waits_is_seen_by_that_write(
        self, app, client, coach_headers, secured, route
    ):
        """THE TIME-OF-CHECK GAP, CLOSED. The write blocks on the attempt lock; the
        token is rotated and committed meanwhile; when the write gets the lock it
        checks the ROTATED token and is refused."""
        env = env_for(client, coach_headers, route)
        token, attempt_id, image_id = claimed(client, env)

        with db.engine.connect() as conn:
            trans = conn.begin()
            conn.execute(text("SELECT id FROM player_attempts WHERE id = :id FOR UPDATE"), {"id": attempt_id})
            thread, out = in_thread(app, lambda c: send(c, route, env, token, image_id))
            wait_for_lock_waiters(1)
            conn.execute(text("UPDATE player_attempts SET token_hash = :h WHERE id = :id"),
                         {"h": hash_token("another-device-token"), "id": attempt_id})
            trans.commit()
        thread.join(30)

        assert "error" not in out, out.get("error")
        assert (out["status"], out["json"]["reason"]) == (401, "token_invalid")
        assert attempt_row(attempt_id).status == AttemptStatus.IN_PROGRESS

    def test_reclaim_after_submit_gets_a_results_token(self, client, coach_headers, secured):
        env = env_for(client, coach_headers, "submit")
        token, attempt_id, image_id = claimed(client, env)
        assert send(client, "submit", env, token, image_id).status_code == 201

        r = claim(client, env.code, env.player["id"], env.pin)

        assert r.status_code == 200
        assert r.get_json()["attempt"] == {"attempt_id": attempt_id, "status": "submitted"}

    def test_submit_after_reclaim_is_refused(self, client, coach_headers, secured):
        env = env_for(client, coach_headers, "submit")
        old_token, attempt_id, image_id = claimed(client, env)
        claimed(client, env)  # another device reclaims and rotates

        r = send(client, "submit", env, old_token, image_id)

        assert (r.status_code, reason(r)) == (401, "token_invalid")
        assert attempt_row(attempt_id).status == AttemptStatus.IN_PROGRESS


# ---------------------------------------------------------------------------
# Error contract additions on existing routes
# ---------------------------------------------------------------------------


class TestReasonCodes:
    def test_existing_refusals_now_carry_reasons(self, client, coach_headers):
        env = build(client, coach_headers, with_drawing=False, pin=False)
        outsider = make_player(client, coach_headers, "Out", "Sider")

        not_eligible = client.post("/api/play/start", json={
            "access_code_id": env.code["id"], "player_name": "Out Sider", "player_id": outsider["id"]})
        assert (not_eligible.status_code, reason(not_eligible)) == (422, "not_eligible")

        missing = send(client, "answers", env)
        assert (missing.status_code, reason(missing)) == (404, "attempt_not_found")

        client.post("/api/play/start", json=env.who)
        send(client, "submit", SimpleNamespace(**{**env.__dict__, "draw": None}))
        again = client.post("/api/play/start", json=env.who)
        assert (again.status_code, reason(again)) == (409, "already_submitted")
        # Messages and statuses are exactly what they were.
        assert again.get_json()["error"] == "This player has already submitted this Peira"


# ---------------------------------------------------------------------------
# /results: newest submitted attempt, still unauthenticated
# ---------------------------------------------------------------------------


class TestResultsOrdering:
    def two_practice_runs(self, client, headers):
        env = build(client, headers, practice=True, with_drawing=False, pin=False)
        tf = env.tf
        ids = []
        for option in (tf["options"][0], tf["options"][1]):
            client.post("/api/play/start", json=env.who)
            r = client.post("/api/play/submit", json={**env.who, "answers": [
                {"question_id": tf["id"], "selected_option_id": option["id"]}]})
            assert r.status_code == 201, r.get_json()
        ids = [a.id for a in PlayerAttempt.query.filter_by(player_id=env.player["id"]).order_by(PlayerAttempt.id)]
        assert len(ids) == 2
        return env, ids

    def results(self, client, env):
        r = client.post("/api/play/results", json={
            "code": env.code["code"], "player_name": env.player["full_name"], "player_id": env.player["id"]})
        assert r.status_code == 200, r.get_json()
        return r.get_json()

    def test_the_newest_submitted_at_wins(self, client, coach_headers):
        env, (first, second) = self.two_practice_runs(client, coach_headers)
        # Make the FIRST attempt the most recently submitted.
        db.session.execute(text("UPDATE player_attempts SET submitted_at = :t WHERE id = :id"),
                           {"t": NOW, "id": first})
        db.session.execute(text("UPDATE player_attempts SET submitted_at = :t WHERE id = :id"),
                           {"t": NOW - timedelta(hours=1), "id": second})
        db.session.commit()
        assert self.results(client, env)["answers"][0]["your_answer"] == "True"

    def test_id_breaks_a_tie(self, client, coach_headers):
        env, (first, second) = self.two_practice_runs(client, coach_headers)
        db.session.execute(text("UPDATE player_attempts SET submitted_at = :t WHERE id IN (:a, :b)"),
                           {"t": NOW, "a": first, "b": second})
        db.session.commit()
        assert self.results(client, env)["answers"][0]["your_answer"] == "False"

    def test_secured_results_need_the_token_since_phase_3b(self, client, coach_headers, secured):
        """Phase 3a left results open; Phase 3b closed them. The full coverage is
        tests/test_results_auth_and_name_fences.py - this keeps the ordering
        class honest about the rule it now runs under."""
        env = build(client, coach_headers, with_drawing=False)
        token, _id, _ = claimed(client, env)
        send(client, "submit", SimpleNamespace(**{**env.__dict__, "draw": None}), token)
        body = {"code": env.code["code"], "player_name": env.player["full_name"], "player_id": env.player["id"]}
        assert client.post("/api/play/results", json=body).status_code == 401
        assert client.post("/api/play/results", json=body, headers=token_headers(token)).status_code == 200


# ---------------------------------------------------------------------------
# /submit returns the player-safe contract, and nothing else
# ---------------------------------------------------------------------------

SUBMIT_CONTRACT = {"attempt_id", "status", "submitted_at", "mode"}

#: What the old coach serializer (PlayerAttempt.to_dict(include_answers=True))
#: echoed back, plus every credential and token field. Checked as QUOTED KEYS IN
#: THE RAW BODY, not just the parsed top level, so nothing can hide nested.
FORBIDDEN_KEYS = (
    "id", "quiz_id", "access_code_id", "player_id", "player_name", "display_name",
    "jersey_number", "position_at_attempt", "started_at",
    "answers", "question_id", "answer_text", "selected_option_id", "selected_option_ids",
    "is_correct", "coach_feedback", "graded_at", "graded_by_username", "drawing",
    "token_hash", "token_pin_version", "token_issued_at", "attempt_token",
    "pin", "pin_hash", "pin_version", "pin_status",
)


class TestSubmitResponseContract:
    def assert_contract(self, response, attempt_id, *never_echoed):
        assert response.status_code == 201, response.get_json()
        body = response.get_json()
        assert set(body) == SUBMIT_CONTRACT
        row = attempt_row(attempt_id)
        assert body["attempt_id"] == row.id
        assert body["status"] == "submitted" == row.status.value
        assert datetime.fromisoformat(body["submitted_at"]) == row.submitted_at
        assert body["mode"] == row.mode
        raw = response.get_data(as_text=True)
        for key in FORBIDDEN_KEYS:
            assert f'"{key}"' not in raw, f"/submit leaked {key!r}"
        for value in never_echoed:
            assert value not in raw, "/submit echoed player data back"
        return body

    def test_a_graded_canonical_submit_with_a_token_and_a_drawing(self, client, coach_headers):
        env = build(client, coach_headers)
        token, attempt_id, image_id = claimed(client, env)

        r = send(client, "submit", env, token, image_id)

        # "#ff0000" is the stroke colour inside the submitted drawing document.
        body = self.assert_contract(r, attempt_id, env.player["full_name"], token, "#ff0000")
        assert body["mode"] != PRACTICE

    def test_a_practice_submit(self, client, coach_headers):
        env = build(client, coach_headers, practice=True, with_drawing=False, pin=False)
        attempt_id = client.post("/api/play/start", json=env.who).get_json()["attempt_id"]

        r = send(client, "submit", SimpleNamespace(**{**env.__dict__, "draw": None}))

        body = self.assert_contract(r, attempt_id, env.player["full_name"])
        assert body["mode"] == PRACTICE

    def test_a_legacy_name_only_submit_with_a_written_answer(self, client, coach_headers):
        _quiz, tf, written, code = build_ready_quiz(client, coach_headers)
        who = {"access_code_id": code["id"], "player_name": "Alex Lee"}
        attempt_id = client.post("/api/play/start", json=who).get_json()["attempt_id"]

        r = client.post("/api/play/submit", json={**who, "answers": [
            {"question_id": tf["id"], "selected_option_id": tf["options"][0]["id"]},
            {"question_id": written["id"], "answer_text": "I set the edge."},
        ]})

        self.assert_contract(r, attempt_id, "Alex Lee", "I set the edge.")
        # Response shape only: what was stored is exactly as before.
        stored = {a.question_id: a for a in Answer.query.filter_by(attempt_id=attempt_id)}
        assert stored[written["id"]].answer_text == "I set the edge."
        assert stored[tf["id"]].is_correct is True
