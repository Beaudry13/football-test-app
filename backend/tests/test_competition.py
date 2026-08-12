"""Competition Mode - Milestone 1 (lobby foundation).

These tests are the acceptance criteria, not a smoke screen. The ones that
matter most are the last two classes: TENANCY, which proves another
organization cannot see or control a session, and ANALYTICS ISOLATION, which
proves a competition leaves no trace in any surface a coach reads for real
results. That second one is checked against the ACTUAL analytics endpoints
rather than by asserting a table is empty, because "the rows are not there"
is only worth anything if the surfaces that would have shown them agree.
"""

import pytest

from app.extensions import db
from app.models import CompetitionParticipant, CompetitionSession, Player, PlayerAttempt
from app.models.competition import ABANDONED, COMPLETE, LOBBY


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_quiz(client, headers, title="Coverages", types=("multiple_choice", "true_false")):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    quiz_id = quiz["id"]
    for index, qtype in enumerate(types):
        payload = {"question_text": f"Q{index}", "question_type": qtype}
        if qtype == "multiple_choice":
            payload["options"] = [
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ]
        elif qtype == "true_false":
            payload["options"] = [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ]
        response = client.post(
            f"/api/quizzes/{quiz_id}/questions", json=payload, headers=headers
        )
        assert response.status_code == 201, response.get_json()
    return quiz_id


def _make_players(client, headers, names=("Ada Lovelace", "Grace Hopper", "Alan Turing")):
    made = []
    for name in names:
        first, last = name.split(" ", 1)
        response = client.post(
            "/api/players",
            json={"first_name": first, "last_name": last},
            headers=headers,
        )
        assert response.status_code == 201, response.get_json()
        made.append(response.get_json())
    return made


@pytest.fixture
def coach_env(client, register_coach):
    _, _, headers = register_coach()
    quiz_id = _make_quiz(client, headers)
    players = _make_players(client, headers)
    return {"headers": headers, "quiz_id": quiz_id, "players": players}


