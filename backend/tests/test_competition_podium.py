"""M2.5 podium: which places exist, and who is in them.

The tie cases are the point. Standard competition ranking means a place can
genuinely be EMPTY - two players tied at the top produce 1, 1, 3 and there is
no second place - and the temptation is always to promote somebody into it.
Doing so would invent a result the scoreboard never showed.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import (
    CompetitionAnswer,
    CompetitionParticipant,
    CompetitionSession,
    Question,
)
from app.models.competition import (
    COMPLETE,
    PODIUM,
    PODIUM_FIRST,
    PODIUM_SECOND,
    PODIUM_STANDINGS,
    PODIUM_THIRD,
)
from app.services import competition_podium as podium_svc
from app.services import competition_rounds as rounds

NAMES = [("Ada", "Lovelace"), ("Grace", "Hopper"), ("Alan", "Turing"),
         ("Katherine", "Johnson"), ("Edsger", "Dijkstra")]


def _quiz(client, headers, count=2):
    quiz = client.post("/api/quizzes", json={"title": "Finals"}, headers=headers).get_json()
    for index in range(count):
        client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Q{index}", "question_type": "multiple_choice",
                "options": [
                    {"option_text": "A", "is_correct_answer": True},
                    {"option_text": "B", "is_correct_answer": False},
                ],
            },
            headers=headers,
        )
    return quiz["id"]


@pytest.fixture
def env(client, register_coach):
    _, _, headers = register_coach()
    quiz_id = _quiz(client, headers)
    players = [
        client.post("/api/players", json={"first_name": f, "last_name": l},
                    headers=headers).get_json()
        for f, l in NAMES
    ]
    lobby = client.post(f"/api/competition/quizzes/{quiz_id}", json={},
                        headers=headers).get_json()
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


def _score(client, env, points: dict[str, int]):
    """Start a round, inject exact per-player points, and reveal it.

    Points are set directly so a tie shape can be produced precisely; the
    rounds themselves are started for real so the frozen order holds question
    ids that exist.
    """
    _act(client, env, rounds.START_QUESTION)
    _act(client, env, rounds.SHOW_ANSWER)
    CompetitionAnswer.query.delete()
    db.session.commit()
    question_id = _session(env).question_order[0]
    for participant in CompetitionParticipant.query.filter_by(
        session_id=env["session_id"]
    ).all():
        value = points.get(participant.display_name, 0)
        db.session.add(
            CompetitionAnswer(
                session_id=env["session_id"], participant_id=participant.id,
                question_id=question_id, round_index=0, selected_option_id=1,
                is_correct=value > 0, response_ms=1000, points_awarded=value,
            )
        )
        participant.total_points = value
        participant.best_streak = 1 if value else 0
    db.session.commit()


def _finish(client, env):
    _act(client, env, rounds.FINISH)
    return podium_svc.podium(_session(env))


def _names(payload, place):
    return sorted(row["display_name"] for row in payload["places"][str(place)])


# ---------------------------------------------------------------------------
# Places
# ---------------------------------------------------------------------------


class TestPodiumPlaces:
    def test_a_clean_one_two_three(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                             "Alan Turing": 100})
        p = _finish(client, env)

        assert _names(p, 1) == ["Ada Lovelace"]
        assert _names(p, 2) == ["Grace Hopper"]
        assert _names(p, 3) == ["Alan Turing"]
        assert p["empty_places"] == []
        assert p["winners"] == ["Ada Lovelace"]

    def test_two_tied_for_first_leaves_no_second_place(self, client, env):
        """1, 1, 3 - and there is genuinely no second place."""
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 300,
                             "Alan Turing": 100})
        p = _finish(client, env)

        assert _names(p, 1) == ["Ada Lovelace", "Grace Hopper"]
        # NOT promoted from third. The place does not exist.
        assert _names(p, 2) == []
        assert 2 in p["empty_places"]
        assert _names(p, 3) == ["Alan Turing"]

    def test_three_tied_for_first_leaves_no_second_or_third(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 300,
                             "Alan Turing": 300, "Katherine Johnson": 50})
        p = _finish(client, env)

        assert len(p["places"]["1"]) == 3
        assert p["empty_places"] == [2, 3]
        assert _names(p, 2) == [] and _names(p, 3) == []

    def test_two_tied_for_second_leaves_no_third_place(self, client, env):
        """1, 2, 2 - fourth is next, so third does not exist."""
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                             "Alan Turing": 200, "Katherine Johnson": 50})
        p = _finish(client, env)

        assert _names(p, 1) == ["Ada Lovelace"]
        assert _names(p, 2) == ["Alan Turing", "Grace Hopper"]
        assert _names(p, 3) == []
        assert p["empty_places"] == [3]

    def test_two_tied_for_third_share_it(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                             "Alan Turing": 100, "Katherine Johnson": 100})
        p = _finish(client, env)

        assert _names(p, 3) == ["Alan Turing", "Katherine Johnson"]
        assert p["empty_places"] == []

    def test_the_whole_room_tied_has_only_a_first_place(self, client, env):
        _score(client, env, {name: 100 for name in
                             [f"{f} {l}" for f, l in NAMES]})
        p = _finish(client, env)

        assert len(p["places"]["1"]) == 5
        assert p["empty_places"] == [2, 3]

    def test_everyone_on_zero_still_has_a_first_place(self, client, env):
        """Nobody scored. They are all still tied first - not "no winner"."""
        _score(client, env, {})
        p = _finish(client, env)

        assert len(p["places"]["1"]) == 5
        assert all(row["total_points"] == 0 for row in p["places"]["1"])

    def test_a_two_player_room_has_no_third_place(self, client, register_coach):
        _, _, headers = register_coach(username="duo", email="duo@example.com",
                                       organization="Duo")
        quiz_id = _quiz(client, headers)
        players = [
            client.post("/api/players", json={"first_name": f, "last_name": l},
                        headers=headers).get_json()
            for f, l in NAMES[:2]
        ]
        lobby = client.post(f"/api/competition/quizzes/{quiz_id}", json={},
                            headers=headers).get_json()
        for p in players:
            client.post(f"/api/competition/{lobby['join_code']}/join",
                        json={"player_id": p["id"]})
        env = {"headers": headers, "session_id": lobby["id"]}
        _score(client, env, {"Ada Lovelace": 200, "Grace Hopper": 100})
        _act(client, env, rounds.FINISH)

        p = podium_svc.podium(_session(env))

        assert _names(p, 1) == ["Ada Lovelace"]
        assert _names(p, 2) == ["Grace Hopper"]
        assert _names(p, 3) == []
        assert 3 in p["empty_places"]

    def test_no_hidden_tiebreaker_separates_tied_winners(self, client, env):
        _score(client, env, {"Ada Lovelace": 250, "Grace Hopper": 250})
        p = _finish(client, env)

        assert len(p["places"]["1"]) == 2
        assert all(row["rank"] == 1 for row in p["places"]["1"])


# ---------------------------------------------------------------------------
# The sequence
# ---------------------------------------------------------------------------


class TestPodiumSequence:
    def test_the_steps_advance_one_at_a_time(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                             "Alan Turing": 100})
        _act(client, env, rounds.FINISH)

        assert _session(env).podium_step == 0
        for expected in (PODIUM_THIRD, PODIUM_SECOND, PODIUM_FIRST, PODIUM_STANDINGS):
            assert _act(client, env, rounds.ADVANCE_PODIUM).status_code == 200
            assert _session(env).podium_step == expected
        # And no further.
        assert _act(client, env, rounds.ADVANCE_PODIUM).status_code == 409

    def test_the_step_sequence_is_the_same_length_whatever_the_ties(self, client, env):
        """Fixed steps keep podium_step meaning the same thing on every screen
        and across a refresh; an empty place is announced, not skipped."""
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 300})
        _act(client, env, rounds.FINISH)

        for _ in range(PODIUM_STANDINGS):
            assert _act(client, env, rounds.ADVANCE_PODIUM).status_code == 200
        assert _session(env).podium_step == PODIUM_STANDINGS

    def test_completing_ends_the_competition(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)

        assert _act(client, env, rounds.COMPLETE_COMPETITION).status_code == 200

        session = _session(env)
        assert session.status == COMPLETE
        assert session.ended_at is not None

    def test_a_stale_tab_cannot_double_advance_the_podium(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        stale = _session(env).version

        first = _act(client, env, rounds.ADVANCE_PODIUM)
        second = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.ADVANCE_PODIUM, "expected_version": stale},
            headers=env["headers"],
        )

        assert first.status_code == 200
        assert second.status_code == 409
        assert second.get_json()["reason"] == "stale_transition"
        # No skipped step.
        assert _session(env).podium_step == PODIUM_THIRD

    def test_the_rows_survive_completion(self, client, env):
        """M3 history depends on these still being here."""
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.COMPLETE_COMPETITION)

        assert CompetitionAnswer.query.filter_by(session_id=env["session_id"]).count() > 0
        assert CompetitionParticipant.query.filter_by(
            session_id=env["session_id"]
        ).count() == 5


# ---------------------------------------------------------------------------
# Final standings
# ---------------------------------------------------------------------------


class TestFinalStandings:
    def test_everyone_is_accounted_for(self, client, env):
        """Not a top five - the competition is over, there is no suspense to
        protect, and 5th still played."""
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200})
        p = _finish(client, env)

        assert len(p["final_standings"]) == 5
        assert {row["display_name"] for row in p["final_standings"]} == {
            f"{f} {l}" for f, l in NAMES
        }

    def test_it_carries_the_learning_numbers_and_best_streak(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        p = _finish(client, env)

        top = p["final_standings"][0]
        assert top["display_name"] == "Ada Lovelace"
        assert top["correct_count"] == 1
        assert top["scored_rounds"] == 1
        assert top["best_streak"] == 1

    def test_it_exposes_no_answer_detail_or_tokens(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)

        raw = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_data(as_text=True)

        for token in env["tokens"].values():
            assert token not in raw
        assert "selected_option_id" not in raw


# ---------------------------------------------------------------------------
# A player's own ending
# ---------------------------------------------------------------------------


class TestPlayerFinalResult:
    def _result(self, client, env, name):
        return client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": env["tokens"][name]},
        ).get_json()

    def test_a_player_sees_their_own_final_result(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200})
        _act(client, env, rounds.FINISH)

        body = self._result(client, env, "Grace Hopper")

        assert body["final_result"]["rank"] == 2
        assert body["final_result"]["total_points"] == 200
        assert body["final_result"]["is_winner"] is False
        assert body["podium"]["step"] == 0

    def test_a_winner_is_told_they_won(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)

        assert self._result(client, env, "Ada Lovelace")["final_result"]["is_winner"] is True

    def test_tied_winners_are_both_winners(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 300})
        _act(client, env, rounds.FINISH)

        for name in ("Ada Lovelace", "Grace Hopper"):
            result = self._result(client, env, name)["final_result"]
            assert result["is_winner"] is True
            assert result["tied"] == 2

    def test_a_players_result_describes_nobody_else(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200})
        _act(client, env, rounds.FINISH)

        result = self._result(client, env, "Grace Hopper")["final_result"]

        assert result["display_name"] == "Grace Hopper"
        assert "Ada Lovelace" not in str(result)

    def test_the_podium_needs_a_token(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)

        assert client.get(f"/api/competition/{env['code']}/round").status_code == 401

    def test_no_podium_before_the_competition_finishes(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})

        body = self._result(client, env, "Ada Lovelace")

        assert body["podium"] is None
        assert body["final_result"] is None


# ---------------------------------------------------------------------------
# Recovery
# ---------------------------------------------------------------------------


class TestPodiumRecovery:
    def test_a_podium_session_is_still_recoverable(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        _act(client, env, rounds.ADVANCE_PODIUM)

        active = client.get("/api/competition/active", headers=env["headers"]).get_json()

        assert len(active) == 1
        assert active[0]["status"] == PODIUM

    def test_a_completed_competition_stops_being_active(self, client, env):
        """The banner must not send a coach back into a finished room."""
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.COMPLETE_COMPETITION)

        assert client.get("/api/competition/active", headers=env["headers"]).get_json() == []

    def test_the_host_rebuilds_the_exact_step(self, client, env):
        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200})
        _act(client, env, rounds.FINISH)
        _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.ADVANCE_PODIUM)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        assert view["podium"]["step"] == PODIUM_SECOND
        assert view["podium"]["places"]["2"][0]["display_name"] == "Grace Hopper"

    def test_the_podium_is_still_available_at_complete(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.COMPLETE_COMPETITION)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        assert view["podium"] is not None
        assert view["podium"]["winners"] == ["Ada Lovelace"]


# ---------------------------------------------------------------------------
# COMPLETE vs ABANDONED  (M2.6 cross-milestone review)
# ---------------------------------------------------------------------------


class TestEndingSemantics:
    """COMPLETE means the competition FINISHED. Nothing else may produce it.

    The distinction only started mattering in M2.6, when COMPLETE gained real
    meaning for players - a completed competition preserves their seat and
    shows their final result, where an abandoned one clears it and says the
    coach stopped. Anything that mislabels a cancellation as a completion
    therefore shows a whole room a "final result" for an event nobody
    finished.
    """

    def test_ending_from_the_lobby_abandons(self, client, env):
        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        assert response.status_code == 200
        assert _session(env).status == "ABANDONED"

    def test_ending_mid_question_abandons_rather_than_completing(self, client, env):
        """REGRESSION.

        `/end` used to compute `abandoned = status == LOBBY`. That was right in
        M1, where LOBBY was the only non-terminal state and the COMPLETE branch
        was unreachable. Once rounds existed, a coach stopping mid-question
        took that branch and the session was marked COMPLETE - a cancelled
        event recorded, and displayed, as a finished one.
        """
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.NEXT_QUESTION)
        assert _session(env).status == "QUESTION_OPEN"

        client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        assert _session(env).status == "ABANDONED"

    def test_ending_during_the_reveal_abandons(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        assert _session(env).status == "QUESTION_REVEAL"

        client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        assert _session(env).status == "ABANDONED"

    def test_ending_during_the_leaderboard_abandons(self, client, env):
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        assert _session(env).status == "ABANDONED"

    def test_only_the_podium_produces_complete(self, client, env):
        """The one legitimate route to COMPLETE."""
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)

        _act(client, env, rounds.COMPLETE_COMPETITION)

        assert _session(env).status == COMPLETE

    def test_an_abandoned_competition_shows_a_player_no_final_result(self, client, env):
        """The user-visible consequence, checked from the phone's side.

        A cancelled competition must not hand every player a final result and
        a podium - which is exactly what happened once COMPLETE started
        preserving them.
        """
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.NEXT_QUESTION)
        assert _session(env).status == "QUESTION_OPEN"
        client.post(
            f"/api/competition/sessions/{env['session_id']}/end", headers=env["headers"]
        )

        body = client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        ).get_json()

        assert body["podium"] is None
        assert body["final_result"] is None
        assert body["status"] == "ABANDONED"

    def test_a_completed_competition_does_show_a_player_their_result(self, client, env):
        """The other half of the same rule."""
        _score(client, env, {"Ada Lovelace": 300})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.COMPLETE_COMPETITION)

        body = client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        ).get_json()

        assert body["status"] == COMPLETE
        assert body["final_result"] is not None
        assert body["final_result"]["total_points"] == 300


# ---------------------------------------------------------------------------
# Isolation after a COMPLETED competition
# ---------------------------------------------------------------------------


class TestIsolationAfterCompletion:
    def test_a_finished_competition_touches_no_official_surface(self, client, env):
        from app.models import Answer, PlayerAttempt

        _score(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                             "Alan Turing": 100})
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_STANDINGS):
            _act(client, env, rounds.ADVANCE_PODIUM)
        _act(client, env, rounds.COMPLETE_COMPETITION)

        # Guard against passing vacuously.
        assert _session(env).status == COMPLETE
        assert CompetitionAnswer.query.count() > 0

        assert PlayerAttempt.query.count() == 0
        assert Answer.query.count() == 0

        responses = client.get(
            f"/api/quizzes/{env['quiz_id']}/responses", headers=env["headers"]
        ).get_json()
        items = responses.get("responses", responses) if isinstance(responses, dict) else responses
        assert len(items) == 0

        csv = client.get(
            f"/api/quizzes/{env['quiz_id']}/export.csv", headers=env["headers"]
        ).get_data(as_text=True)
        for player in env["players"]:
            assert player["full_name"] not in csv

        for player in env["players"][:3]:
            history = client.get(
                f"/api/players/{player['id']}/history", headers=env["headers"]
            ).get_json()
            summary = history.get("summary", history)
            assert summary["assigned_count"] == 0
            assert summary["average_score_percent"] is None
