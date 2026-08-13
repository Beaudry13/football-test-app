"""M2.3 backend: what a host and a player may see, and when.

THE ONE RULE UNDER TEST
------------------------
The correct option, the explanation, the distribution and a player's own
verdict are the same secret, released only when the coach reveals. Most of
this file is that rule, checked from both sides and at both moments.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import CompetitionSession, Question
from app.services import competition_rounds as rounds


def _quiz(client, headers, count=2, explanation="Two deep safeties beat it."):
    quiz = client.post("/api/quizzes", json={"title": "Coverages"}, headers=headers).get_json()
    for index in range(count):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Which coverage is this? #{index}",
                "question_type": "multiple_choice",
                "answer_explanation": explanation,
                "options": [
                    {"option_text": "Cover 2", "is_correct_answer": True},
                    {"option_text": "Cover 3", "is_correct_answer": False},
                    {"option_text": "Cover 4", "is_correct_answer": False},
                ],
            },
            headers=headers,
        )
        assert response.status_code == 201, response.get_json()
    return quiz["id"]


@pytest.fixture
def env(client, register_coach):
    _, _, headers = register_coach()
    quiz_id = _quiz(client, headers)
    players = [
        client.post(
            "/api/players", json={"first_name": f, "last_name": l}, headers=headers
        ).get_json()
        for f, l in (("Ada", "Lovelace"), ("Grace", "Hopper"), ("Alan", "Turing"))
    ]
    lobby = client.post(
        f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers
    ).get_json()
    tokens = {
        p["full_name"]: client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": p["id"]}
        ).get_json()["reconnect_token"]
        for p in players
    }
    return {"headers": headers, "quiz_id": quiz_id, "players": players, "tokens": tokens,
            "session_id": lobby["id"], "code": lobby["join_code"]}


def _session(env):
    return db.session.get(CompetitionSession, env["session_id"])


def _act(client, env, action):
    return client.post(
        f"/api/competition/sessions/{env['session_id']}/transition",
        json={"action": action, "expected_version": _session(env).version},
        headers=env["headers"],
    )


def _open_now(env, elapsed=1.0):
    session = _session(env)
    session.question_opened_at = datetime.now(timezone.utc) - timedelta(seconds=elapsed)
    session.question_closes_at = session.question_opened_at + timedelta(
        seconds=session.question_time_seconds
    )
    db.session.commit()


def _options(env, round_index=0):
    question = db.session.get(Question, _session(env).question_order[round_index])
    return (
        next(o for o in question.options if o.is_correct_answer),
        next(o for o in question.options if not o.is_correct_answer),
    )


def _player_round(client, env, name):
    return client.get(
        f"/api/competition/{env['code']}/round",
        headers={"X-Competition-Token": env["tokens"][name]},
    )


def _host(client, env):
    return client.get(
        f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
    ).get_json()


def _start(client, env, elapsed=1.0):
    _act(client, env, rounds.START_QUESTION)
    _open_now(env, elapsed)


class TestDuringTheQuestion:
    def test_the_player_gets_the_question_but_not_the_answer(self, client, env):
        _start(client, env)

        response = _player_round(client, env, "Ada Lovelace")
        body = response.get_json()

        assert body["question"]["question_text"].startswith("Which coverage")
        assert len(body["question"]["options"]) == 3
        # THE GATE.
        for option in body["question"]["options"]:
            assert "is_correct_answer" not in option
        assert "correct_option_id" not in body["question"]
        assert "answer_explanation" not in body["question"]
        assert body["result"] is None

    def test_the_raw_payload_contains_no_answer_hint(self, client, env):
        _start(client, env)
        raw = _player_round(client, env, "Ada Lovelace").get_data(as_text=True)
        for leak in ("is_correct", "correct_option_id", "answer_explanation",
                     "Two deep safeties"):
            assert leak not in raw

    def test_the_host_is_gated_identically(self, client, env):
        """The projector faces the room. It must not show the answer early
        any more than a phone may."""
        _start(client, env)
        raw = str(_host(client, env)["round"])
        assert "answer_explanation" not in raw
        assert "correct_option_id" not in raw

    def test_the_host_sees_counts_only_while_answering(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )

        round_payload = _host(client, env)["round"]

        assert round_payload["answered_count"] == 1
        assert round_payload["participant_count"] == 3
        # No distribution while answering - it would steer the room.
        assert round_payload["distribution"] is None
        assert round_payload["all_in"] is False

    def test_the_host_round_never_names_who_has_not_answered(self, client, env):
        _start(client, env)
        raw = str(_host(client, env)["round"])
        for player in env["players"]:
            assert player["full_name"] not in raw

    def test_all_in_appears_once_everyone_has_answered(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        for name in env["tokens"]:
            client.post(
                f"/api/competition/{env['code']}/answer",
                json={"round_index": 0, "option_id": correct.id},
                headers={"X-Competition-Token": env["tokens"][name]},
            )

        round_payload = _host(client, env)["round"]

        assert round_payload["all_in"] is True
        # Still nothing revealed, and still QUESTION_OPEN - the coach decides.
        assert round_payload["distribution"] is None
        assert _session(env).status == "QUESTION_OPEN"

    def test_a_players_own_lock_state_is_visible_to_them(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )

        body = _player_round(client, env, "Ada Lovelace").get_json()

        assert body["answered"] is True
        assert body["selected_option_id"] == correct.id
        # But still no verdict.
        assert body["result"] is None


class TestAfterTheReveal:
    def test_the_player_learns_the_answer_and_their_own_result(self, client, env):
        _start(client, env)
        correct, wrong = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )
        _act(client, env, rounds.SHOW_ANSWER)

        body = _player_round(client, env, "Ada Lovelace").get_json()

        assert body["question"]["correct_option_id"] == correct.id
        assert body["question"]["answer_explanation"] == "Two deep safeties beat it."
        assert body["result"]["is_correct"] is True
        assert body["result"]["points_earned"] >= 100
        assert body["result"]["current_streak"] == 1

    def test_a_wrong_answer_is_reported_honestly(self, client, env):
        _start(client, env)
        _, wrong = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": wrong.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )
        _act(client, env, rounds.SHOW_ANSWER)

        result = _player_round(client, env, "Ada Lovelace").get_json()["result"]

        assert result["answered"] is True
        assert result["is_correct"] is False
        assert result["points_earned"] == 0
        assert result["current_streak"] == 0

    def test_no_answer_is_distinguished_from_a_wrong_answer(self, client, env):
        """"You got it wrong" and "you never answered" are different sentences
        and must not be conflated on a player's screen."""
        _start(client, env)
        _act(client, env, rounds.SHOW_ANSWER)

        result = _player_round(client, env, "Ada Lovelace").get_json()["result"]

        assert result["answered"] is False
        assert result["is_correct"] is None
        assert result["points_earned"] == 0

    def test_the_host_gets_the_distribution(self, client, env):
        _start(client, env)
        correct, wrong = _options(env)
        for name, option in (
            ("Ada Lovelace", correct), ("Grace Hopper", wrong), ("Alan Turing", correct)
        ):
            client.post(
                f"/api/competition/{env['code']}/answer",
                json={"round_index": 0, "option_id": option.id},
                headers={"X-Competition-Token": env["tokens"][name]},
            )
        _act(client, env, rounds.SHOW_ANSWER)

        distribution = _host(client, env)["round"]["distribution"]

        by_id = {row["option_id"]: row for row in distribution}
        assert by_id[correct.id]["count"] == 2
        assert by_id[correct.id]["is_correct_answer"] is True
        assert by_id[wrong.id]["count"] == 1
        # Every option appears, including ones nobody picked.
        assert len(distribution) == 3
        assert sum(row["count"] for row in distribution) == 3

    def test_the_distribution_names_nobody(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )
        _act(client, env, rounds.SHOW_ANSWER)

        raw = str(_host(client, env)["round"]["distribution"])

        for player in env["players"]:
            assert player["full_name"] not in raw

    def test_the_explanation_reaches_the_projector(self, client, env):
        _start(client, env)
        _act(client, env, rounds.SHOW_ANSWER)

        question = _host(client, env)["round"]["question"]

        assert question["answer_explanation"] == "Two deep safeties beat it."

    def test_a_question_without_an_explanation_simply_has_none(self, client,
                                                               register_coach):
        _, _, headers = register_coach(
            username="plain", email="plain@example.com", organization="Plain"
        )
        quiz_id = _quiz(client, headers, count=1, explanation=None)
        lobby = client.post(
            f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers
        ).get_json()
        player = client.post(
            "/api/players", json={"first_name": "Solo", "last_name": "Player"},
            headers=headers,
        ).get_json()
        token = client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": player["id"]}
        ).get_json()["reconnect_token"]
        client.post(
            f"/api/competition/sessions/{lobby['id']}/transition",
            json={"action": rounds.START_QUESTION,
                  "expected_version": db.session.get(
                      CompetitionSession, lobby["id"]).version},
            headers=headers,
        )
        session = db.session.get(CompetitionSession, lobby["id"])
        client.post(
            f"/api/competition/sessions/{lobby['id']}/transition",
            json={"action": rounds.SHOW_ANSWER, "expected_version": session.version},
            headers=headers,
        )

        body = client.get(
            f"/api/competition/{lobby['join_code']}/round",
            headers={"X-Competition-Token": token},
        ).get_json()

        assert body["question"]["answer_explanation"] is None


