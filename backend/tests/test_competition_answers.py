"""Competition M2.2 - answering, timing, scoring and the attack surface.

TestAttacks is the important class. Everything in it is something a player,
or someone holding a join code, could actually try - and every one of them
must fail server-side, because the client is not a place where any of this
can be enforced.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import (
    CompetitionAnswer,
    CompetitionParticipant,
    CompetitionSession,
    PlayerAttempt,
    Question,
)
from app.services import competition_rounds as rounds
from app.services.competition_answers import NETWORK_GRACE
from app.services import competition_scoring as scoring

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _quiz(client, headers, count=3):
    quiz = client.post("/api/quizzes", json={"title": "Coverages"}, headers=headers).get_json()
    for index in range(count):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Q{index}",
                "question_type": "multiple_choice",
                "options": [
                    {"option_text": "Cover 2", "is_correct_answer": True},
                    {"option_text": "Cover 3", "is_correct_answer": False},
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
            "/api/players", json={"first_name": first, "last_name": last}, headers=headers
        ).get_json()
        for first, last in (("Ada", "Lovelace"), ("Grace", "Hopper"))
    ]
    lobby = client.post(
        f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers
    ).get_json()
    tokens = {}
    for player in players:
        body = client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": player["id"]}
        ).get_json()
        tokens[player["full_name"]] = body["reconnect_token"]
    return {
        "headers": headers,
        "quiz_id": quiz_id,
        "players": players,
        "session_id": lobby["id"],
        "code": lobby["join_code"],
        "tokens": tokens,
    }


def _session(env) -> CompetitionSession:
    return db.session.get(CompetitionSession, env["session_id"])


def _act(client, env, action):
    return client.post(
        f"/api/competition/sessions/{env['session_id']}/transition",
        json={"action": action, "expected_version": _session(env).version},
        headers=env["headers"],
    )


def _open_now(env, seconds_elapsed=0.0):
    """Pull the question window into the past so answering is live."""
    session = _session(env)
    session.question_opened_at = datetime.now(timezone.utc) - timedelta(
        seconds=seconds_elapsed
    )
    session.question_closes_at = session.question_opened_at + timedelta(
        seconds=session.question_time_seconds
    )
    db.session.commit()


def _options(env, round_index=0):
    question_id = _session(env).question_order[round_index]
    question = db.session.get(Question, question_id)
    correct = next(o for o in question.options if o.is_correct_answer)
    wrong = next(o for o in question.options if not o.is_correct_answer)
    return correct, wrong


def _answer(client, env, token, option_id, round_index=0):
    return client.post(
        f"/api/competition/{env['code']}/answer",
        json={"round_index": round_index, "option_id": option_id},
        headers={"X-Competition-Token": token},
    )


def _start(client, env, elapsed=1.0):
    _act(client, env, rounds.START_QUESTION)
    _open_now(env, elapsed)


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------


class TestSubmission:
    def test_an_answer_is_accepted_and_locked(self, client, env):
        _start(client, env)
        correct, _ = _options(env)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code == 201
        body = response.get_json()
        assert body["accepted"] is True and body["locked"] is True
        assert body["selected_option_id"] == correct.id

    def test_the_response_never_leaks_the_verdict(self, client, env):
        """A phone that knew it was right before the room did would leak the
        answer to anyone glancing at it."""
        _start(client, env)
        correct, _ = _options(env)

        raw = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id).get_data(
            as_text=True
        )

        for leak in ("is_correct", "correct", "points", "explanation", "answer_explanation"):
            assert leak not in raw

    def test_a_second_answer_is_refused(self, client, env):
        _start(client, env)
        correct, wrong = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], wrong.id)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "answer_locked"
        # And the original stands - no changing your mind.
        stored = CompetitionAnswer.query.filter_by(session_id=env["session_id"]).one()
        assert stored.selected_option_id == correct.id

    def test_the_database_forbids_a_second_answer(self, client, env):
        """The service is the courtesy; the constraint is the guarantee."""
        _start(client, env)
        correct, _ = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)
        participant = CompetitionParticipant.query.filter_by(
            session_id=env["session_id"]
        ).first()

        db.session.add(
            CompetitionAnswer(
                session_id=env["session_id"], participant_id=participant.id,
                question_id=_session(env).question_order[0], round_index=0,
                selected_option_id=correct.id, is_correct=True,
                response_ms=10, points_awarded=0,
            )
        )
        with pytest.raises(Exception):
            db.session.commit()
        db.session.rollback()

    def test_submitting_does_not_bump_the_version(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        before = _session(env).version

        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert _session(env).version == before
        assert _session(env).answered_count == 1

    def test_a_refresh_mid_question_returns_the_locked_answer(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        token = env["tokens"]["Ada Lovelace"]
        _answer(client, env, token, correct.id)

        resumed = client.get(
            f"/api/competition/{env['code']}/me", headers={"X-Competition-Token": token}
        ).get_json()

        assert resumed["answer"]["answered"] is True
        assert resumed["answer"]["selected_option_id"] == correct.id
        # Still no verdict before the reveal.
        assert "is_correct" not in resumed["answer"]


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------


class TestTimingBoundaries:
    def _window(self, env, opened_delta_ms):
        """Place `question_opened_at` so that now is `opened_delta_ms` into
        the window (negative = still in the lead-in)."""
        session = _session(env)
        session.question_opened_at = datetime.now(timezone.utc) - timedelta(
            milliseconds=opened_delta_ms
        )
        session.question_closes_at = session.question_opened_at + timedelta(
            seconds=session.question_time_seconds
        )
        db.session.commit()

    def test_just_before_open_is_refused(self, client, env):
        """A margin of 1ms is not testable through a real request - the round
        trip is longer than the boundary, so the window would legitimately be
        open by the time the server looked. 400ms is comfortably inside the
        lead-in and still exercises the same comparison.
        """
        _act(client, env, rounds.START_QUESTION)
        self._window(env, -400)
        correct, _ = _options(env)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "not_started"

    def test_during_the_lead_in_is_refused(self, client, env):
        """The 3-2-1. The question is not on screen yet."""
        _act(client, env, rounds.START_QUESTION)
        correct, _ = _options(env)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "not_started"

    def test_just_after_open_is_accepted(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        self._window(env, 5)
        correct, _ = _options(env)

        assert _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id).status_code == 201

    def test_mid_window_is_accepted(self, client, env):
        _start(client, env, elapsed=10)
        correct, _ = _options(env)
        assert _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id).status_code == 201

    def test_just_inside_the_deadline_is_accepted(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        self._window(env, 20_000 - 5)
        correct, _ = _options(env)
        assert _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id).status_code == 201

    def test_inside_the_network_grace_is_accepted(self, client, env):
        """A legitimate tap that lost 400ms to the network is not stolen."""
        _act(client, env, rounds.START_QUESTION)
        self._window(env, 20_000 + 400)
        correct, _ = _options(env)

        assert _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id).status_code == 201

    def test_beyond_the_grace_is_refused(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        self._window(env, 20_000 + int(NETWORK_GRACE.total_seconds() * 1000) + 250)
        correct, _ = _options(env)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "answering_closed"

    def test_a_grace_answer_scores_as_the_slowest(self, client, env):
        """The grace buys inclusion, never points."""
        _act(client, env, rounds.START_QUESTION)
        self._window(env, 20_000 + 400)
        correct, _ = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        stored = CompetitionAnswer.query.one()
        assert stored.response_ms == 20_000  # clamped to the full window

        _act(client, env, rounds.SHOW_ANSWER)
        assert CompetitionAnswer.query.one().points_awarded == (
            scoring.BASE_POINTS + scoring.QUARTILE_SHARES.index(0.1) * 0
            + round(scoring.speed_cap(0, 3) * 0.1)
        )

    def test_response_ms_is_measured_by_the_server(self, client, env):
        _start(client, env, elapsed=7)
        correct, _ = _options(env)

        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        stored = CompetitionAnswer.query.one()
        # ~7s, allowing for test execution time. Nothing in the request said so.
        assert 6_500 <= stored.response_ms <= 9_000

    def test_reconnecting_does_not_extend_the_window(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        token = env["tokens"]["Ada Lovelace"]
        closes_at = _session(env).question_closes_at

        for _ in range(3):
            client.get(f"/api/competition/{env['code']}/me",
                       headers={"X-Competition-Token": token})

        assert _session(env).question_closes_at == closes_at


# ---------------------------------------------------------------------------
# Scoring at the reveal
# ---------------------------------------------------------------------------


class TestScoringAtReveal:
    def test_no_points_are_awarded_at_submission(self, client, env):
        _start(client, env)
        correct, _ = _options(env)

        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert CompetitionAnswer.query.one().points_awarded == 0
        assert all(p.total_points == 0 for p in CompetitionParticipant.query.all())

    def test_the_reveal_awards_points_once(self, client, env):
        _start(client, env, elapsed=1)
        correct, wrong = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)
        _answer(client, env, env["tokens"]["Grace Hopper"], wrong.id)

        _act(client, env, rounds.SHOW_ANSWER)

        by_name = {p.display_name: p for p in CompetitionParticipant.query.all()}
        assert by_name["Ada Lovelace"].total_points >= scoring.BASE_POINTS
        assert by_name["Grace Hopper"].total_points == 0

    def test_replaying_the_reveal_cannot_double_award(self, client, env):
        """A double-clicked reveal, or a retried request."""
        from app.services.competition_answers import score_round

        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)
        _act(client, env, rounds.SHOW_ANSWER)
        after_first = {p.id: p.total_points for p in CompetitionParticipant.query.all()}

        # Call the scorer directly, three more times.
        session = _session(env)
        for _ in range(3):
            assert score_round(session) == 0

        assert {p.id: p.total_points for p in CompetitionParticipant.query.all()} == after_first

    def test_a_stale_reveal_transition_is_refused_before_scoring(self, client, env):
        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)
        stale = _session(env).version
        _act(client, env, rounds.SHOW_ANSWER)
        awarded = CompetitionParticipant.query.filter_by(display_name="Ada Lovelace").one()
        points = awarded.total_points

        replay = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.SHOW_ANSWER, "expected_version": stale},
            headers=env["headers"],
        )

        assert replay.status_code == 409
        assert replay.get_json()["reason"] == "stale_transition"
        assert CompetitionParticipant.query.filter_by(
            display_name="Ada Lovelace"
        ).one().total_points == points

    def test_the_scoring_version_is_recorded(self, client, env):
        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        _act(client, env, rounds.SHOW_ANSWER)

        assert _session(env).scoring_version == scoring.SCORING_VERSION

    def test_an_unanswered_round_awards_nothing(self, client, env):
        _start(client, env, elapsed=1)
        _act(client, env, rounds.SHOW_ANSWER)
        assert all(p.total_points == 0 for p in CompetitionParticipant.query.all())


# ---------------------------------------------------------------------------
# Streaks
# ---------------------------------------------------------------------------


class TestStreaks:
    def test_a_streak_builds_on_consecutive_correct_answers(self, client, env):
        correct_ids = []
        _act(client, env, rounds.START_QUESTION)
        for round_index in range(3):
            _open_now(env, 1)
            correct, _ = _options(env, round_index)
            correct_ids.append(correct.id)
            _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id, round_index)
            _act(client, env, rounds.SHOW_ANSWER)
            if round_index < 2:
                _act(client, env, rounds.NEXT_QUESTION)

        ada = CompetitionParticipant.query.filter_by(display_name="Ada Lovelace").one()
        assert ada.current_streak == 3
        assert ada.best_streak == 3

    def test_a_wrong_answer_resets_the_streak_but_keeps_the_best(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        for round_index in range(2):
            _open_now(env, 1)
            correct, wrong = _options(env, round_index)
            chosen = correct.id if round_index == 0 else wrong.id
            _answer(client, env, env["tokens"]["Ada Lovelace"], chosen, round_index)
            _act(client, env, rounds.SHOW_ANSWER)
            if round_index == 0:
                _act(client, env, rounds.NEXT_QUESTION)

        ada = CompetitionParticipant.query.filter_by(display_name="Ada Lovelace").one()
        assert ada.current_streak == 0
        assert ada.best_streak == 1

    def test_not_answering_breaks_the_streak(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        _open_now(env, 1)
        correct, _ = _options(env, 0)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id, 0)
        _act(client, env, rounds.SHOW_ANSWER)
        _act(client, env, rounds.NEXT_QUESTION)
        _open_now(env, 1)
        # Grace answers, Ada sits this one out.
        correct1, _ = _options(env, 1)
        _answer(client, env, env["tokens"]["Grace Hopper"], correct1.id, 1)
        _act(client, env, rounds.SHOW_ANSWER)

        ada = CompetitionParticipant.query.filter_by(display_name="Ada Lovelace").one()
        assert ada.current_streak == 0
        assert ada.best_streak == 1

    def test_streaks_do_not_change_points(self, client, env):
        """Two players, identical accuracy and speed, different streaks -
        identical scores."""
        _act(client, env, rounds.START_QUESTION)
        _open_now(env, 1)
        correct, wrong = _options(env, 0)
        _answer(client, env, env["tokens"]["Ada Lovelace"], wrong.id, 0)
        _answer(client, env, env["tokens"]["Grace Hopper"], correct.id, 0)
        _act(client, env, rounds.SHOW_ANSWER)
        _act(client, env, rounds.NEXT_QUESTION)
        _open_now(env, 1)
        correct1, _ = _options(env, 1)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct1.id, 1)
        _answer(client, env, env["tokens"]["Grace Hopper"], correct1.id, 1)
        _act(client, env, rounds.SHOW_ANSWER)

        by_name = {p.display_name: p for p in CompetitionParticipant.query.all()}
        # Grace is on a 2 streak, Ada on 1 - same points for round 2.
        assert by_name["Grace Hopper"].current_streak == 2
        assert by_name["Ada Lovelace"].current_streak == 1
        round_two = {
            a.participant_id: a.points_awarded
            for a in CompetitionAnswer.query.filter_by(round_index=1).all()
        }
        assert len(set(round_two.values())) == 1, "a streak changed the points"


# ---------------------------------------------------------------------------
# THE ATTACK SURFACE
# ---------------------------------------------------------------------------


class TestAttacks:
    def test_no_token_is_refused(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        response = client.post(
            f"/api/competition/{env['code']}/answer",
            json={"round_index": 0, "option_id": correct.id},
        )
        assert response.status_code == 401
        assert response.get_json()["reason"] == "missing_token"

    def test_a_fake_token_is_refused(self, client, env):
        _start(client, env)
        correct, _ = _options(env)
        response = _answer(client, env, "not-a-real-token", correct.id)
        assert response.status_code == 401
        assert response.get_json()["reason"] == "invalid_token"

    def test_a_removed_participants_token_cannot_answer(self, client, env):
        """Removal happens in the LOBBY - see the next test for why it cannot
        happen mid-question - and the token must be dead from that moment."""
        participant = CompetitionParticipant.query.filter_by(
            display_name="Ada Lovelace"
        ).one()
        removed = client.delete(
            f"/api/competition/sessions/{env['session_id']}/participants/{participant.id}",
            headers=env["headers"],
        )
        assert removed.status_code == 200

        _start(client, env)
        correct, _ = _options(env)
        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code == 401
        assert CompetitionAnswer.query.count() == 0

    def test_removal_is_refused_once_the_competition_is_running(self, client, env):
        """M1 restricts removal to the lobby, deliberately: pulling someone
        out mid-round would delete answers already given and silently restate
        everyone else's rank. M2.2 does not relax that."""
        _start(client, env)
        participant = CompetitionParticipant.query.filter_by(
            display_name="Ada Lovelace"
        ).one()

        response = client.delete(
            f"/api/competition/sessions/{env['session_id']}/participants/{participant.id}",
            headers=env["headers"],
        )

        assert response.status_code == 409
        assert CompetitionParticipant.query.count() == 2

    def test_a_token_from_another_competition_is_refused(self, client, env, register_coach):
        _start(client, env)
        correct, _ = _options(env)
        _, _, other_headers = register_coach(
            username="other", email="other@example.com", organization="Others"
        )
        other_quiz = _quiz(client, other_headers)
        other_player = client.post(
            "/api/players", json={"first_name": "Mal", "last_name": "Stranger"},
            headers=other_headers,
        ).get_json()
        other_lobby = client.post(
            f"/api/competition/quizzes/{other_quiz}", json={}, headers=other_headers
        ).get_json()
        foreign_token = client.post(
            f"/api/competition/{other_lobby['join_code']}/join",
            json={"player_id": other_player["id"]},
        ).get_json()["reconnect_token"]

        response = _answer(client, env, foreign_token, correct.id)

        assert response.status_code == 401
        assert CompetitionAnswer.query.filter_by(session_id=env["session_id"]).count() == 0

    def test_ids_in_the_body_cannot_choose_a_victim(self, client, env):
        """participant_id / player_id are not fields - identity is the token."""
        _start(client, env)
        correct, _ = _options(env)
        victim = CompetitionParticipant.query.filter_by(display_name="Grace Hopper").one()

        response = client.post(
            f"/api/competition/{env['code']}/answer",
            json={
                "round_index": 0,
                "option_id": correct.id,
                "participant_id": victim.id,
                "player_id": victim.player_id,
            },
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )

        assert response.status_code == 422, "unknown fields must be rejected outright"

    def test_client_supplied_score_correctness_and_timing_are_rejected(self, client, env):
        _start(client, env)
        correct, wrong = _options(env)

        response = client.post(
            f"/api/competition/{env['code']}/answer",
            json={
                "round_index": 0,
                "option_id": wrong.id,
                "is_correct": True,
                "points_awarded": 99999,
                "response_ms": 1,
            },
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        )

        assert response.status_code == 422

    def test_the_server_decides_correctness(self, client, env):
        """Even with a legal request, the verdict comes from the database."""
        _start(client, env, elapsed=1)
        _, wrong = _options(env)

        _answer(client, env, env["tokens"]["Ada Lovelace"], wrong.id)

        assert CompetitionAnswer.query.one().is_correct is False

    def test_an_option_from_another_question_is_refused(self, client, env):
        """The obvious way to smuggle in a known-correct answer."""
        _start(client, env)
        other_correct, _ = _options(env, round_index=1)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], other_correct.id)

        assert response.status_code == 422
        assert response.get_json()["reason"] == "option_mismatch"

    def test_a_nonexistent_option_is_refused(self, client, env):
        _start(client, env)
        response = _answer(client, env, env["tokens"]["Ada Lovelace"], 999_999)
        assert response.status_code == 422
        assert response.get_json()["reason"] == "option_mismatch"

    def test_the_wrong_round_is_refused(self, client, env):
        _start(client, env)
        correct, _ = _options(env)

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id, round_index=2)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "wrong_round"

    def test_answering_before_the_competition_starts_is_refused(self, client, env):
        response = _answer(client, env, env["tokens"]["Ada Lovelace"], 1)
        assert response.status_code == 409
        assert response.get_json()["reason"] == "not_started"

    def test_answering_after_the_reveal_is_refused(self, client, env):
        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        _act(client, env, rounds.SHOW_ANSWER)

        response = _answer(client, env, env["tokens"]["Grace Hopper"], correct.id)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "not_started"

    def test_answering_a_terminal_competition_is_refused(self, client, env):
        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        response = _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id)

        assert response.status_code in (401, 409)
        assert CompetitionAnswer.query.count() == 0

    def test_replaying_an_accepted_request_changes_nothing(self, client, env):
        _start(client, env, elapsed=1)
        correct, _ = _options(env)
        token = env["tokens"]["Ada Lovelace"]
        first = _answer(client, env, token, correct.id)

        replay = _answer(client, env, token, correct.id)

        assert first.status_code == 201
        assert replay.status_code == 409
        assert CompetitionAnswer.query.count() == 1


