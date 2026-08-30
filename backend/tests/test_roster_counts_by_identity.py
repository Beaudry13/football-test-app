"""A roster counts PEOPLE, not unique display names.

Two different canonical players may legitimately be called the same thing -
Peira has never forbidden it, and a squad with two Chris Williams is ordinary.
But the coach-facing roster counts were derived from a list of display names,
and a list of strings cannot hold two people with one name. So a group of five
reported four, every rate divided by that short denominator came out too high,
and one of the two starting removed BOTH from "hasn't started yet".

Renaming had the mirror problem: those names came from the snapshot taken when
somebody was added to a group, so a renamed player kept their old name on the
coach's current roster forever.

Identity is player_id. Names are display data. A free-text roster entry has no
canonical identity and still falls back to its normalised name - that is the
existing legacy behaviour, preserved deliberately rather than guessed away.
"""

import pytest


@pytest.fixture
def quiz_with_question(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Install Week 4"}, headers=coach_headers
    ).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Cover 3 responsibility?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )
    return quiz


def make_player(client, headers, first, last):
    return client.post(
        "/api/players", json={"first_name": first, "last_name": last}, headers=headers
    ).get_json()


def make_group(client, headers, name, player_ids):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    if player_ids:
        client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": player_ids},
            headers=headers,
        )
    return group


def activate(client, headers, quiz_id, group_ids):
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes",
        json={"group_ids": group_ids},
        headers=headers,
    ).get_json()


def start(client, code_id, name, player_id=None):
    body = {"access_code_id": code_id, "player_name": name}
    if player_id is not None:
        body["player_id"] = player_id
    return client.post("/api/play/start", json=body)


def submit(client, code_id, name, question_id, player_id=None):
    body = {
        "access_code_id": code_id,
        "player_name": name,
        "answers": [{"question_id": question_id, "answer_text": "True"}],
    }
    if player_id is not None:
        body["player_id"] = player_id
    return client.post("/api/play/submit", json=body)


def dashboard(client, headers, quiz_id):
    return client.get(f"/api/quizzes/{quiz_id}/dashboard", headers=headers).get_json()


def quiz_card(client, headers, quiz_id):
    quizzes = client.get("/api/quizzes", headers=headers).get_json()
    return next(q for q in quizzes if q["id"] == quiz_id)


def active_rail(client, headers, quiz_id):
    """The dashboard's live status board - GET /api/quizzes/active-status."""
    body = client.get("/api/quizzes/active-status", headers=headers).get_json()
    rows = body if isinstance(body, list) else body.get("active", body.get("quizzes", []))
    return next((r for r in rows if r["quiz_id"] == quiz_id), None)


