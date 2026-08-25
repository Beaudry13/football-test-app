"""ONE HUMAN COUNTS ONCE.

Attempt uniqueness is scoped to an ACCESS CODE, and a quiz can hold several,
so "one attempt per player per quiz" was never true. Every analysis that keyed
on `attempt.id` therefore counted a player who took the same quiz twice as two
people: two names in "Who missed it", two answers in every denominator.

These tests pin the identity rule itself rather than any one surface, because
the same rule now decides who is listed, who is counted, who can be targeted
and who is compared across rounds.
"""
from datetime import datetime, timedelta, timezone

from app.services.player_identity import PlayerKey, representative_attempts
from tests.test_canonical_play_flow import make_player
from tests.test_play_and_grading import build_ready_quiz


class FakeAttempt:
    """Enough of a PlayerAttempt to exercise the ordering rule directly."""

    def __init__(self, id, submitted_at, player_id=7, player_name="Jalen"):
        self.id = id
        self.submitted_at = submitted_at
        self.player_id = player_id
        self.player_name = player_name


def _concept(client, h, name="Force / Contain"):
    return client.post("/api/concepts", json={"name": name}, headers=h).get_json()


def _tagged_quiz(client, h):
    quiz, tf, written, code = build_ready_quiz(client, h)
    concept = _concept(client, h)
    client.patch(
        f"/api/quizzes/{quiz['id']}/questions/{tf['id']}",
        json={"concept_id": concept["id"]},
        headers=h,
    )
    return quiz, tf, concept, code


def _group_code(client, h, quiz_id, player_ids, name="D"):
    group = client.post("/api/groups", json={"name": name}, headers=h).get_json()
    client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": player_ids},
        headers=h,
    )
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=h,
    ).get_json()


def _answer(client, code_id, name, player_id, question, correct):
    option = next(o["id"] for o in question["options"] if o["is_correct_answer"] is correct)
    body = {"access_code_id": code_id, "player_name": name}
    if player_id is not None:
        body["player_id"] = player_id
    client.post("/api/play/start", json=body)
    return client.post(
        "/api/play/submit",
        json={**body, "answers": [{"question_id": question["id"], "selected_option_id": option}]},
    )


def _row(client, h, quiz_id):
    dash = client.get(f"/api/quizzes/{quiz_id}/dashboard", headers=h).get_json()
    return dash["concept_breakdown"][0]


CANONICAL_7 = PlayerKey(player_id=7, legacy_name=None)


class TestTheKeyItself:
    """A canonical key and a legacy key never compare equal, whatever the
    strings say. Merging "the Player row called Jalen Reed" with "the words
    Jalen Reed typed into a phone" is a guess about a human being."""

    def test_a_legacy_name_never_equals_a_canonical_player(self):
        assert CANONICAL_7 != PlayerKey(player_id=None, legacy_name="jalen reed")

    def test_two_canonical_players_are_distinct_however_they_are_named(self):
        assert CANONICAL_7 != PlayerKey(player_id=8, legacy_name=None)

    def test_a_legacy_name_is_casefolded_so_capitalisation_is_not_identity(self):
        attempt = FakeAttempt(1, None, player_id=None, player_name="  Jalen Reed  ")
        assert PlayerKey.of(attempt) == PlayerKey(player_id=None, legacy_name="jalen reed")


class TestDeterministicSelection:
    """Which attempt speaks for a player must not depend on row order."""

    def test_the_most_recent_submission_represents_a_player(self):
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        older = FakeAttempt(1, base)
        newer = FakeAttempt(2, base + timedelta(days=1))

        for order in ([older, newer], [newer, older]):
            assert representative_attempts(order)[CANONICAL_7] is newer

    def test_ties_are_broken_by_id_rather_than_by_row_order(self):
        same = datetime(2026, 8, 1, tzinfo=timezone.utc)
        a, b = FakeAttempt(1, same), FakeAttempt(2, same)

        for order in ([a, b], [b, a]):
            assert representative_attempts(order)[CANONICAL_7].id == 2

    def test_an_unsubmitted_attempt_never_outranks_a_submitted_one(self):
        underway = FakeAttempt(9, None)
        done = FakeAttempt(1, datetime(2026, 8, 1, tzinfo=timezone.utc))

        assert representative_attempts([underway, done])[CANONICAL_7] is done