# ---------------------------------------------------------------------------
# A deleted question
# ---------------------------------------------------------------------------


class TestDeletedQuestion:
    def test_a_deleted_round_is_stepped_over(self, client, env):
        _start(client, env, elapsed=1)
        order = list(_session(env).question_order)
        _act(client, env, rounds.SHOW_ANSWER)

        client.delete(
            f"/api/quizzes/{env['quiz_id']}/questions/{order[1]}", headers=env["headers"]
        )
        _act(client, env, rounds.NEXT_QUESTION)

        # Round 1 is gone, so play moves to round 2 - which still plays the
        # question it always would have.
        assert _session(env).current_round == 2
        assert _session(env).question_id_for_round(2) == order[2]

    def test_the_frozen_order_is_not_rewritten(self, client, env):
        _start(client, env, elapsed=1)
        order = list(_session(env).question_order)
        _act(client, env, rounds.SHOW_ANSWER)
        client.delete(
            f"/api/quizzes/{env['quiz_id']}/questions/{order[1]}", headers=env["headers"]
        )
        _act(client, env, rounds.NEXT_QUESTION)

        # The historical record of what this competition was built to play.
        assert _session(env).question_order == order

    def test_already_awarded_points_survive_a_deletion(self, client, env):
        """A coach tidying their quiz afterwards must not restate standings."""
        _start(client, env, elapsed=1)
        order = list(_session(env).question_order)
        correct, _ = _options(env, 0)
        _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id, 0)
        _act(client, env, rounds.SHOW_ANSWER)
        before = CompetitionParticipant.query.filter_by(
            display_name="Ada Lovelace"
        ).one().total_points
        assert before > 0

        client.delete(
            f"/api/quizzes/{env['quiz_id']}/questions/{order[0]}", headers=env["headers"]
        )

        assert CompetitionParticipant.query.filter_by(
            display_name="Ada Lovelace"
        ).one().total_points == before

    def test_deleting_every_remaining_question_ends_the_run_cleanly(self, client, env):
        _start(client, env, elapsed=1)
        order = list(_session(env).question_order)
        _act(client, env, rounds.SHOW_ANSWER)
        for question_id in order[1:]:
            client.delete(
                f"/api/quizzes/{env['quiz_id']}/questions/{question_id}",
                headers=env["headers"],
            )

        response = _act(client, env, rounds.NEXT_QUESTION)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "no_such_round"
        # And the coach can still finish properly.
        assert rounds.FINISH in rounds.available_actions(_session(env))