class TestRosterSizeCountsPeople:
    def test_five_uniquely_named_players_count_five(
        self, client, coach_headers, quiz_with_question
    ):
        ids = [
            make_player(client, coach_headers, f"P{i}", f"Last{i}")["id"] for i in range(5)
        ]
        group = make_group(client, coach_headers, "Safeties", ids)
        activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        assert dashboard(client, coach_headers, quiz_with_question["id"])["roster_size"] == 5

    def test_five_players_two_sharing_a_name_still_count_five(
        self, client, coach_headers, quiz_with_question
    ):
        # THE DEFECT. Counting names returned 4.
        ids = [
            make_player(client, coach_headers, "Dup", "Twin")["id"],
            make_player(client, coach_headers, "Dup", "Twin")["id"],
            make_player(client, coach_headers, "Alpha", "One")["id"],
            make_player(client, coach_headers, "Bravo", "Two")["id"],
            make_player(client, coach_headers, "Charlie", "Three")["id"],
        ]
        group = make_group(client, coach_headers, "Safeties", ids)
        activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        assert dashboard(client, coach_headers, quiz_with_question["id"])["roster_size"] == 5

    def test_the_quiz_card_counts_the_same_five(
        self, client, coach_headers, quiz_with_question
    ):
        ids = [
            make_player(client, coach_headers, "Dup", "Twin")["id"],
            make_player(client, coach_headers, "Dup", "Twin")["id"],
            make_player(client, coach_headers, "Alpha", "One")["id"],
        ]
        group = make_group(client, coach_headers, "Safeties", ids)
        activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        assert quiz_card(client, coach_headers, quiz_with_question["id"])["roster_size"] == 3

    def test_a_player_in_two_linked_groups_is_counted_once(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Evan", "Both")
        a = make_group(client, coach_headers, "Safeties", [player["id"]])
        b = make_group(client, coach_headers, "Special Teams", [player["id"]])
        activate(client, coach_headers, quiz_with_question["id"], [a["id"], b["id"]])

        assert dashboard(client, coach_headers, quiz_with_question["id"])["roster_size"] == 1


class TestResponseRate:
    def test_three_of_five_is_sixty_percent_not_seventy_five(
        self, client, coach_headers, quiz_with_question
    ):
        """The correction, stated as arithmetic.

        Five assigned, two sharing a name, three submit. The old denominator
        was the four unique names, reporting 75%. The truth is 3/5 = 60%.
        """
        quiz_id = quiz_with_question["id"]
        question_id = client.get(
            f"/api/quizzes/{quiz_id}", headers=coach_headers
        ).get_json()["questions"][0]["id"]
        people = [
            make_player(client, coach_headers, "Dup", "Twin"),
            make_player(client, coach_headers, "Dup", "Twin"),
            make_player(client, coach_headers, "Alpha", "One"),
            make_player(client, coach_headers, "Bravo", "Two"),
            make_player(client, coach_headers, "Charlie", "Three"),
        ]
        group = make_group(client, coach_headers, "Safeties", [p["id"] for p in people])
        code = activate(client, coach_headers, quiz_id, [group["id"]])

        for p in people[:3]:
            name = f"{p['first_name']} {p['last_name']}"
            start(client, code["id"], name, p["id"])
            submit(client, code["id"], name, question_id, p["id"])

        body = dashboard(client, coach_headers, quiz_id)
        assert body["roster_size"] == 5
        assert body["response_count"] == 3
        assert body["response_rate"] == pytest.approx(0.6), "3/5, not 3/4"


class TestWhoIsOutstanding:
    """Two players share a name. Who is still owed a quiz?"""

    def _two_twins_and_a_code(self, client, coach_headers, quiz_id):
        one = make_player(client, coach_headers, "Dup", "Twin")
        two = make_player(client, coach_headers, "Dup", "Twin")
        group = make_group(client, coach_headers, "Safeties", [one["id"], two["id"]])
        code = activate(client, coach_headers, quiz_id, [group["id"]])
        return one, two, code

    def test_neither_started_leaves_two_outstanding(
        self, client, coach_headers, quiz_with_question
    ):
        self._two_twins_and_a_code(client, coach_headers, quiz_with_question["id"])

        row = active_rail(client, coach_headers, quiz_with_question["id"])
        assert len(row["not_started"]) == 2

    def test_one_started_leaves_exactly_one_outstanding(
        self, client, coach_headers, quiz_with_question
    ):
        # THE DEFECT. Comparing names removed BOTH the moment either started,
        # so the coach chasing the one who had not started saw nobody.
        one, _two, code = self._two_twins_and_a_code(
            client, coach_headers, quiz_with_question["id"]
        )
        start(client, code["id"], "Dup Twin", one["id"])

        row = active_rail(client, coach_headers, quiz_with_question["id"])
        assert len(row["not_started"]) == 1
        assert row["not_started"] == ["Dup Twin"]

    def test_both_started_leaves_nobody_outstanding(
        self, client, coach_headers, quiz_with_question
    ):
        one, two, code = self._two_twins_and_a_code(
            client, coach_headers, quiz_with_question["id"]
        )
        start(client, code["id"], "Dup Twin", one["id"])
        start(client, code["id"], "Dup Twin", two["id"])

        row = active_rail(client, coach_headers, quiz_with_question["id"])
        assert row["not_started"] == []

    def test_results_missing_players_counts_the_same_way(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id = quiz_with_question["id"]
        question_id = client.get(
            f"/api/quizzes/{quiz_id}", headers=coach_headers
        ).get_json()["questions"][0]["id"]
        one, _two, code = self._two_twins_and_a_code(client, coach_headers, quiz_id)
        start(client, code["id"], "Dup Twin", one["id"])
        submit(client, code["id"], "Dup Twin", question_id, one["id"])

        body = dashboard(client, coach_headers, quiz_id)
        assert body["roster_size"] == 2
        assert len(body["missing_players"]) == 1, "one twin still owes it"


class TestRename:
    def test_the_current_roster_shows_the_current_name(
        self, client, coach_headers, quiz_with_question
    ):
        # The group snapshot keeps what the coach typed when they added
        # somebody. Operational roster information must not.
        player = make_player(client, coach_headers, "AudF", "Foxtrot")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        client.patch(
            f"/api/players/{player['id']}",
            json={"first_name": "AudFF", "last_name": "Renamed"},
            headers=coach_headers,
        )

        body = dashboard(client, coach_headers, quiz_with_question["id"])
        assert body["missing_players"] == ["AudFF Renamed"]
        assert body["roster_size"] == 1, "a rename moves nobody in or out"

    def test_a_submitted_attempt_keeps_the_name_it_was_taken_under(
        self, client, coach_headers, quiz_with_question
    ):
        # Historical evidence is a snapshot on purpose. Renaming a player must
        # not rewrite what a past attempt recorded.
        quiz_id = quiz_with_question["id"]
        question_id = client.get(
            f"/api/quizzes/{quiz_id}", headers=coach_headers
        ).get_json()["questions"][0]["id"]
        player = make_player(client, coach_headers, "Before", "Rename")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_id, [group["id"]])
        start(client, code["id"], "Before Rename", player["id"])
        submit(client, code["id"], "Before Rename", question_id, player["id"])

        client.patch(
            f"/api/players/{player['id']}",
            json={"first_name": "After", "last_name": "Rename"},
            headers=coach_headers,
        )

        responses = client.get(
            f"/api/quizzes/{quiz_id}/responses", headers=coach_headers
        ).get_json()
        assert responses[0]["player_name"] == "Before Rename", "snapshot untouched"


class TestLegacyEntriesAreUnchanged:
    def test_a_free_text_roster_member_still_counts(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id = quiz_with_question["id"]
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": ["Legacy Larry", "Legacy Lucy"]},
            headers=coach_headers,
        )
        activate(client, coach_headers, quiz_id, [])

        body = dashboard(client, coach_headers, quiz_id)
        assert body["roster_size"] == 2
        assert sorted(body["missing_players"]) == ["Legacy Larry", "Legacy Lucy"]

    def test_a_free_text_member_does_not_acquire_a_player_id(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id = quiz_with_question["id"]
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": ["Legacy Larry"]},
            headers=coach_headers,
        )
        code = activate(client, coach_headers, quiz_id, [])
        start(client, code["id"], "Legacy Larry")

        responses = client.get(
            f"/api/quizzes/{quiz_id}/responses", headers=coach_headers
        ).get_json()
        # Still legacy. Nothing about counting people invents an identity for
        # somebody the coach only ever typed as a string.
        assert responses == [] or all(r.get("player_id") is None for r in responses)