def _open_lobby(client, env, **payload):
    response = client.post(
        f"/api/competition/quizzes/{env['quiz_id']}", json=payload, headers=env["headers"]
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


# ---------------------------------------------------------------------------
# Launch eligibility
# ---------------------------------------------------------------------------


class TestLaunchEligibility:
    def test_supported_quiz_can_launch(self, client, coach_env):
        body = client.get(
            f"/api/competition/quizzes/{coach_env['quiz_id']}/readiness",
            headers=coach_env["headers"],
        ).get_json()
        assert body["can_launch"] is True
        assert body["unsupported_questions"] == []

    def test_unsupported_question_names_itself(self, client, register_coach):
        """A coach must be told WHICH question blocks the competition.

        A bare "this quiz cannot be used" would send them hunting through a
        thirty-question quiz.
        """
        _, _, headers = register_coach()
        quiz_id = _make_quiz(client, headers, types=("multiple_choice", "written"))

        body = client.get(
            f"/api/competition/quizzes/{quiz_id}/readiness", headers=headers
        ).get_json()
        assert body["can_launch"] is False
        assert len(body["unsupported_questions"]) == 1
        blocking = body["unsupported_questions"][0]
        assert blocking["position"] == 2
        assert blocking["question_type"] == "written"
        assert "grade" in blocking["reason"]

    def test_launch_is_refused_not_silently_filtered(self, client, register_coach):
        """The refusal is the point: dropping the question would change what
        the coach thinks they are running."""
        _, _, headers = register_coach()
        quiz_id = _make_quiz(client, headers, types=("multiple_choice", "written"))

        response = client.post(f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers)
        assert response.status_code == 422
        assert response.get_json()["reason"] == "unsupported_questions"
        assert CompetitionSession.query.count() == 0

    def test_empty_quiz_is_refused(self, client, register_coach):
        _, _, headers = register_coach()
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Empty"}, headers=headers
        ).get_json()["id"]

        response = client.post(f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers)
        assert response.status_code == 422

    def test_question_time_must_be_an_offered_choice(self, client, coach_env):
        response = client.post(
            f"/api/competition/quizzes/{coach_env['quiz_id']}",
            json={"question_time_seconds": 7},
            headers=coach_env["headers"],
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# The join code
# ---------------------------------------------------------------------------


class TestJoinCode:
    def test_code_is_unambiguous_on_a_phone(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        assert len(code) == 6
        # No O/0 or I/1: a player reading a projector from the back of a room
        # cannot tell them apart.
        assert not set(code) & set("O0I1")

    def test_code_is_case_insensitive_to_type(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        assert client.get(f"/api/competition/{code.lower()}/state").status_code == 200

    def test_unknown_code_is_a_clean_404(self, client):
        response = client.get("/api/competition/ZZZZZZ/state")
        assert response.status_code == 404
        assert response.get_json()["reason"] == "invalid_code"

    def test_codes_are_unique_across_live_sessions(self, client, coach_env):
        codes = {_open_lobby(client, coach_env)["join_code"] for _ in range(8)}
        assert len(codes) == 8


# ---------------------------------------------------------------------------
# Eligibility scope
# ---------------------------------------------------------------------------


class TestEligibility:
    def test_default_scope_is_the_whole_active_roster(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        assert len(roster) == 3

    def test_deactivated_players_are_not_eligible(self, client, coach_env):
        player_id = coach_env["players"][0]["id"]
        db.session.get(Player, player_id).is_active = False
        db.session.commit()

        code = _open_lobby(client, coach_env)["join_code"]
        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        assert player_id not in {entry["player_id"] for entry in roster}

    def test_group_scope_limits_the_roster(self, client, coach_env):
        headers = coach_env["headers"]
        group = client.post(
            "/api/groups", json={"name": "Defense"}, headers=headers
        ).get_json()
        chosen = coach_env["players"][0]["id"]
        response = client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": [chosen]},
            headers=headers,
        )
        assert response.status_code in (200, 201), response.get_json()

        code = _open_lobby(client, coach_env, group_ids=[group["id"]])["join_code"]
        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        assert [entry["player_id"] for entry in roster] == [chosen]

    def test_a_player_in_two_chosen_groups_appears_once(self, client, coach_env):
        """The union must not double-list anyone - a duplicated name in the
        identity picker is a player wondering which one is theirs."""
        headers = coach_env["headers"]
        chosen = coach_env["players"][0]["id"]
        group_ids = []
        for name in ("Defense", "Special Teams"):
            group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
            client.post(
                f"/api/groups/{group['id']}/members",
                json={"player_ids": [chosen]},
                headers=headers,
            )
            group_ids.append(group["id"])

        code = _open_lobby(client, coach_env, group_ids=group_ids)["join_code"]
        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        assert [entry["player_id"] for entry in roster] == [chosen]


# ---------------------------------------------------------------------------
# Joining
# ---------------------------------------------------------------------------


class TestJoining:
    def test_a_player_joins_by_canonical_id(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        player = coach_env["players"][0]

        body = client.post(
            f"/api/competition/{code}/join", json={"player_id": player["id"]}
        ).get_json()
        assert body["participant"]["player_id"] == player["id"]
        assert body["participant"]["display_name"] == "Ada Lovelace"

    def test_rejoining_with_the_token_returns_the_same_seat(self, client, coach_env):
        """A refresh or a double-tap must not mint a second identity."""
        code = _open_lobby(client, coach_env)["join_code"]
        player_id = coach_env["players"][0]["id"]

        first = client.post(
            f"/api/competition/{code}/join", json={"player_id": player_id}
        ).get_json()
        second = client.post(
            f"/api/competition/{code}/join",
            json={"player_id": player_id},
            headers={"X-Competition-Token": first["reconnect_token"]},
        ).get_json()

        assert first["participant"]["id"] == second["participant"]["id"]
        assert CompetitionParticipant.query.count() == 1

    def test_the_database_itself_forbids_a_second_seat(self, client, coach_env):
        """Not just the service. The constraint is the guarantee."""
        code = _open_lobby(client, coach_env)["join_code"]
        session = CompetitionSession.query.filter_by(join_code=code).first()
        player_id = coach_env["players"][0]["id"]
        client.post(f"/api/competition/{code}/join", json={"player_id": player_id})

        db.session.add(
            CompetitionParticipant(
                session_id=session.id, player_id=player_id, display_name="Impostor"
            )
        )
        with pytest.raises(Exception):
            db.session.commit()
        db.session.rollback()

    def test_a_player_from_another_organization_cannot_join(self, client, coach_env,
                                                            register_coach):
        code = _open_lobby(client, coach_env)["join_code"]
        _, _, other = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        outsider = _make_players(client, other, names=("Mallory Stranger",))[0]

        response = client.post(
            f"/api/competition/{code}/join", json={"player_id": outsider["id"]}
        )
        assert response.status_code == 404
        assert response.get_json()["reason"] == "not_eligible"

    def test_a_player_outside_the_chosen_group_cannot_join(self, client, coach_env):
        headers = coach_env["headers"]
        group = client.post("/api/groups", json={"name": "Defense"}, headers=headers).get_json()
        client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": [coach_env["players"][0]["id"]]},
            headers=headers,
        )
        code = _open_lobby(client, coach_env, group_ids=[group["id"]])["join_code"]

        response = client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][1]["id"]},
        )
        assert response.status_code == 404

    def test_joining_bumps_the_version(self, client, coach_env):
        """Otherwise every phone in the lobby sits on a stale roster."""
        code = _open_lobby(client, coach_env)["join_code"]
        before = client.get(f"/api/competition/{code}/state").get_json()["version"]

        client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )

        after = client.get(f"/api/competition/{code}/state").get_json()["version"]
        assert after > before

    def test_a_rejoin_does_not_bump_the_version(self, client, coach_env):
        """Nothing changed, so nothing should refetch - a rejoin loop must not
        keep thirty phones pulling the heavy payload."""
        code = _open_lobby(client, coach_env)["join_code"]
        player_id = coach_env["players"][0]["id"]
        token = client.post(
            f"/api/competition/{code}/join", json={"player_id": player_id}
        ).get_json()["reconnect_token"]
        settled = client.get(f"/api/competition/{code}/state").get_json()["version"]

        client.post(
            f"/api/competition/{code}/join",
            json={"player_id": player_id},
            headers={"X-Competition-Token": token},
        )

        assert client.get(f"/api/competition/{code}/state").get_json()["version"] == settled

    def test_a_taken_identity_is_marked_in_the_picker(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        player_id = coach_env["players"][0]["id"]
        client.post(f"/api/competition/{code}/join", json={"player_id": player_id})

        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        assert next(e for e in roster if e["player_id"] == player_id)["taken"] is True
        assert all(not e["taken"] for e in roster if e["player_id"] != player_id)

    def test_joining_an_ended_competition_is_refused(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        )

        response = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )
        assert response.status_code == 409
        assert response.get_json()["reason"] == "session_ended"

    def test_joining_an_expired_lobby_is_refused(self, client, coach_env):
        from datetime import datetime, timedelta, timezone

        lobby = _open_lobby(client, coach_env)
        session = db.session.get(CompetitionSession, lobby["id"])
        session.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

        response = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )
        assert response.status_code == 410
        assert response.get_json()["reason"] == "session_expired"


