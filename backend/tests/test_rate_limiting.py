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
    # 200/minute (not 20) - raised in PEIRA-006 so a whole team joining from
    # one shared IP (school/gym/field WiFi) doesn't get throttled; see
    # play.py's validate-code comment. Still finite, so still worth testing.
    client = make_rate_limited_client(monkeypatch)

    responses = [client.post("/api/play/validate-code", json={"code": "BADCOD"}) for _ in range(201)]

    statuses = [r.status_code for r in responses]
    assert statuses.count(404) == 200  # the configured "200 per minute" limit
    assert statuses[-1] == 429


def test_a_realistic_team_size_sharing_one_ip_is_not_rate_limited(monkeypatch):
    """PEIRA-006 regression: a real team joining from one shared field/gym/
    school WiFi network shares a single public IP, and every /play/* limit
    is keyed per-IP. Before this fix, 20-60/minute meant a roster of just
    ~20-25 players joining together would get 429'd before most of them
    could even validate the code - see backend/loadtest's stage_25 run,
    which caught this with 0 of 25 simulated players reaching /submit.
    This test proves a full-size roster (60, comfortably more than the old
    20/60 limits and comfortably under the new 200/1000 ones) can all
    validate, start, autosave every answer, and submit - one Flask test
    client, so one shared "IP" (REMOTE_ADDR), same as this whole scenario."""
    client = make_rate_limited_client(monkeypatch)

    coach = client.post(
        "/api/auth/register",
        json={
            "username": "team_coach",
            "email": "team_coach@example.com",
            "password": "correct horse battery staple",
            "organization": "Rate Limit Test Org",
        },
    ).get_json()
    headers = {"Authorization": f"Bearer {coach['access_token']}"}

    quiz = client.post("/api/quizzes", json={"title": "Full Roster Quiz"}, headers=headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this cover 2?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    ).get_json()

    num_players = 60
    players = [f"Player {i:03d}" for i in range(num_players)]
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": players}, headers=headers)
    access_code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=headers).get_json()

    statuses = []
    for player_name in players:
        statuses.append(client.post("/api/play/validate-code", json={"code": access_code["code"]}).status_code)
        statuses.append(
            client.post(
                "/api/play/start",
                json={"access_code_id": access_code["id"], "player_name": player_name},
            ).status_code
        )
        statuses.append(
            client.post(
                "/api/play/answers",
                json={
                    "access_code_id": access_code["id"],
                    "player_name": player_name,
                    "question_id": question["id"],
                    "selected_option_id": question["options"][0]["id"],
                },
            ).status_code
        )
        statuses.append(
            client.post(
                "/api/play/submit",
                json={
                    "access_code_id": access_code["id"],
                    "player_name": player_name,
                    "answers": [{"question_id": question["id"], "selected_option_id": question["options"][0]["id"]}],
                },
            ).status_code
        )

    assert 429 not in statuses, f"{statuses.count(429)} of {len(statuses)} requests were rate-limited"
    assert statuses.count(200) == num_players  # validate-code
    assert statuses.count(201) == num_players * 2  # start (first time) + submit
    assert statuses.count(204) == num_players  # answers


def test_login_is_rate_limited(monkeypatch):
    client = make_rate_limited_client(monkeypatch)
    payload = {"email": "nobody@example.com", "password": "wrong-password"}

    responses = [client.post("/api/auth/login", json=payload) for _ in range(11)]

    statuses = [r.status_code for r in responses]
    assert statuses.count(401) == 10  # the configured "10 per minute" limit
    assert statuses[-1] == 429


def test_rate_limit_response_has_a_readable_message_not_the_raw_limit_string(monkeypatch):
    client = make_rate_limited_client(monkeypatch)
    payload = {"email": "nobody@example.com", "password": "wrong-password"}

    responses = [client.post("/api/auth/login", json=payload) for _ in range(11)]

    body = responses[-1].get_json()
    assert body["error"] == "Too many requests. Please wait a moment and try again."


def test_invite_creation_is_rate_limited(monkeypatch):
    """Organization-management routes had no rate limit at all until this
    was added - confirmed by grepping organizations.py before this fix.
    Lower severity than the public/unauthenticated routes above (this one's
    already behind admin-only auth), but still worth a real limit."""
    client = make_rate_limited_client(monkeypatch)

    coach = client.post(
        "/api/auth/register",
        json={
            "username": "invite_admin",
            "email": "invite_admin@example.com",
            "password": "correct horse battery staple",
            "organization": "Rate Limit Test Org",
        },
    ).get_json()
    headers = {"Authorization": f"Bearer {coach['access_token']}"}

    responses = [client.post("/api/organizations/invites", headers=headers) for _ in range(21)]

    statuses = [r.status_code for r in responses]
    assert statuses.count(201) == 20  # the configured "20 per minute" limit
    assert statuses[-1] == 429
