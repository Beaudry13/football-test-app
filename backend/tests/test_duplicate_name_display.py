"""Two players may share a name. Every screen must still let a person tell
them apart - and nothing may start treating the label as the person.

PLAYER IDENTITY IS player_id. Jersey number and position are DISPLAY data that
ride alongside it so a coach (or a player choosing a Competition seat) can see
which John Smith a row is. These tests pin both halves: the display metadata
now reaches each surface, and every operation still keys on player_id.

WHAT IS DELIBERATELY NOT HERE: jersey or position on the Competition
leaderboard, podium or participant list. Those read `display_name` as
SNAPSHOTTED AT JOIN, so that a finished competition keeps reading the way it
did in the room. Deriving live roster metadata for them would let an edit made
next week change what last week's podium says, and the last class below exists
to make sure nobody does that by accident.
"""

import csv
import io

import pytest

from app.extensions import db
from app.models import CompetitionParticipant, CompetitionSession, Player
from app.services import competition_podium, competition_standings
from tests.test_play_and_grading import build_ready_quiz, start_and_submit

PREVIOUS_CSV_HEADER = [
    "Player",
    "Submitted At",
    "Question #",
    "Question",
    "Type",
    "Playbook",
    "Answer",
    "Correct",
    "Coach Feedback",
]