# ---------------------------------------------------------------------------
# Reconnect
# ---------------------------------------------------------------------------


class TestReconnectSecurity:
    """THE credential boundary. Everything here is an attack that must fail.

    A player picks their name in the open - the join code is public and the
    roster endpoint publishes every eligible player_id so the picker can
    render. What must not be public is proving you ARE that player afterwards.
    """

    def _join(self, client, code, player_id, token=None):
        headers = {"X-Competition-Token": token} if token else {}
        return client.post(
            f"/api/competition/{code}/join", json={"player_id": player_id}, headers=headers
        )

    def test_join_issues_a_token(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        body = self._join(client, code, coach_env["players"][0]["id"]).get_json()

        token = body["reconnect_token"]
        assert len(token) >= 32
        # Not derived from anything a third party knows.
        assert str(coach_env["players"][0]["id"]) not in token
        assert str(body["participant"]["id"]) not in token

    def test_tokens_differ_between_players(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        tokens = {
            self._join(client, code, player["id"]).get_json()["reconnect_token"]
            for player in coach_env["players"]
        }
        assert len(tokens) == 3

    def test_the_token_appears_in_no_other_payload(self, client, coach_env):
        """A token echoed into the lobby list would be published to the whole
        room - which is the same hole, just slower."""
        lobby = _open_lobby(client, coach_env)
        code = lobby["join_code"]
        token = self._join(client, code, coach_env["players"][0]["id"]).get_json()[
            "reconnect_token"
        ]

        public = client.get(f"/api/competition/{code}").get_data(as_text=True)
        poll = client.get(f"/api/competition/{code}/state").get_data(as_text=True)
        host = client.get(
            f"/api/competition/sessions/{lobby['id']}", headers=coach_env["headers"]
        ).get_data(as_text=True)

        for payload in (public, poll, host):
            assert token not in payload
            assert "reconnect_token" not in payload

    def test_the_rightful_holder_reconnects(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        joined = self._join(client, code, coach_env["players"][0]["id"]).get_json()

        recovered = client.get(
            f"/api/competition/{code}/me",
            headers={"X-Competition-Token": joined["reconnect_token"]},
        )
        assert recovered.status_code == 200
        assert recovered.get_json()["participant"]["id"] == joined["participant"]["id"]

    def test_reconnect_without_a_token_is_refused(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        self._join(client, code, coach_env["players"][0]["id"])

        response = client.get(f"/api/competition/{code}/me")
        assert response.status_code == 401
        assert response.get_json()["reason"] == "missing_token"

    def test_a_wrong_token_is_refused(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        self._join(client, code, coach_env["players"][0]["id"])

        response = client.get(
            f"/api/competition/{code}/me", headers={"X-Competition-Token": "not-a-real-token"}
        )
        assert response.status_code == 401
        assert response.get_json()["reason"] == "invalid_token"

    def test_a_player_id_is_not_a_credential(self, client, coach_env):
        """THE ORIGINAL HOLE. The roster endpoint publishes every player_id;
        pairing one with the public code used to be enough to reconnect."""
        code = _open_lobby(client, coach_env)["join_code"]
        victim = coach_env["players"][0]["id"]
        self._join(client, code, victim)

        roster = client.get(f"/api/competition/{code}").get_json()["roster"]
        harvested = [e["player_id"] for e in roster]
        assert victim in harvested, "the attack starts from public data"

        # The old route is gone entirely, and its shape proves nothing now.
        assert client.get(f"/api/competition/{code}/me/{victim}").status_code == 404
        assert client.get(
            f"/api/competition/{code}/me", headers={"X-Competition-Token": str(victim)}
        ).status_code == 401

    def test_a_participant_id_is_not_a_credential(self, client, coach_env):
        """Participant ids are sequential AND published in the host view."""
        code = _open_lobby(client, coach_env)["join_code"]
        joined = self._join(client, code, coach_env["players"][0]["id"]).get_json()

        response = client.get(
            f"/api/competition/{code}/me",
            headers={"X-Competition-Token": str(joined["participant"]["id"])},
        )
        assert response.status_code == 401

    def test_a_second_device_cannot_seize_a_taken_identity(self, client, coach_env):
        """The takeover that mattered most: rejoining as someone else used to
        hand back their seat AND their token."""
        code = _open_lobby(client, coach_env)["join_code"]
        victim = coach_env["players"][0]["id"]
        legitimate = self._join(client, code, victim).get_json()

        attacker = self._join(client, code, victim)

        assert attacker.status_code == 409
        assert attacker.get_json()["reason"] == "identity_taken"
        assert "reconnect_token" not in attacker.get_json()
        assert CompetitionParticipant.query.count() == 1
        # And the real player is untouched.
        assert client.get(
            f"/api/competition/{code}/me",
            headers={"X-Competition-Token": legitimate["reconnect_token"]},
        ).status_code == 200

    def test_the_holder_may_retry_join_idempotently(self, client, coach_env):
        """A lost response must not cost a seat - but only for the holder."""
        code = _open_lobby(client, coach_env)["join_code"]
        player_id = coach_env["players"][0]["id"]
        first = self._join(client, code, player_id).get_json()

        retry = self._join(client, code, player_id, token=first["reconnect_token"])

        assert retry.status_code == 200
        assert retry.get_json()["participant"]["id"] == first["participant"]["id"]
        assert CompetitionParticipant.query.count() == 1

    def test_a_token_from_another_competition_is_refused(self, client, coach_env):
        """Tokens are scoped to a session, not merely unguessable."""
        first = _open_lobby(client, coach_env)["join_code"]
        second = _open_lobby(client, coach_env)["join_code"]
        token = self._join(client, first, coach_env["players"][0]["id"]).get_json()[
            "reconnect_token"
        ]

        response = client.get(
            f"/api/competition/{second}/me", headers={"X-Competition-Token": token}
        )
        assert response.status_code == 401

    def test_removal_revokes_the_token(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        joined = self._join(client, lobby["join_code"], coach_env["players"][0]["id"]).get_json()

        client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=coach_env["headers"],
        )

        response = client.get(
            f"/api/competition/{lobby['join_code']}/me",
            headers={"X-Competition-Token": joined["reconnect_token"]},
        )
        assert response.status_code == 401

    def test_removal_frees_the_identity_for_a_fresh_join(self, client, coach_env):
        """The documented recovery path for a player who lost their token."""
        lobby = _open_lobby(client, coach_env)
        code = lobby["join_code"]
        player_id = coach_env["players"][0]["id"]
        joined = self._join(client, code, player_id).get_json()
        client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=coach_env["headers"],
        )

        rejoined = self._join(client, code, player_id)
        assert rejoined.status_code == 200
        # A NEW secret - the old one must not come back to life.
        assert rejoined.get_json()["reconnect_token"] != joined["reconnect_token"]

    def test_reconnect_never_creates_a_seat(self, client, coach_env):
        code = _open_lobby(client, coach_env)["join_code"]
        response = client.get(
            f"/api/competition/{code}/me", headers={"X-Competition-Token": "anything"}
        )
        assert response.status_code == 401
        assert CompetitionParticipant.query.count() == 0

    def test_the_coach_can_reopen_the_host_view(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        self._join(client, lobby["join_code"], coach_env["players"][0]["id"])

        reopened = client.get(
            f"/api/competition/sessions/{lobby['id']}", headers=coach_env["headers"]
        ).get_json()
        assert reopened["join_code"] == lobby["join_code"]
        assert len(reopened["participants"]) == 1


# ---------------------------------------------------------------------------
# Host controls
# ---------------------------------------------------------------------------


class TestHostControls:
    def test_the_host_sees_who_has_not_arrived(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )

        view = client.get(
            f"/api/competition/sessions/{lobby['id']}", headers=coach_env["headers"]
        ).get_json()
        assert view["eligible_count"] == 3
        assert len(view["not_joined"]) == 2

    def test_removing_a_participant_frees_the_identity(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        player_id = coach_env["players"][0]["id"]
        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": player_id}
        ).get_json()

        after = client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=coach_env["headers"],
        ).get_json()

        assert after["participants"] == []
        roster = client.get(f"/api/competition/{lobby['join_code']}").get_json()["roster"]
        assert next(e for e in roster if e["player_id"] == player_id)["taken"] is False

    def test_removal_bumps_the_version(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()
        before = client.get(
            f"/api/competition/{lobby['join_code']}/state"
        ).get_json()["version"]

        client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=coach_env["headers"],
        )

        after = client.get(f"/api/competition/{lobby['join_code']}/state").get_json()["version"]
        assert after > before

    def test_an_unstarted_lobby_ends_as_abandoned_not_complete(self, client, coach_env):
        """Calling an event that never happened "complete" would misreport it
        for as long as the record exists."""
        lobby = _open_lobby(client, coach_env)

        ended = client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        ).get_json()
        assert ended["status"] == ABANDONED

    def test_ending_is_idempotent(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        first = client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        )
        second = client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        )
        assert first.status_code == 200 and second.status_code == 200

    def test_an_ended_session_is_gone_from_the_player_view(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        )

        response = client.get(f"/api/competition/{lobby['join_code']}")
        assert response.status_code == 410

    def test_expiry_sweeps_a_forgotten_lobby(self, client, coach_env):
        from datetime import datetime, timedelta, timezone

        from app.services.competition import expire_stale_sessions

        lobby = _open_lobby(client, coach_env)
        session = db.session.get(CompetitionSession, lobby["id"])
        session.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.session.commit()

        assert expire_stale_sessions() == 1
        assert db.session.get(CompetitionSession, lobby["id"]).status == ABANDONED


# ---------------------------------------------------------------------------
# The poll - the one endpoint that runs thirty times a second
# ---------------------------------------------------------------------------


class TestPolling:
    def test_the_payload_is_only_what_a_client_needs_to_decide_to_refetch(
        self, client, coach_env
    ):
        code = _open_lobby(client, coach_env)["join_code"]
        body = client.get(f"/api/competition/{code}/state").get_json()

        assert set(body) == {
            "version",
            "status",
            "server_now",
            "current_round",
            # M2.1 widened this from five keys to twelve. Every addition is a
            # SCALAR, TIMESTAMP OR BOOLEAN - the rule that matters is not the
            # size of the payload but that nothing identifying anyone, and no
            # question content, ever rides the 1 Hz path.
            "question_opened_at",
            "question_closes_at",
            "participant_count",
            "answered_count",
            "all_in",
            "answering_open",
            "total_rounds",
            "podium_step",
        }
        # If any of these ever appear here, someone has moved heavy work onto
        # the one-second path.
        for expensive in ("participants", "roster", "leaderboard", "question", "quiz_title"):
            assert expensive not in body

    def test_the_poll_issues_one_query(self, client, coach_env):
        """THE load-test invariant, asserted rather than eyeballed.

        Thirty phones at 1 Hz is only sustainable if this stays a single
        indexed row read. A join added here would multiply straight through
        the whole room.
        """
        from sqlalchemy import event

        code = _open_lobby(client, coach_env)["join_code"]
        for player in coach_env["players"]:
            client.post(f"/api/competition/{code}/join", json={"player_id": player["id"]})

        statements = []

        def record(conn, cursor, statement, params, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(db.engine, "before_cursor_execute", record)
        try:
            assert client.get(f"/api/competition/{code}/state").status_code == 200
        finally:
            event.remove(db.engine, "before_cursor_execute", record)

        assert len(statements) == 1, statements
        # participant_count is a correlated subquery INSIDE this statement, so
        # the table is referenced - but there is still only one round trip and
        # the participant collection is never loaded.
        assert statements[0].count("SELECT") >= 2, "the count should be inlined"
        assert "joined_at" not in statements[0], "participant rows must not be selected"

    def test_the_poll_reports_the_participant_count(self, client, coach_env):
        """The whole reason the field exists: a waiting room can show how many
        people are in the room without fetching the room."""
        code = _open_lobby(client, coach_env)["join_code"]
        assert client.get(f"/api/competition/{code}/state").get_json()["participant_count"] == 0

        for expected, player in enumerate(coach_env["players"], start=1):
            client.post(f"/api/competition/{code}/join", json={"player_id": player["id"]})
            body = client.get(f"/api/competition/{code}/state").get_json()
            assert body["participant_count"] == expected

    def test_the_count_falls_when_a_participant_is_removed(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        code = lobby["join_code"]
        joined = client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()
        client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][1]["id"]},
        )
        assert client.get(f"/api/competition/{code}/state").get_json()["participant_count"] == 2

        client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=coach_env["headers"],
        )

        assert client.get(f"/api/competition/{code}/state").get_json()["participant_count"] == 1

    def test_a_count_change_always_arrives_with_a_version_change(self, client, coach_env):
        """Clients act on `version`. A count that moved without it would be a
        number nobody refetched heavier state for."""
        code = _open_lobby(client, coach_env)["join_code"]
        before = client.get(f"/api/competition/{code}/state").get_json()

        client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )

        after = client.get(f"/api/competition/{code}/state").get_json()
        assert after["participant_count"] != before["participant_count"]
        assert after["version"] > before["version"]

    def test_the_count_leaks_no_identity(self, client, coach_env):
        """THE constraint on this field. It is a number, not a roster.

        The poll is public to anyone holding the join code, so a name or an id
        here would publish the room's membership to every client that can read
        the code off a projector.
        """
        code = _open_lobby(client, coach_env)["join_code"]
        joined = client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()

        raw = client.get(f"/api/competition/{code}/state").get_data(as_text=True)

        assert '"participant_count": 1' in raw.replace("'", '"') or '"participant_count":1' in raw
        for leak in (
            "Ada Lovelace",
            joined["reconnect_token"],
            str(coach_env["players"][0]["id"]),
            "display_name",
            "player_id",
            "roster",
        ):
            assert leak not in raw, f"the poll leaked {leak!r}"

    def test_the_poll_writes_nothing(self, client, coach_env):
        """A 1 Hz endpoint that writes is a 1 Hz endpoint that takes row locks.

        last_seen_at is deliberately NOT touched here - it is updated on join
        and on reconnect, which are rare and deliberate. Updating it every
        second would turn thirty phones into thirty writes per second against
        one table, for a column nothing in M1 reads.
        """
        from sqlalchemy import event

        code = _open_lobby(client, coach_env)["join_code"]
        client.post(
            f"/api/competition/{code}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )

        writes = []

        def record(conn, cursor, statement, params, context, executemany):
            if statement.lstrip().upper().startswith(("UPDATE", "INSERT", "DELETE")):
                writes.append(statement)

        event.listen(db.engine, "before_cursor_execute", record)
        try:
            for _ in range(5):
                assert client.get(f"/api/competition/{code}/state").status_code == 200
        finally:
            event.remove(db.engine, "before_cursor_execute", record)

        assert writes == [], writes

    def test_the_poll_is_not_rate_limited(self, client, coach_env):
        """A team shares one Wi-Fi NAT. An IP-keyed limit here would lock a
        room out of its own competition."""
        code = _open_lobby(client, coach_env)["join_code"]
        for _ in range(120):
            assert client.get(f"/api/competition/{code}/state").status_code == 200

    def test_server_now_is_present_so_clients_never_trust_their_own_clock(
        self, client, coach_env
    ):
        code = _open_lobby(client, coach_env)["join_code"]
        assert client.get(f"/api/competition/{code}/state").get_json()["server_now"]


# ---------------------------------------------------------------------------
# TENANCY
# ---------------------------------------------------------------------------


class TestTenancy:
    @pytest.fixture
    def rival(self, client, register_coach):
        _, _, headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        return headers

    def test_another_organization_cannot_read_the_host_view(self, client, coach_env, rival):
        lobby = _open_lobby(client, coach_env)
        response = client.get(f"/api/competition/sessions/{lobby['id']}", headers=rival)
        # 404, not 403: a 403 would confirm the session exists.
        assert response.status_code == 404

    def test_another_organization_cannot_end_the_session(self, client, coach_env, rival):
        lobby = _open_lobby(client, coach_env)
        assert client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=rival
        ).status_code == 404
        assert db.session.get(CompetitionSession, lobby["id"]).status == LOBBY

    def test_another_organization_cannot_remove_a_participant(self, client, coach_env, rival):
        lobby = _open_lobby(client, coach_env)
        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()

        response = client.delete(
            f"/api/competition/sessions/{lobby['id']}/participants/"
            f"{joined['participant']['id']}",
            headers=rival,
        )
        assert response.status_code == 404
        assert CompetitionParticipant.query.count() == 1

    def test_another_organization_cannot_launch_from_a_foreign_quiz(
        self, client, coach_env, rival
    ):
        response = client.post(
            f"/api/competition/quizzes/{coach_env['quiz_id']}", json={}, headers=rival
        )
        assert response.status_code == 404
        assert CompetitionSession.query.count() == 0

    def test_a_group_from_another_organization_is_refused(self, client, coach_env, rival):
        foreign = client.post(
            "/api/groups", json={"name": "Theirs"}, headers=rival
        ).get_json()

        response = client.post(
            f"/api/competition/quizzes/{coach_env['quiz_id']}",
            json={"group_ids": [foreign["id"]]},
            headers=coach_env["headers"],
        )
        assert response.status_code == 404

    def test_by_code_lookup_is_scoped_to_the_organization(self, client, coach_env, rival):
        """The coach-reconnect lookup must not become a back door.

        It takes the PUBLIC join code, so if it skipped the ownership check any
        coach who could read a projector could control someone else's room.
        """
        lobby = _open_lobby(client, coach_env)

        mine = client.get(
            f"/api/competition/sessions/by-code/{lobby['join_code']}",
            headers=coach_env["headers"],
        )
        theirs = client.get(
            f"/api/competition/sessions/by-code/{lobby['join_code']}", headers=rival
        )

        assert mine.status_code == 200
        assert mine.get_json()["id"] == lobby["id"]
        assert theirs.status_code == 404

    def test_by_code_lookup_requires_authentication(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        assert client.get(
            f"/api/competition/sessions/by-code/{lobby['join_code']}"
        ).status_code == 401

    def test_by_code_lookup_leaks_no_token(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()

        body = client.get(
            f"/api/competition/sessions/by-code/{lobby['join_code']}",
            headers=coach_env["headers"],
        ).get_data(as_text=True)

        assert joined["reconnect_token"] not in body
        assert "reconnect_token" not in body

    def test_coach_routes_require_authentication(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        for method, path in (
            ("get", f"/api/competition/sessions/{lobby['id']}"),
            ("post", f"/api/competition/sessions/{lobby['id']}/end"),
            ("post", f"/api/competition/quizzes/{coach_env['quiz_id']}"),
        ):
            assert getattr(client, method)(path).status_code == 401


# ---------------------------------------------------------------------------
# Coach recovery
# ---------------------------------------------------------------------------


class TestCoachRecovery:
    """Walking back into a live room without knowing the code.

    A coach closes the tab in front of a room. Everything they need to get
    back has to come from the server, because the browser has nothing.
    """

    @pytest.fixture
    def rival(self, client, register_coach):
        _, _, headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        return headers

    def test_a_live_competition_is_discoverable(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        )

        body = client.get("/api/competition/active", headers=coach_env["headers"]).get_json()

        assert len(body) == 1
        # Exactly what a "return to competition" banner renders, and no more.
        assert body[0]["join_code"] == lobby["join_code"]
        assert body[0]["quiz_title"] == "Coverages"
        assert body[0]["participant_count"] == 1

    def test_discovery_survives_a_new_browser(self, client, coach_env):
        """No storage involved anywhere - a fresh client with only the JWT."""
        lobby = _open_lobby(client, coach_env)

        body = client.get("/api/competition/active", headers=coach_env["headers"]).get_json()

        assert [entry["join_code"] for entry in body] == [lobby["join_code"]]

    def test_an_ended_competition_is_not_active(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        client.post(
            f"/api/competition/sessions/{lobby['id']}/end", headers=coach_env["headers"]
        )

        assert client.get(
            "/api/competition/active", headers=coach_env["headers"]
        ).get_json() == []

    def test_an_expired_competition_is_not_active(self, client, coach_env):
        from datetime import datetime, timedelta, timezone

        lobby = _open_lobby(client, coach_env)
        session = db.session.get(CompetitionSession, lobby["id"])
        session.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        db.session.commit()

        # Expiry is lazy, so this must exclude by TIME rather than by status -
        # nothing has swept it yet.
        assert client.get(
            "/api/competition/active", headers=coach_env["headers"]
        ).get_json() == []

    def test_another_organization_never_appears(self, client, coach_env, rival):
        _open_lobby(client, coach_env)

        assert client.get("/api/competition/active", headers=rival).get_json() == []

    def test_discovery_requires_authentication(self, client, coach_env):
        _open_lobby(client, coach_env)
        assert client.get("/api/competition/active").status_code == 401

    def test_discovery_leaks_no_participant_identity(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join",
            json={"player_id": coach_env["players"][0]["id"]},
        ).get_json()

        raw = client.get(
            "/api/competition/active", headers=coach_env["headers"]
        ).get_data(as_text=True)

        for leak in ("Ada Lovelace", joined["reconnect_token"], "display_name", "roster"):
            assert leak not in raw

    def test_active_is_not_shadowed_by_the_public_code_route(self, client, coach_env):
        """`/competition/<join_code>` could have swallowed `/competition/active`.

        If it did, an unauthenticated request would reach the PUBLIC lobby
        handler with join_code="active" - so this asserts the authenticated
        rule wins, by checking the unauthenticated response is 401 and not the
        404 the public route produces for an unknown code.
        """
        _open_lobby(client, coach_env)

        anonymous = client.get("/api/competition/active")

        assert anonymous.status_code == 401, "the public <join_code> route shadowed /active"
        assert (anonymous.get_json() or {}).get("reason") != "invalid_code"

    def test_recovery_does_not_create_a_session(self, client, coach_env):
        _open_lobby(client, coach_env)

        for _ in range(3):
            client.get("/api/competition/active", headers=coach_env["headers"])

        assert CompetitionSession.query.count() == 1

    def test_an_admin_sees_the_organizations_live_rooms(self, client, coach_env,
                                                        register_coach):
        """Matches coach_session(): an admin may control them, so an admin may
        find them."""
        lobby = _open_lobby(client, coach_env)
        coach = db.session.execute(
            db.text("SELECT id FROM coaches WHERE email = 'coach1@example.com'")
        ).scalar()
        org = db.session.execute(
            db.text("SELECT organization_id FROM coaches WHERE id = :c"), {"c": coach}
        ).scalar()
        # A second coach in the SAME organization, promoted to admin.
        _, _, other = register_coach(
            username="assistant", email="assistant@example.com", organization="Temp"
        )
        db.session.execute(
            db.text(
                "UPDATE coaches SET organization_id = :o, role = 'ADMIN' "
                "WHERE email = 'assistant@example.com'"
            ),
            {"o": org},
        )
        db.session.commit()

        body = client.get("/api/competition/active", headers=other).get_json()

        assert [entry["join_code"] for entry in body] == [lobby["join_code"]]


# ---------------------------------------------------------------------------
# ANALYTICS ISOLATION - the promise the architecture was chosen for
# ---------------------------------------------------------------------------


class TestAnalyticsIsolation:
    """A competition must not touch a single official number.

    Checked against the REAL surfaces a coach reads - the quiz results feed,
    the grading queue, the player profile - rather than by asserting a table
    is empty. "The rows are not there" is only a guarantee if the endpoints
    that would have shown them agree.
    """

    @pytest.fixture
    def played(self, client, coach_env):
        lobby = _open_lobby(client, coach_env)
        for player in coach_env["players"]:
            client.post(
                f"/api/competition/{lobby['join_code']}/join",
                json={"player_id": player["id"]},
            )
        return lobby

    def test_no_player_attempt_is_created(self, client, coach_env, played):
        assert PlayerAttempt.query.count() == 0

    def test_the_responses_feed_is_untouched(self, client, coach_env, played):
        """The coach's Results tab."""
        response = client.get(
            f"/api/quizzes/{coach_env['quiz_id']}/responses", headers=coach_env["headers"]
        )
        assert response.status_code == 200
        body = response.get_json()
        items = body.get("responses", body) if isinstance(body, dict) else body
        assert len(items) == 0

    def test_the_quiz_dashboard_reports_no_activity(self, client, coach_env, played):
        """The averages a coach reads to judge the team.

        Three players joined a competition. If any of that leaked, this is
        where a fabricated average would appear.
        """
        response = client.get(
            f"/api/quizzes/{coach_env['quiz_id']}/dashboard", headers=coach_env["headers"]
        )
        assert response.status_code == 200
        body = response.get_json()
        for key, value in body.items():
            if isinstance(value, (int, float)) and any(
                token in key for token in ("count", "total", "attempt", "player", "average")
            ):
                assert value in (0, None), f"{key} was populated by a competition: {value}"

    def test_the_player_history_shows_no_activity(self, client, coach_env, played):
        """The Player Profile - the surface most likely to be polluted, since
        a competition participant IS a canonical player."""
        player_id = coach_env["players"][0]["id"]
        response = client.get(
            f"/api/players/{player_id}/history", headers=coach_env["headers"]
        )
        assert response.status_code == 200
        body = response.get_json()
        summary = body.get("summary", body)
        # Every count still zero, and no score invented from a competition.
        assert summary["assigned_count"] == 0
        assert summary["completed_count"] == 0
        assert summary["average_score_percent"] is None
        assert len(body.get("attempts", [])) == 0

    def test_every_players_history_stays_empty(self, client, coach_env, played):
        """All three joined. None of them may have acquired a record."""
        for player in coach_env["players"]:
            body = client.get(
                f"/api/players/{player['id']}/history", headers=coach_env["headers"]
            ).get_json()
            summary = body.get("summary", body)
            assert summary["assigned_count"] == 0
            assert summary["average_score_percent"] is None

    def test_the_csv_export_contains_no_competition_row(self, client, coach_env, played):
        """The artifact a coach hands to someone else. If a competition ever
        reached a real export, it would be indistinguishable from a graded
        result to whoever received it."""
        response = client.get(
            f"/api/quizzes/{coach_env['quiz_id']}/export.csv", headers=coach_env["headers"]
        )
        assert response.status_code == 200
        text = response.get_data(as_text=True)
        for player in coach_env["players"]:
            assert player["full_name"] not in text

    def test_a_competition_writes_only_to_competition_tables(self, client, coach_env, played):
        """The structural claim, stated once and directly."""
        from app.models import Answer

        assert PlayerAttempt.query.count() == 0
        assert Answer.query.count() == 0
        assert CompetitionParticipant.query.count() == 3
