"""Competition M2.1 - the round state machine.

The centrepiece is TestIllegalTransitions, which walks the ENTIRE cartesian
product of states and actions and asserts that everything absent from the
transition table is refused. A test that only checks the happy path would let
a future edit quietly add a reachable impossible state; this one cannot.

M2.1 has no answers, no scoring and no UI. Answer rows are inserted directly
where a test needs `answered_count` to move, because the submission endpoint
is M2.2's job.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import CompetitionAnswer, CompetitionParticipant, CompetitionSession
from app.models.competition import (
    ABANDONED,
    COMPLETE,
    COMPETITION_STATUSES,
    LEADERBOARD,
    LOBBY,
    PODIUM,
    PODIUM_LAST_STEP,
    QUESTION_OPEN,
    QUESTION_REVEAL,
)
from app.services import competition_rounds as rounds

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_quiz(client, headers, count=3, title="Coverages"):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
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
    quiz_id = _make_quiz(client, headers)
    players = []
    for first, last in (("Ada", "Lovelace"), ("Grace", "Hopper")):
        players.append(
            client.post(
                "/api/players", json={"first_name": first, "last_name": last}, headers=headers
            ).get_json()
        )
    lobby = client.post(f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers)
    assert lobby.status_code == 201, lobby.get_json()
    return {
        "headers": headers,
        "quiz_id": quiz_id,
        "players": players,
        "session_id": lobby.get_json()["id"],
        "code": lobby.get_json()["join_code"],
    }


def _session(env) -> CompetitionSession:
    return db.session.get(CompetitionSession, env["session_id"])


def _act(client, env, action, version=None):
    """Send a transition, defaulting to the version the server is actually on."""
    if version is None:
        version = _session(env).version
    return client.post(
        f"/api/competition/sessions/{env['session_id']}/transition",
        json={"action": action, "expected_version": version},
        headers=env["headers"],
    )


def _join_all(client, env):
    tokens = []
    for player in env["players"]:
        body = client.post(
            f"/api/competition/{env['code']}/join", json={"player_id": player["id"]}
        ).get_json()
        tokens.append(body["reconnect_token"])
    return tokens


# ---------------------------------------------------------------------------
# The legal path
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_a_full_competition_walks_the_whole_machine(self, client, env):
        _join_all(client, env)

        assert _act(client, env, rounds.START_QUESTION).status_code == 200
        assert _session(env).status == QUESTION_OPEN

        for round_index in range(3):
            assert _session(env).current_round == round_index
            assert _act(client, env, rounds.SHOW_ANSWER).status_code == 200
            assert _session(env).status == QUESTION_REVEAL
            assert _act(client, env, rounds.SHOW_LEADERBOARD).status_code == 200
            assert _session(env).status == LEADERBOARD
            if round_index < 2:
                assert _act(client, env, rounds.NEXT_QUESTION).status_code == 200
                assert _session(env).status == QUESTION_OPEN

        assert _act(client, env, rounds.FINISH).status_code == 200
        assert _session(env).status == PODIUM

        for step in range(1, PODIUM_LAST_STEP + 1):
            assert _act(client, env, rounds.ADVANCE_PODIUM).status_code == 200
            assert _session(env).podium_step == step

        assert _act(client, env, rounds.COMPLETE_COMPETITION).status_code == 200
        session = _session(env)
        assert session.status == COMPLETE
        assert session.ended_at is not None

    def test_the_leaderboard_can_be_skipped_entirely(self, client, env):
        """The coach must never be forced to show standings."""
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)

        assert _act(client, env, rounds.NEXT_QUESTION).status_code == 200
        assert _session(env).status == QUESTION_OPEN
        assert _session(env).current_round == 1

    def test_a_coach_can_finish_early(self, client, env):
        """Stopping after one question still gets a podium, not a dead end."""
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)

        assert _act(client, env, rounds.FINISH).status_code == 200
        assert _session(env).status == PODIUM

    def test_every_transition_bumps_the_version(self, client, env):
        _join_all(client, env)
        seen = [_session(env).version]
        for action in (rounds.START_QUESTION, rounds.SHOW_ANSWER, rounds.SHOW_LEADERBOARD):
            _act(client, env, action)
            seen.append(_session(env).version)
        # Strictly increasing: every client refetches on every state change.
        assert seen == sorted(set(seen))
        assert len(set(seen)) == len(seen)


# ---------------------------------------------------------------------------
# THE MATRIX
# ---------------------------------------------------------------------------


class TestIllegalTransitions:
    """Everything not in the table must be refused - checked exhaustively."""

    @pytest.mark.parametrize("status", [s for s in COMPETITION_STATUSES])
    @pytest.mark.parametrize("action", sorted(rounds.ACTIONS))
    def test_the_whole_product_of_states_and_actions(self, client, env, status, action):
        session = _session(env)
        session.status = status
        # A podium test needs room to advance; everything else is unaffected.
        session.podium_step = 0
        session.question_order = [1, 2, 3]
        session.current_round = 0
        db.session.commit()

        response = _act(client, env, action)
        legal = (status, action) in rounds.TRANSITIONS

        if status in (COMPLETE, ABANDONED):
            # Terminal beats everything, including otherwise-legal actions.
            assert response.status_code == 409
            assert response.get_json()["reason"] == "session_ended"
        elif legal:
            assert response.status_code == 200, response.get_json()
        else:
            assert response.status_code == 409, (status, action, response.get_json())
            assert response.get_json()["reason"] == "illegal_transition"

    def test_an_unknown_action_is_refused_by_validation(self, client, env):
        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": "TELEPORT", "expected_version": _session(env).version},
            headers=env["headers"],
        )
        assert response.status_code == 422

    def test_the_podium_cannot_advance_past_the_last_step(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        _act(client, env, rounds.FINISH)
        for _ in range(PODIUM_LAST_STEP):
            _act(client, env, rounds.ADVANCE_PODIUM)

        response = _act(client, env, rounds.ADVANCE_PODIUM)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "podium_finished"

    def test_next_question_past_the_end_is_refused(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        for _ in range(2):
            _act(client, env, rounds.SHOW_ANSWER)
            _act(client, env, rounds.NEXT_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)  # reveal of the LAST question

        response = _act(client, env, rounds.NEXT_QUESTION)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "no_such_round"


# ---------------------------------------------------------------------------
# Two host tabs
# ---------------------------------------------------------------------------


class TestConcurrentHosts:
    def test_a_stale_version_is_refused(self, client, env):
        """Two tabs, or one double-clicked button. Only the first applies."""
        _join_all(client, env)
        stale = _session(env).version
        assert _act(client, env, rounds.START_QUESTION, version=stale).status_code == 200

        response = _act(client, env, rounds.SHOW_ANSWER, version=stale)

        assert response.status_code == 409
        assert response.get_json()["reason"] == "stale_transition"
        # And it tells the losing tab what the truth is, so it can resync.
        assert response.get_json()["details"]["current_version"] == _session(env).version

    def test_a_double_clicked_next_question_advances_one_round(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        version = _session(env).version

        first = _act(client, env, rounds.NEXT_QUESTION, version=version)
        second = _act(client, env, rounds.NEXT_QUESTION, version=version)

        assert first.status_code == 200
        assert second.status_code == 409
        # THE POINT: a double click must not skip a question.
        assert _session(env).current_round == 1

    def test_expected_version_is_required(self, client, env):
        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.START_QUESTION},
            headers=env["headers"],
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# The frozen question order
# ---------------------------------------------------------------------------


class TestQuestionOrder:
    def test_the_order_is_frozen_at_the_first_question(self, client, env):
        _join_all(client, env)
        assert _session(env).question_order == []

        _act(client, env, rounds.START_QUESTION)

        order = _session(env).question_order
        assert len(order) == 3
        assert _session(env).total_rounds == 3

    def test_editing_the_quiz_mid_competition_cannot_shift_rounds(self, client, env):
        """THE reason question_order exists.

        A coach adding a question at position 1 while the competition runs
        would otherwise change which question round 2 plays - after players
        had already answered it.
        """
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        frozen = list(_session(env).question_order)

        client.post(
            f"/api/quizzes/{env['quiz_id']}/questions",
            json={
                "question_text": "Inserted mid-game",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
            },
            headers=env["headers"],
        )

        _act(client, env, rounds.SHOW_ANSWER)
        _act(client, env, rounds.NEXT_QUESTION)

        assert _session(env).question_order == frozen
        assert _session(env).total_rounds == 3
        assert _session(env).question_id_for_round(1) == frozen[1]

    def test_a_quiz_emptied_of_playable_questions_refuses_to_start(self, client, env):
        for question in client.get(
            f"/api/quizzes/{env['quiz_id']}", headers=env["headers"]
        ).get_json()["questions"]:
            client.delete(
                f"/api/quizzes/{env['quiz_id']}/questions/{question['id']}",
                headers=env["headers"],
            )

        response = _act(client, env, rounds.START_QUESTION)

        assert response.status_code == 422
        assert response.get_json()["reason"] == "no_playable_questions"
        assert _session(env).status == LOBBY


# ---------------------------------------------------------------------------
# The clock
# ---------------------------------------------------------------------------


class TestQuestionClock:
    def test_starting_a_question_sets_a_server_window_with_a_lead_in(self, client, env):
        _join_all(client, env)

        _act(client, env, rounds.START_QUESTION)

        session = _session(env)
        opens = session.question_opened_at
        closes = session.question_closes_at
        assert opens is not None and closes is not None
        # Opens in the FUTURE: that is the 3-2-1, and it needs no state.
        assert opens > datetime.now(timezone.utc)
        assert (closes - opens).total_seconds() == session.question_time_seconds

    def test_answering_is_shut_during_the_lead_in(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)

        # The window has not opened yet, so nothing may be submitted.
        assert _session(env).answering_open is False

    def test_answering_opens_once_the_lead_in_passes(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        session = _session(env)
        session.question_opened_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()

        assert _session(env).answering_open is True

    def test_answering_closes_when_the_clock_runs_out_without_any_transition(
        self, client, env
    ):
        """THE design decision: time closes the window, the coach reveals.

        The status is still QUESTION_OPEN - nothing moved the room on - but
        no answer would be accepted.
        """
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        session = _session(env)
        session.question_closes_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()

        assert _session(env).status == QUESTION_OPEN
        assert _session(env).answering_open is False

    def test_a_reveal_shuts_the_window_even_with_time_left(self, client, env):
        """Revealing early - because everyone was already in - must close
        answering without needing a separate rule."""
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        session = _session(env)
        session.question_opened_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()
        assert _session(env).answering_open is True

        _act(client, env, rounds.SHOW_ANSWER)

        assert _session(env).answering_open is False

    def test_each_round_gets_a_fresh_window(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        first_close = _session(env).question_closes_at
        _act(client, env, rounds.SHOW_ANSWER)

        _act(client, env, rounds.NEXT_QUESTION)

        assert _session(env).question_closes_at > first_close


# ---------------------------------------------------------------------------
# ALL IN
# ---------------------------------------------------------------------------


class TestAllIn:
    def _answer(self, env, participant, round_index=0):
        db.session.add(
            CompetitionAnswer(
                session_id=env["session_id"],
                participant_id=participant.id,
                question_id=_session(env).question_order[round_index],
                round_index=round_index,
                selected_option_id=1,
                is_correct=True,
                response_ms=1000,
                points_awarded=0,
            )
        )
        db.session.commit()

    def test_all_in_becomes_true_only_when_every_seat_has_answered(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        participants = CompetitionParticipant.query.filter_by(
            session_id=env["session_id"]
        ).all()

        assert _session(env).all_in is False
        self._answer(env, participants[0])
        assert _session(env).answered_count == 1
        assert _session(env).all_in is False

        self._answer(env, participants[1])
        assert _session(env).answered_count == 2
        assert _session(env).all_in is True

    def test_all_in_does_not_move_the_room_by_itself(self, client, env):
        """Server authority AND coach control: everyone being in is
        information, not a transition."""
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        for participant in CompetitionParticipant.query.all():
            self._answer(env, participant)
        version = _session(env).version

        assert _session(env).all_in is True
        # Nothing changed on its own.
        assert _session(env).status == QUESTION_OPEN
        assert _session(env).version == version

    def test_answering_a_round_does_not_bump_the_version(self, client, env):
        """Counters ride the poll; version marks structural change.

        Bumping per submission would make 30 phones refetch heavy state 30
        times a round - the stampede the M1 load harness caught.
        """
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        before = _session(env).version

        for participant in CompetitionParticipant.query.all():
            self._answer(env, participant)

        assert _session(env).version == before

    def test_the_count_is_scoped_to_the_current_round(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        for participant in CompetitionParticipant.query.all():
            self._answer(env, participant, round_index=0)
        _act(client, env, rounds.SHOW_ANSWER)

        _act(client, env, rounds.NEXT_QUESTION)

        # Round 1 has its own tally; last round's answers must not carry over.
        assert _session(env).current_round == 1
        assert _session(env).answered_count == 0
        assert _session(env).all_in is False

    def test_an_empty_room_is_never_all_in(self, client, env):
        _act(client, env, rounds.START_QUESTION)
        assert _session(env).participant_count == 0
        assert _session(env).all_in is False


# ---------------------------------------------------------------------------
# The poll
# ---------------------------------------------------------------------------


class TestPollPayload:
    def test_the_poll_still_issues_one_query(self, client, env):
        """Two counts now ride it. It must still be a single statement."""
        from sqlalchemy import event

        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        db.session.remove()

        statements = []

        def record(conn, cursor, statement, params, context, executemany):
            statements.append(statement)

        event.listen(db.engine, "before_cursor_execute", record)
        try:
            assert client.get(f"/api/competition/{env['code']}/state").status_code == 200
        finally:
            event.remove(db.engine, "before_cursor_execute", record)

        assert len(statements) == 1, statements
        assert "joined_at" not in statements[0], "participant rows must not be selected"

    def test_the_poll_writes_nothing(self, client, env):
        from sqlalchemy import event

        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        writes = []

        def record(conn, cursor, statement, params, context, executemany):
            if statement.lstrip().upper().startswith(("UPDATE", "INSERT", "DELETE")):
                writes.append(statement)

        event.listen(db.engine, "before_cursor_execute", record)
        try:
            for _ in range(4):
                client.get(f"/api/competition/{env['code']}/state")
        finally:
            event.remove(db.engine, "before_cursor_execute", record)

        assert writes == []

    def test_the_poll_carries_what_a_round_needs_and_no_identities(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)

        response = client.get(f"/api/competition/{env['code']}/state")
        body = response.get_json()

        assert set(body) == {
            "version",
            "status",
            "server_now",
            "current_round",
            "question_opened_at",
            "question_closes_at",
            "participant_count",
            "answered_count",
            "all_in",
            "answering_open",
            "total_rounds",
            "podium_step",
        }
        raw = response.get_data(as_text=True)
        # Still counts only - never who answered, and never the question.
        for leak in ("Ada Lovelace", "display_name", "player_id", "question_text", "options"):
            assert leak not in raw


# ---------------------------------------------------------------------------
# Host control surface
# ---------------------------------------------------------------------------


class TestHostControls:
    def test_available_actions_match_the_transition_table(self, client, env):
        _join_all(client, env)
        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()
        assert view["available_actions"] == [rounds.START_QUESTION]

        _act(client, env, rounds.START_QUESTION)
        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()
        assert view["available_actions"] == [rounds.SHOW_ANSWER]

    def test_next_question_disappears_on_the_final_round(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        for _ in range(2):
            _act(client, env, rounds.SHOW_ANSWER)
            _act(client, env, rounds.NEXT_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        assert rounds.NEXT_QUESTION not in view["available_actions"]
        assert rounds.FINISH in view["available_actions"]

    def test_the_leaderboard_hint_is_a_suggestion_at_the_right_moments(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        first = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()
        assert first["leaderboard_hint"] == "first_standings"

        _act(client, env, rounds.NEXT_QUESTION)
        _act(client, env, rounds.SHOW_ANSWER)
        near_end = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()
        # Two rounds from the end: protect the finish.
        assert near_end["leaderboard_hint"] == "keep_the_finish_a_surprise"
        # And it never removes the coach's options.
        assert rounds.SHOW_LEADERBOARD in near_end["available_actions"]

    def test_the_host_view_never_names_who_has_not_answered(self, client, env):
        _join_all(client, env)
        _act(client, env, rounds.START_QUESTION)

        view = client.get(
            f"/api/competition/sessions/{env['session_id']}", headers=env["headers"]
        ).get_json()

        # Counts, yes. A list of stragglers to project on a wall, no.
        assert view["answered_count"] == 0
        assert view["participant_count"] == 2
        assert "not_answered" not in view
        assert view["not_joined"] == []


# ---------------------------------------------------------------------------
# Tenancy - M1's guarantees must survive M2
# ---------------------------------------------------------------------------


class TestTransitionSecurity:
    def test_another_organization_cannot_move_the_room(self, client, env, register_coach):
        _, _, rival = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        _join_all(client, env)

        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.START_QUESTION, "expected_version": _session(env).version},
            headers=rival,
        )

        assert response.status_code == 404
        assert _session(env).status == LOBBY

    def test_transitions_require_authentication(self, client, env):
        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.START_QUESTION, "expected_version": 1},
        )
        assert response.status_code == 401

    def test_players_cannot_move_the_room_with_a_seat_token(self, client, env):
        """A participant token authenticates a SEAT, never a host control."""
        tokens = _join_all(client, env)

        response = client.post(
            f"/api/competition/sessions/{env['session_id']}/transition",
            json={"action": rounds.START_QUESTION, "expected_version": _session(env).version},
            headers={"X-Competition-Token": tokens[0]},
        )

        assert response.status_code == 401
        assert _session(env).status == LOBBY
