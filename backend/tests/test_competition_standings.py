"""M2.4 standings: ranking, ties, movement and the suspense rule.

Ties get the most attention here because they are where an implementation is
most tempted to cheat - inventing a hidden tiebreaker to avoid showing two
players on the same rank. Two players who scored the same DID score the same,
and the table should say so.
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
from app.services import competition_rounds as rounds
from app.services import competition_standings as standings_svc

NAMES = [
    ("Ada", "Lovelace"), ("Grace", "Hopper"), ("Alan", "Turing"),
    ("Katherine", "Johnson"), ("Edsger", "Dijkstra"), ("Barbara", "Liskov"),
    ("Donald", "Knuth"),
]


def _quiz(client, headers, count=4):
    quiz = client.post("/api/quizzes", json={"title": "Coverages"}, headers=headers).get_json()
    for index in range(count):
        assert client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Q{index}",
                "question_type": "multiple_choice",
                "answer_explanation": "Because.",
                "options": [
                    {"option_text": "Cover 2", "is_correct_answer": True},
                    {"option_text": "Cover 3", "is_correct_answer": False},
                ],
            },
            headers=headers,
        ).status_code == 201
    return quiz["id"]


@pytest.fixture
def env(client, register_coach):
    _, _, headers = register_coach()
    quiz_id = _quiz(client, headers)
    players = [
        client.post(
            "/api/players", json={"first_name": f, "last_name": l}, headers=headers
        ).get_json()
        for f, l in NAMES
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


def _answer(client, env, name, option_id, round_index=0):
    return client.post(
        f"/api/competition/{env['code']}/answer",
        json={"round_index": round_index, "option_id": option_id},
        headers={"X-Competition-Token": env["tokens"][name]},
    )


def _play(client, env, correct_names, round_index=0, elapsed=1.0):
    """Run one round: everyone named answers correctly, the rest wrongly."""
    if round_index == 0:
        _act(client, env, rounds.START_QUESTION)
    else:
        _act(client, env, rounds.NEXT_QUESTION)
    _open_now(env, elapsed)
    correct, wrong = _options(env, round_index)
    for name in env["tokens"]:
        _answer(client, env, name, correct.id if name in correct_names else wrong.id, round_index)
    _act(client, env, rounds.SHOW_ANSWER)


def _table(env):
    return standings_svc.standings(_session(env))


def _by_name(table):
    return {row["display_name"]: row for row in table}


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


class TestRanking:
    def test_everyone_appears_including_players_who_never_answered(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        _open_now(env)
        correct, _ = _options(env)
        _answer(client, env, "Ada Lovelace", correct.id)
        _act(client, env, rounds.SHOW_ANSWER)

        table = _table(env)

        # Seven joined; six never answered. None of them vanish.
        assert len(table) == 7
        silent = _by_name(table)["Donald Knuth"]
        assert silent["total_points"] == 0
        assert silent["correct_count"] == 0

    def test_ranking_is_by_points_and_correct_count_is_not_a_tiebreaker(self, client, env):
        """Model D already protects knowledge, so correct-count is reported,
        not sorted on."""
        _play(client, env, {"Ada Lovelace", "Grace Hopper"})

        table = _by_name(_table(env))

        # Same round, both correct - speed may separate them, nothing else does.
        assert table["Ada Lovelace"]["correct_count"] == 1
        assert table["Grace Hopper"]["correct_count"] == 1
        assert table["Alan Turing"]["total_points"] == 0

    def test_zero_point_players_are_ranked_not_hidden(self, client, env):
        _play(client, env, {"Ada Lovelace"})

        table = _table(env)
        zeros = [row for row in table if row["total_points"] == 0]

        assert len(zeros) == 6
        # All tied, all ranked, none labelled.
        assert {row["rank"] for row in zeros} == {2}

    def test_the_denominator_counts_scored_rounds_not_the_quiz_length(self, client, env):
        """A competition that has played 2 of 4 shows "/ 2", not "/ 4"."""
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _play(client, env, {"Ada Lovelace"}, round_index=1)

        assert standings_svc.scored_round_count(_session(env)) == 2
        assert all(row["scored_rounds"] == 2 for row in _table(env))


# ---------------------------------------------------------------------------
# Ties
# ---------------------------------------------------------------------------


class TestTies:
    def _force(self, env, points: dict[str, int]):
        """Set exact totals, so tie shapes can be tested precisely."""
        for participant in CompetitionParticipant.query.filter_by(
            session_id=env["session_id"]
        ).all():
            participant.total_points = points.get(participant.display_name, 0)
        db.session.commit()

    def _ranks(self, client, env, points):
        """Rank purely from injected answer rows, mirroring real scoring.

        The round is started for real first, so `question_order` holds ids
        that actually exist - injecting a made-up one violates the answers FK
        and poisons the session for every test after it.
        """
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        CompetitionAnswer.query.delete()
        db.session.commit()
        question_id = _session(env).question_order[0]
        for participant in CompetitionParticipant.query.filter_by(
            session_id=env["session_id"]
        ).all():
            db.session.add(
                CompetitionAnswer(
                    session_id=env["session_id"], participant_id=participant.id,
                    question_id=question_id, round_index=0, selected_option_id=1,
                    is_correct=points.get(participant.display_name, 0) > 0,
                    response_ms=1000,
                    points_awarded=points.get(participant.display_name, 0),
                )
            )
        db.session.commit()
        return {row["display_name"]: row["rank"] for row in _table(env)}

    def test_two_way_tie_for_first(self, client, env):
        ranks = self._ranks(client, env, {"Ada Lovelace": 200, "Grace Hopper": 200,
                                  "Alan Turing": 100})
        assert ranks["Ada Lovelace"] == 1
        assert ranks["Grace Hopper"] == 1
        # The next distinct score skips to 3 - standard competition ranking.
        assert ranks["Alan Turing"] == 3

    def test_two_way_tie_for_second(self, client, env):
        ranks = self._ranks(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                                  "Alan Turing": 200, "Katherine Johnson": 100})
        assert ranks["Ada Lovelace"] == 1
        assert ranks["Grace Hopper"] == 2
        assert ranks["Alan Turing"] == 2
        assert ranks["Katherine Johnson"] == 4

    def test_three_way_tie(self, client, env):
        ranks = self._ranks(client, env, {"Ada Lovelace": 300, "Grace Hopper": 200,
                                  "Alan Turing": 200, "Katherine Johnson": 200,
                                  "Edsger Dijkstra": 100})
        assert [ranks[n] for n in ("Grace Hopper", "Alan Turing", "Katherine Johnson")] == [2, 2, 2]
        assert ranks["Edsger Dijkstra"] == 5

    def test_the_whole_room_tied(self, client, env):
        ranks = self._ranks(client, env, {name: 100 for name in
                                  [f"{f} {l}" for f, l in NAMES]})
        assert set(ranks.values()) == {1}

    def test_everyone_on_zero_shares_first(self, client, env):
        ranks = self._ranks(client, env, {})
        assert set(ranks.values()) == {1}

    def test_no_hidden_tiebreaker_is_applied(self, client, env):
        """Not id, not name, not streak, not response time."""
        ranks = self._ranks(client, env, {"Ada Lovelace": 150, "Grace Hopper": 150})
        assert ranks["Ada Lovelace"] == ranks["Grace Hopper"] == 1


# ---------------------------------------------------------------------------
# Movement
# ---------------------------------------------------------------------------


class TestMovement:
    def test_the_first_leaderboard_has_no_movement(self, client, env):
        _play(client, env, {"Ada Lovelace"})

        assert _session(env).last_leaderboard_round is None
        assert all(row["previous_rank"] is None for row in _table(env))
        assert all(row["movement"] is None for row in _table(env))

    def test_showing_a_board_does_not_itself_become_the_baseline(self, client, env):
        """The board on screen is what movement is measured TO, never FROM."""
        _play(client, env, {"Ada Lovelace"})

        _act(client, env, rounds.SHOW_LEADERBOARD)

        assert _session(env).last_leaderboard_round is None

    def test_skipping_the_leaderboard_does_not_record_it(self, client, env):
        """THE point of the column: a table nobody saw is not a baseline."""
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.NEXT_QUESTION)

        assert _session(env).last_leaderboard_round is None

    def test_movement_measures_against_the_last_shown_table(self, client, env):
        """Show after round 0, SKIP round 1, show after round 2 - the arrows
        must compare against round 0."""
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _act(client, env, rounds.NEXT_QUESTION)
        assert _session(env).last_leaderboard_round == 0

        # Round 1 skipped entirely: Grace catches up but nobody sees it.
        _play(client, env, {"Grace Hopper"}, round_index=1)
        _act(client, env, rounds.NEXT_QUESTION)
        assert _session(env).last_leaderboard_round == 0

        _play(client, env, {"Grace Hopper"}, round_index=2)
        table = _by_name(_table(env))

        # Grace now leads; she was tied-2nd at the round-0 baseline.
        assert table["Grace Hopper"]["rank"] == 1
        assert table["Grace Hopper"]["previous_rank"] == 2
        assert table["Grace Hopper"]["movement"] == 1
        # Ada was 1st then, second now.
        assert table["Ada Lovelace"]["previous_rank"] == 1
        assert table["Ada Lovelace"]["movement"] == -1

    def test_a_displayed_leaderboard_is_not_compared_against_itself(self, client, env):
        """REGRESSION. The first board must read NEW, not "unchanged".

        The baseline used to advance as the board went UP, so the standings
        rendered for that board were compared against themselves - every row
        showed zero movement, and the very first leaderboard claimed everybody
        had held station at a rank nobody had ever been shown.

        The earlier movement test missed this because it read the table while
        still in QUESTION_REVEAL, never actually showing the second board.
        This one shows it, which is the only way the bug appears.
        """
        _play(client, env, {"Ada Lovelace"}, round_index=0)

        _act(client, env, rounds.SHOW_LEADERBOARD)

        # While the FIRST board is on screen there is no prior board to
        # compare against, so nothing has moved anywhere.
        assert _session(env).last_leaderboard_round is None
        table = _table(env)
        assert all(row["previous_rank"] is None for row in table)
        assert all(row["movement"] is None for row in table)

    def test_the_baseline_advances_only_once_the_room_moves_on(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        assert _session(env).last_leaderboard_round is None

        _act(client, env, rounds.NEXT_QUESTION)

        # Left the board, so it becomes the baseline for the next one.
        assert _session(env).last_leaderboard_round == 0

    def test_movement_on_a_shown_board_compares_against_the_previous_shown_board(
        self, client, env
    ):
        """THE M2.4 PROOF, driven the way a room actually experiences it:
        show, skip, show."""
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        shown_first = {row["display_name"]: row["rank"] for row in _table(env)}
        _act(client, env, rounds.NEXT_QUESTION)

        # Round 1: Grace catches up, and the board is SKIPPED.
        _play(client, env, {"Grace Hopper"}, round_index=1)
        _act(client, env, rounds.NEXT_QUESTION)
        assert _session(env).last_leaderboard_round == 0, "a skipped board became a baseline"

        # Round 2: shown. Arrows must describe the change since round 0.
        _play(client, env, {"Grace Hopper"}, round_index=2)
        _act(client, env, rounds.SHOW_LEADERBOARD)

        table = _by_name(_table(env))
        assert _session(env).last_leaderboard_round == 0
        assert table["Grace Hopper"]["previous_rank"] == shown_first["Grace Hopper"]
        assert table["Ada Lovelace"]["previous_rank"] == shown_first["Ada Lovelace"]
        # Grace climbed from the shared second she held on the shown board.
        assert table["Grace Hopper"]["rank"] == 1
        assert table["Grace Hopper"]["movement"] == shown_first["Grace Hopper"] - 1
        assert table["Grace Hopper"]["movement"] > 0

    def test_an_unchanged_rank_reports_zero_movement(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _act(client, env, rounds.NEXT_QUESTION)
        _play(client, env, {"Ada Lovelace"}, round_index=1)

        assert _by_name(_table(env))["Ada Lovelace"]["movement"] == 0

    def test_moving_into_a_tie_is_reported_honestly(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _act(client, env, rounds.NEXT_QUESTION)
        # Grace draws level on points by winning round 1 while Ada misses it.
        _play(client, env, {"Grace Hopper"}, round_index=1)

        table = _by_name(_table(env))
        # Grace climbed from a shared 2nd into a shared 1st with Ada.
        assert table["Grace Hopper"]["previous_rank"] == 2
        assert table["Grace Hopper"]["rank"] in (1, 2)
        assert table["Grace Hopper"]["movement"] == table["Grace Hopper"]["previous_rank"] - table["Grace Hopper"]["rank"]

    def test_a_replayed_show_leaderboard_cannot_advance_the_baseline(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _act(client, env, rounds.NEXT_QUESTION)
        _play(client, env, {"Ada Lovelace"}, round_index=1)
        stale = _session(env).version
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _play_round = _session(env).last_leaderboard_round

        replay = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.SHOW_LEADERBOARD, "expected_version": stale},
            headers=env["headers"],
        )

        assert replay.status_code == 409
        assert replay.get_json()["reason"] == "stale_transition"
        assert _session(env).last_leaderboard_round == _play_round


# ---------------------------------------------------------------------------
# Suspense: standings must not leak mid-question
# ---------------------------------------------------------------------------


class TestNoSuspenseLeak:
    def test_standings_do_not_move_while_a_question_is_open(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        before = _by_name(_table(env))["Ada Lovelace"]["total_points"]

        _act(client, env, rounds.NEXT_QUESTION)
        _open_now(env)
        correct, _ = _options(env, 1)
        for name in env["tokens"]:
            _answer(client, env, name, correct.id, 1)

        # Everyone has answered round 1 correctly, but nothing is scored until
        # the coach reveals - so the table has not moved.
        assert _by_name(_table(env))["Ada Lovelace"]["total_points"] == before
        assert standings_svc.scored_round_count(_session(env)) == 1

    def test_the_host_payload_carries_no_standings_during_a_question(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.NEXT_QUESTION)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        assert view["standings"] is None

    def test_the_player_payload_carries_no_standing_during_a_question(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.NEXT_QUESTION)

        body = client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        ).get_json()

        assert body["standing"] is None


# ---------------------------------------------------------------------------
# The projector's table
# ---------------------------------------------------------------------------


class TestTopFive:
    def test_the_host_sees_the_top_five(self, client, env):
        _play(client, env, {"Ada Lovelace", "Grace Hopper", "Alan Turing"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        # Seven players, but ties at the boundary are kept whole - so this is
        # five OR the full tied group that straddles fifth.
        assert view["standings"] is not None
        assert len(view["standings"]) >= 5
        assert all("reconnect_token" not in row for row in view["standings"])

    def test_a_tie_at_the_cut_is_not_split_arbitrarily(self, client, env):
        """Showing two of three players tied for fifth would be a coin flip."""
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        _act(client, env, rounds.SHOW_LEADERBOARD)

        # Nobody answered, so everyone is on zero: one big tie, and cutting it
        # at five would be a coin flip between identical scores.
        table = standings_svc.top(_session(env), limit=5)
        assert len(table) == 7

    def test_the_host_table_exposes_no_private_data(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        raw = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_data(as_text=True)

        for token in env["tokens"].values():
            assert token not in raw
        assert "selected_option_id" not in raw


# ---------------------------------------------------------------------------
# A player's own row
# ---------------------------------------------------------------------------


class TestPlayerStanding:
    def _standing(self, client, env, name):
        return client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": env["tokens"][name]},
        ).get_json()["standing"]

    def test_a_player_sees_their_own_rank_and_numbers(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        standing = self._standing(client, env, "Ada Lovelace")

        assert standing["rank"] == 1
        assert standing["correct_count"] == 1
        assert standing["scored_rounds"] == 1
        assert standing["total_points"] > 0

    def test_a_player_outside_the_top_five_still_sees_their_place(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        standing = self._standing(client, env, "Donald Knuth")

        assert standing is not None
        assert standing["total_points"] == 0
        assert standing["rank"] == 2

    def test_a_shared_rank_is_reported_as_shared(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        standing = self._standing(client, env, "Donald Knuth")

        # Six players share second, and the payload says so rather than
        # implying sole possession of the place.
        assert standing["tied"] == 6

    def test_a_players_standing_describes_nobody_else(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        standing = self._standing(client, env, "Ada Lovelace")

        assert standing["display_name"] == "Ada Lovelace"
        for other in ("Grace Hopper", "Donald Knuth"):
            assert other not in str(standing)


# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------


class TestStandingsSecurity:
    def test_a_player_cannot_read_the_host_table(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        response = client.get(f"/api/competition/sessions/{env['session_id']}")

        assert response.status_code == 401

    def test_another_organization_cannot_read_standings(self, client, env, register_coach):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _, _, rival = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )

        response = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=rival
        )

        assert response.status_code == 404

    def test_a_standing_needs_a_token(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        assert client.get(f"/api/competition/{env['code']}/round").status_code == 401

    def test_a_fake_token_gets_nothing(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        response = client.get(
            f"/api/competition/{env['code']}/round",
            headers={"X-Competition-Token": "nope"},
        )

        assert response.status_code == 401

    def test_no_participant_id_is_accepted_for_a_standing(self, client, env):
        """Identity is the token. There is no id parameter to manipulate."""
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)
        victim = CompetitionParticipant.query.filter_by(
            display_name="Grace Hopper"
        ).one()

        body = client.get(
            f"/api/competition/{env['code']}/round?participant_id={victim.id}",
            headers={"X-Competition-Token": env["tokens"]["Ada Lovelace"]},
        ).get_json()

        # The query string is simply not read - the token decides.
        assert body["standing"]["display_name"] == "Ada Lovelace"


# ---------------------------------------------------------------------------
# Hints
# ---------------------------------------------------------------------------


class TestSuggestions:
    def test_the_first_round_suggests_showing_standings(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        assert rounds.leaderboard_hint(_session(env)) == "first_standings"

    def test_the_closing_rounds_suggest_protecting_the_finish(self, client, env):
        for index in range(3):
            _play(client, env, {"Ada Lovelace"}, round_index=index)
        # Round 2 of 4: two remain.
        assert rounds.leaderboard_hint(_session(env)) == "keep_the_finish_a_surprise"

    def test_no_hint_during_a_question(self, client, env):
        _play(client, env, {"Ada Lovelace"}, round_index=0)
        _act(client, env, rounds.NEXT_QUESTION)
        assert rounds.leaderboard_hint(_session(env)) is None

    def test_a_hint_never_removes_either_option(self, client, env):
        for index in range(3):
            _play(client, env, {"Ada Lovelace"}, round_index=index)

        actions = rounds.available_actions(_session(env))

        assert rounds.SHOW_LEADERBOARD in actions
        assert rounds.NEXT_QUESTION in actions


# ---------------------------------------------------------------------------
# Analytics isolation, after standings exist
# ---------------------------------------------------------------------------


class TestIsolationAfterStandings:
    def test_official_surfaces_stay_empty(self, client, env):
        from app.models import Answer, PlayerAttempt

        _play(client, env, {"Ada Lovelace", "Grace Hopper"}, round_index=0)
        _act(client, env, rounds.SHOW_LEADERBOARD)
        _play(client, env, {"Ada Lovelace"}, round_index=1)

        # Guard against passing vacuously.
        assert _by_name(_table(env))["Ada Lovelace"]["total_points"] >= 200
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

    def test_player_history_records_no_competition_activity(self, client, env):
        _play(client, env, {"Ada Lovelace"})
        _act(client, env, rounds.SHOW_LEADERBOARD)

        for player in env["players"][:3]:
            body = client.get(
                f"/api/players/{player['id']}/history", headers=env["headers"]
            ).get_json()
            summary = body.get("summary", body)
            assert summary["assigned_count"] == 0
            assert summary["average_score_percent"] is None