class TestSameCanonicalPlayerThroughTwoCodes:
    def test_they_are_ONE_name_and_ONE_response_in_the_analysis(self, client, coach_headers):
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        player = make_player(client, h, "Chris", "Smith", "2", "WR")

        first = _group_code(client, h, quiz["id"], [player["id"]], "D1")
        _answer(client, first["id"], "Chris Smith", player["id"], tf, correct=False)
        second = _group_code(client, h, quiz["id"], [player["id"]], "D2")
        _answer(client, second["id"], "Chris Smith", player["id"], tf, correct=False)

        row = _row(client, h, quiz["id"])

        assert row["players_missed_count"] == 1
        assert len(row["players_missed"]) == 1
        assert row["players_responded_count"] == 1
        # The answer-level counts describe the SAME population as the names.
        assert row["graded_count"] == 1
        assert row["incorrect_count"] == 1

    def test_the_LATEST_attempt_decides_whether_they_still_need_it(self, client, coach_headers):
        """Missed on Tuesday, right on Thursday: they do not need the lesson.

        The alternative - a union of everything they ever got wrong - would
        make a player permanently guilty of their worst day.
        """
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        player = make_player(client, h, "Chris", "Smith", "2", "WR")

        first = _group_code(client, h, quiz["id"], [player["id"]], "D1")
        _answer(client, first["id"], "Chris Smith", player["id"], tf, correct=False)
        second = _group_code(client, h, quiz["id"], [player["id"]], "D2")
        _answer(client, second["id"], "Chris Smith", player["id"], tf, correct=True)

        row = _row(client, h, quiz["id"])

        assert row["players_missed_count"] == 0
        assert row["players_responded_count"] == 1

    def test_a_retest_targets_them_once(self, client, coach_headers):
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        player = make_player(client, h, "Chris", "Smith", "2", "WR")

        for label in ("D1", "D2"):
            code = _group_code(client, h, quiz["id"], [player["id"]], label)
            _answer(client, code["id"], "Chris Smith", player["id"], tf, correct=False)

        created = client.post(
            f"/api/quizzes/{quiz['id']}/retests",
            json={"concept_id": concept["id"], "player_ids": [player["id"]]},
            headers=h,
        )
        assert created.status_code == 201

        roster = client.get(
            f"/api/quizzes/{created.get_json()['id']}/roster", headers=h
        ).get_json()
        assert len(roster["players"]) == 1
        assert roster["players"][0]["player_name"] == "Chris Smith"


class TestTwoPlayersSharingADisplayName:
    def test_they_stay_two_people(self, client, coach_headers):
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        wr = make_player(client, h, "Chris", "Smith", "2", "WR")
        lb = make_player(client, h, "Chris", "Smith", "42", "LB")

        code = _group_code(client, h, quiz["id"], [wr["id"], lb["id"]])
        _answer(client, code["id"], "Chris Smith", wr["id"], tf, correct=False)
        _answer(client, code["id"], "Chris Smith", lb["id"], tf, correct=False)

        row = _row(client, h, quiz["id"])

        assert row["players_missed_count"] == 2
        assert {p["player_id"] for p in row["players_missed"]} == {wr["id"], lb["id"]}

    def test_a_retest_can_target_exactly_one_of_them(self, client, coach_headers):
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        wr = make_player(client, h, "Chris", "Smith", "2", "WR")
        lb = make_player(client, h, "Chris", "Smith", "42", "LB")

        code = _group_code(client, h, quiz["id"], [wr["id"], lb["id"]])
        _answer(client, code["id"], "Chris Smith", wr["id"], tf, correct=False)
        _answer(client, code["id"], "Chris Smith", lb["id"], tf, correct=False)

        created = client.post(
            f"/api/quizzes/{quiz['id']}/retests",
            json={"concept_id": concept["id"], "player_ids": [lb["id"]]},
            headers=h,
        )
        roster = client.get(
            f"/api/quizzes/{created.get_json()['id']}/roster", headers=h
        ).get_json()

        assert len(roster["players"]) == 1
        assert roster["players"][0]["player"]["id"] == lb["id"]


class TestLegacyNameMatchingACanonicalPlayer:
    def test_a_free_text_join_is_not_merged_into_the_canonical_player(
        self, client, coach_headers
    ):
        """Same string, two rows, and Peira does not decide they are one person."""
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        canonical = make_player(client, h, "Chris", "Smith", "2", "WR")

        group_code = _group_code(client, h, quiz["id"], [canonical["id"]])
        _answer(client, group_code["id"], "Chris Smith", canonical["id"], tf, correct=False)

        # A SECOND activation with no groups, so eligibility falls back to the
        # quiz roster and the same name can join as free text. Minted after the
        # roster is set: a code carries the eligibility it was activated with.
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": ["Chris Smith"]},
            headers=h,
        )
        roster_code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", headers=h
        ).get_json()
        joined = _answer(client, roster_code["id"], "Chris Smith", None, tf, correct=False)
        assert joined.status_code == 201

        row = _row(client, h, quiz["id"])

        assert row["players_missed_count"] == 2
        ids = sorted(
            (p["player_id"] for p in row["players_missed"]),
            key=lambda v: (v is not None, v),
        )
        assert ids == [None, canonical["id"]]

    def test_a_canonical_player_cannot_be_targeted_by_typing_their_name(
        self, client, coach_headers
    ):
        h = coach_headers
        quiz, tf, concept, _ = _tagged_quiz(client, h)
        canonical = make_player(client, h, "Chris", "Smith", "2", "WR")
        code = _group_code(client, h, quiz["id"], [canonical["id"]])
        _answer(client, code["id"], "Chris Smith", canonical["id"], tf, correct=False)

        refused = client.post(
            f"/api/quizzes/{quiz['id']}/retests",
            json={"concept_id": concept["id"], "player_names": ["Chris Smith"]},
            headers=h,
        )

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "player_not_eligible"