# ---------------------------------------------------------------------------
# Analytics isolation, after a fully played and scored competition
# ---------------------------------------------------------------------------


class TestAnalyticsIsolationAfterScoring:
    @pytest.fixture
    def played(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        for round_index in range(3):
            _open_now(env, 1)
            correct, wrong = _options(env, round_index)
            _answer(client, env, env["tokens"]["Ada Lovelace"], correct.id, round_index)
            _answer(client, env, env["tokens"]["Grace Hopper"], wrong.id, round_index)
            _act(client, env, rounds.SHOW_ANSWER)
            if round_index < 2:
                _act(client, env, rounds.NEXT_QUESTION)
        _act(client, env, rounds.FINISH)
        return env

    def test_points_were_actually_awarded(self, client, played):
        """Guards the rest of this class from passing vacuously."""
        ada = CompetitionParticipant.query.filter_by(display_name="Ada Lovelace").one()
        assert ada.total_points >= 3 * scoring.BASE_POINTS

    def test_no_player_attempt_or_answer_row_exists(self, client, played):
        from app.models import Answer

        assert PlayerAttempt.query.count() == 0
        assert Answer.query.count() == 0

    def test_the_responses_feed_is_empty(self, client, played):
        response = client.get(
            f"/api/quizzes/{played['quiz_id']}/responses", headers=played["headers"]
        )
        assert response.status_code == 200
        body = response.get_json()
        items = body.get("responses", body) if isinstance(body, dict) else body
        assert len(items) == 0

    def test_the_quiz_dashboard_reports_nothing(self, client, played):
        """Whatever shape the dashboard takes, a competition must not have put
        a player, an attempt or an average into it."""
        response = client.get(
            f"/api/quizzes/{played['quiz_id']}/dashboard", headers=played["headers"]
        )
        assert response.status_code == 200
        body = response.get_json()

        def assert_zero(scope, payload):
            """Every activity number must still be zero. Structure is fine -
            `question_breakdown` lists the quiz's own questions whether or not
            anyone has played - so this checks the COUNTS, not the shape."""
            for key, value in payload.items():
                if isinstance(value, dict):
                    assert_zero(f"{scope}{key}.", value)
                elif isinstance(value, list):
                    for entry in value:
                        if isinstance(entry, dict):
                            assert_zero(f"{scope}{key}[].", entry)
                        else:
                            raise AssertionError(f"{scope}{key} was populated: {value}")
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    if any(
                        token in key
                        for token in ("count", "total", "submitted", "progress",
                                      "size", "average", "percent")
                    ):
                        assert value in (0, None), (
                            f"{scope}{key} was populated by a competition: {value}"
                        )

        assert_zero("", body)

        raw = response.get_data(as_text=True)
        for player in played["players"]:
            assert player["full_name"] not in raw

    def test_player_history_is_untouched(self, client, played):
        for player in played["players"]:
            body = client.get(
                f"/api/players/{player['id']}/history", headers=played["headers"]
            ).get_json()
            summary = body.get("summary", body)
            assert summary["assigned_count"] == 0
            assert summary["average_score_percent"] is None

    def test_the_csv_export_names_nobody(self, client, played):
        text = client.get(
            f"/api/quizzes/{played['quiz_id']}/export.csv", headers=played["headers"]
        ).get_data(as_text=True)
        for player in played["players"]:
            assert player["full_name"] not in text