def make_player(client, headers, first, last, jersey=None, position=None):
    response = client.post(
        "/api/players",
        json={
            "first_name": first,
            "last_name": last,
            "jersey_number": jersey,
            "position": position,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


@pytest.fixture
def tf_quiz(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
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
        headers=coach_headers,
    ).get_json()
    return quiz, question


@pytest.fixture
def two_smiths(client, coach_headers):
    qb = make_player(client, coach_headers, "John", "Smith", "12", "QB")
    lb = make_player(client, coach_headers, "John", "Smith", "37", "LB")
    return qb, lb


def activate_for(client, headers, quiz_id, player_ids):
    group = client.post("/api/groups", json={"name": "Squad"}, headers=headers).get_json()
    client.post(
        f"/api/groups/{group['id']}/members", json={"player_ids": player_ids}, headers=headers
    )
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={"group_ids": [group["id"]]}, headers=headers
    ).get_json()


def start(client, code_id, player_id):
    return client.post(
        "/api/play/start",
        json={"access_code_id": code_id, "player_name": "John Smith", "player_id": player_id},
    )


def submit(client, code_id, player_id, question_id, option_id):
    start(client, code_id, player_id)
    response = client.post(
        "/api/play/submit",
        json={
            "access_code_id": code_id,
            "player_name": "John Smith",
            "player_id": player_id,
            "answers": [{"question_id": question_id, "selected_option_id": option_id}],
        },
    )
    assert response.status_code == 201, response.get_json()


def wrong_option(question):
    return next(o["id"] for o in question["options"] if not o["is_correct_answer"])


# ---------------------------------------------------------------------------
# Competition join picker - the highest-priority surface
# ---------------------------------------------------------------------------


class TestCompetitionJoinPicker:
    def _lobby(self, client, headers, quiz_id):
        response = client.post(f"/api/competition/quizzes/{quiz_id}", json={}, headers=headers)
        assert response.status_code == 201, response.get_json()
        return response.get_json()

    def test_same_named_players_arrive_distinguishable(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        qb, lb = two_smiths
        lobby = self._lobby(client, coach_headers, tf_quiz[0]["id"])

        roster = client.get(f"/api/competition/{lobby['join_code']}").get_json()["roster"]
        by_id = {entry["player_id"]: entry for entry in roster}

        assert set(by_id) == {qb["id"], lb["id"]}
        assert by_id[qb["id"]]["display_name"] == by_id[lb["id"]]["display_name"] == "John Smith"
        assert (by_id[qb["id"]]["jersey_number"], by_id[qb["id"]]["position"]) == ("12", "QB")
        assert (by_id[lb["id"]]["jersey_number"], by_id[lb["id"]]["position"]) == ("37", "LB")

    def test_joining_takes_exactly_the_seat_whose_id_was_sent(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        qb, lb = two_smiths
        lobby = self._lobby(client, coach_headers, tf_quiz[0]["id"])

        joined = client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": lb["id"]}
        )
        assert joined.status_code in (200, 201), joined.get_json()
        assert joined.get_json()["participant"]["player_id"] == lb["id"]

        roster = client.get(f"/api/competition/{lobby['join_code']}").get_json()["roster"]
        taken = {entry["player_id"]: entry["taken"] for entry in roster}
        # TAKEN IS PER PERSON. The same-named QB is still free.
        assert taken == {lb["id"]: True, qb["id"]: False}

        # And the QB can still take their own seat.
        second = client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": qb["id"]}
        )
        assert second.status_code in (200, 201), second.get_json()
        assert second.get_json()["participant"]["player_id"] == qb["id"]

    def test_a_legacy_style_player_with_no_metadata_still_lists(
        self, client, coach_headers, tf_quiz
    ):
        bare = make_player(client, coach_headers, "Sam", "Rivera")
        lobby = self._lobby(client, coach_headers, tf_quiz[0]["id"])

        roster = client.get(f"/api/competition/{lobby['join_code']}").get_json()["roster"]
        entry = next(e for e in roster if e["player_id"] == bare["id"])
        assert entry["jersey_number"] is None
        assert entry["position"] is None


class TestCompetitionHistoryIsUntouched:
    """The snapshot rule, pinned. Live metadata belongs on the pre-game picker
    and nowhere a finished competition is read back from."""

    def test_participants_standings_and_podium_carry_no_live_roster_metadata(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        qb, lb = two_smiths
        lobby = client.post(
            f"/api/competition/quizzes/{tf_quiz[0]['id']}", json={}, headers=coach_headers
        ).get_json()
        for player in (qb, lb):
            client.post(
                f"/api/competition/{lobby['join_code']}/join", json={"player_id": player["id"]}
            )

        session = db.session.get(CompetitionSession, lobby["id"])
        rows = [p.to_dict() for p in session.participants]
        rows += competition_standings.standings(session)
        podium = competition_podium.podium(session)
        rows += podium["final_standings"]
        rows += [entry for place in podium["places"].values() for entry in place]

        assert rows, "precondition: there is something to inspect"
        for row in rows:
            assert "jersey_number" not in row
            assert "position" not in row

        host = client.get(
            f"/api/competition/sessions/{lobby['id']}", headers=coach_headers
        ).get_json()
        for participant in host["participants"]:
            assert "jersey_number" not in participant

    def test_display_name_is_still_the_join_time_snapshot(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        qb, _lb = two_smiths
        lobby = client.post(
            f"/api/competition/quizzes/{tf_quiz[0]['id']}", json={}, headers=coach_headers
        ).get_json()
        client.post(
            f"/api/competition/{lobby['join_code']}/join", json={"player_id": qb["id"]}
        )

        player = db.session.get(Player, qb["id"])
        player.first_name = "Johnny"
        player.jersey_number = "99"
        db.session.commit()

        participant = CompetitionParticipant.query.filter_by(player_id=qb["id"]).one()
        assert participant.display_name == "John Smith"


# ---------------------------------------------------------------------------
# Attempt surfaces: Results, grading, Teach Next, CSV
# ---------------------------------------------------------------------------


class TestAttemptPayloads:
    @pytest.fixture
    def answered(self, client, coach_headers, tf_quiz, two_smiths):
        quiz, question = tf_quiz
        qb, lb = two_smiths
        code = activate_for(client, coach_headers, quiz["id"], [qb["id"], lb["id"]])
        for player in (qb, lb):
            submit(client, code["id"], player["id"], question["id"], wrong_option(question))
        return quiz, question, qb, lb

    def test_responses_carry_jersey_per_player_id(self, client, coach_headers, answered):
        quiz, _question, qb, lb = answered
        body = client.get(f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers).get_json()

        jersey_by_id = {row["player_id"]: row["jersey_number"] for row in body}
        assert jersey_by_id == {qb["id"]: "12", lb["id"]: "37"}
        # Attempt mode: no live roster position rides along.
        for row in body:
            assert "position" not in row

    def test_teach_next_missed_players_carry_jersey(self, client, coach_headers, answered):
        quiz, question, qb, lb = answered
        concept = client.post("/api/concepts", json={"name": "Force"}, headers=coach_headers).get_json()
        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"concept_id": concept["id"]},
            headers=coach_headers,
        )

        dashboard = client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers).get_json()
        missed = dashboard["concept_breakdown"][0]["players_missed"]

        assert {p["player_id"]: p["jersey_number"] for p in missed} == {
            qb["id"]: "12",
            lb["id"]: "37",
        }
        for entry in missed:
            assert "position" not in entry

    def test_csv_appends_player_jersey_and_moves_nothing(self, client, coach_headers, answered):
        quiz, *_ = answered
        raw = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)
        rows = list(csv.reader(io.StringIO(raw.get_data(as_text=True))))

        header = rows[0]
        assert header[: len(PREVIOUS_CSV_HEADER)] == PREVIOUS_CSV_HEADER
        assert header[-1] == "Player Jersey"
        assert len(header) == len(PREVIOUS_CSV_HEADER) + 1

        # The existing Player column is unchanged - still the bare name.
        assert sorted((row[0], row[-1]) for row in rows[1:]) == [
            ("John Smith", "12"),
            ("John Smith", "37"),
        ]
        for row in rows[1:]:
            assert len(row) == len(header)