class TestRoundViewSecurity:
    def test_the_round_requires_a_token(self, client, env):
        _start(client, env)
        response = client.get(f"/api/competition/{env['code']}/round")
        assert response.status_code == 401

    def test_a_foreign_token_is_refused(self, client, env):
        _start(client, env)
        response = client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": "nope"},
        )
        assert response.status_code == 401

    def test_a_player_sees_only_their_own_result(self, client, env):
        _start(client, env)
        correct, wrong = _options(env)
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )
        client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": wrong.id},
            headers={"X-Competition-Token": env["tokens"]["Grace Hopper"]},
        )
        _act(client, env, rounds.SHOW_ANSWER)

        ada = _player_round(client, env, "Ada Lovelace").get_json()
        grace = _player_round(client, env, "Grace Hopper").get_json()

        assert ada["result"]["is_correct"] is True
        assert grace["result"]["is_correct"] is False
        # Neither payload mentions the other player at all.
        for body, other in ((ada, "Grace Hopper"), (grace, "Ada Lovelace")):
            assert other not in str(body)

    def test_the_round_payload_carries_no_tokens(self, client, env):
        _start(client, env)
        raw = _player_round(client, env, "Ada Lovelace").get_data(as_text=True)
        for token in env["tokens"].values():
            assert token not in raw