class TestLegacyAttemptsStillWork:
    def test_a_free_text_attempt_has_no_jersey_anywhere(self, client, coach_headers):
        quiz, tf_question, _written, access_code = build_ready_quiz(client, coach_headers)
        start_and_submit(
            client,
            access_code["id"],
            "Jordan Smith",
            [{"question_id": tf_question["id"], "selected_option_id": wrong_option(tf_question)}],
        )

        responses = client.get(
            f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers
        ).get_json()
        assert len(responses) == 1
        assert responses[0]["player_id"] is None
        assert responses[0]["jersey_number"] is None
        assert responses[0]["display_name"] == "Jordan Smith"

        raw = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)
        rows = list(csv.reader(io.StringIO(raw.get_data(as_text=True))))
        assert rows[1:], "precondition: the legacy attempt exported"
        for row in rows[1:]:
            assert row[0] == "Jordan Smith"
            assert row[-1] == ""


# ---------------------------------------------------------------------------
# Active status
# ---------------------------------------------------------------------------


class TestActiveStatus:
    def test_passes_identity_and_live_metadata_through(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        quiz, question = tf_quiz
        qb, lb = two_smiths
        third = make_player(client, coach_headers, "John", "Smith", None, "WR")
        code = activate_for(client, coach_headers, quiz["id"], [qb["id"], lb["id"], third["id"]])
        submit(client, code["id"], qb["id"], question["id"], wrong_option(question))
        start(client, code["id"], lb["id"])

        entry = client.get("/api/quizzes/active-status", headers=coach_headers).get_json()[0]

        assert entry["submitted"] == [
            {
                "player_name": "John Smith",
                "submitted_at": entry["submitted"][0]["submitted_at"],
                "player_id": qb["id"],
                "jersey_number": "12",
                "position": "QB",
            }
        ]
        assert entry["in_progress"][0]["player_id"] == lb["id"]
        assert (entry["in_progress"][0]["jersey_number"], entry["in_progress"][0]["position"]) == (
            "37",
            "LB",
        )
        # The existing names list is unchanged; the new list is the same people.
        assert entry["not_started"] == ["John Smith"]
        assert entry["not_started_players"] == [
            {"player_id": third["id"], "player_name": "John Smith", "jersey_number": None, "position": "WR"}
        ]

    def test_a_legacy_roster_keeps_working(self, client, coach_headers):
        _quiz, tf_question, _written, access_code = build_ready_quiz(client, coach_headers)
        start_and_submit(
            client,
            access_code["id"],
            "Jordan Smith",
            [{"question_id": tf_question["id"], "selected_option_id": wrong_option(tf_question)}],
        )

        entry = client.get("/api/quizzes/active-status", headers=coach_headers).get_json()[0]
        submitted = entry["submitted"][0]
        assert submitted["player_name"] == "Jordan Smith"
        assert submitted["player_id"] is None
        assert submitted["jersey_number"] is None
        assert entry["not_started"] == ["Alex Lee"]
        assert entry["not_started_players"] == [
            {"player_id": None, "player_name": "Alex Lee", "jersey_number": None, "position": None}
        ]


# ---------------------------------------------------------------------------
# Resume - the invariant a label must never weaken
# ---------------------------------------------------------------------------


class TestResumeStaysPerPerson:
    def test_john_smith_a_cannot_resume_john_smith_b(
        self, client, coach_headers, tf_quiz, two_smiths
    ):
        quiz, _question = tf_quiz
        qb, lb = two_smiths
        code = activate_for(client, coach_headers, quiz["id"], [qb["id"], lb["id"]])

        qb_attempt = start(client, code["id"], qb["id"]).get_json()["attempt_id"]
        lb_attempt = start(client, code["id"], lb["id"]).get_json()["attempt_id"]
        assert qb_attempt != lb_attempt

        # Coming back resumes their OWN attempt, whichever of them starts first.
        assert start(client, code["id"], lb["id"]).get_json()["attempt_id"] == lb_attempt
        assert start(client, code["id"], qb["id"]).get_json()["attempt_id"] == qb_attempt
