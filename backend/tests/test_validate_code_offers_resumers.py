"""A player who started a quiz must be able to find their own name again.

/play/start already treats an existing attempt as its own authority. But a
player who closes the tab and comes back reaches /play/validate-code first,
and that returned live eligibility only - so somebody removed from the linked
group, or since deactivated, was simply absent from the picker. They could not
select themselves, never reached /start, and the resume rule behind it was
unreachable through the actual product.

These tests fix the display set to the union the rule implies: who may BEGIN,
plus whoever already holds an attempt under this exact code.

The identity rules are the point of most of this file. Two people who share a
display name must stay two rows, a legacy attempt must not be promoted into a
canonical player by being listed, and nobody may ever be offered a name that
resumes somebody else's work.
"""

import pytest


@pytest.fixture
def quiz_with_question(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Install Week 3"}, headers=coach_headers
    ).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Who has the flat?",
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


def remove(client, headers, group_id, player_id):
    return client.delete(f"/api/groups/{group_id}/members/{player_id}", headers=headers)


def deactivate(client, headers, player_id):
    return client.post(f"/api/players/{player_id}/deactivate", headers=headers)


def picker(client, code):
    """The names a returning player is actually offered."""
    body = client.post("/api/play/validate-code", json={"code": code}).get_json()
    return body["roster_players_v2"]


def ids_in(options):
    return [o["player_id"] for o in options]


def names_in(options):
    return sorted(o["name"] for o in options)


class TestWhoIsOffered:
    def test_an_eligible_active_player_appears(self, client, coach_headers, quiz_with_question):
        player = make_player(client, coach_headers, "Mike", "Safety")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        assert names_in(picker(client, code["code"])) == ["Mike Safety"]

    def test_a_removed_player_with_no_attempt_disappears(
        self, client, coach_headers, quiz_with_question
    ):
        # Live membership still decides who may begin, and the picker must not
        # offer a start the server would refuse.
        player = make_player(client, coach_headers, "John", "Corner")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        remove(client, coach_headers, group["id"], player["id"])

        assert picker(client, code["code"]) == []

    def test_a_removed_player_who_started_is_still_offered(
        self, client, coach_headers, quiz_with_question
    ):
        # THE REGRESSION THIS FILE EXISTS FOR.
        player = make_player(client, coach_headers, "Chris", "Nickel")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        start(client, code["id"], "Chris Nickel", player["id"])

        remove(client, coach_headers, group["id"], player["id"])

        assert ids_in(picker(client, code["code"])) == [player["id"]]

    def test_a_player_added_after_the_quiz_went_out_is_offered(
        self, client, coach_headers, quiz_with_question
    ):
        # Groups are live distribution lists. Preserved, deliberately.
        early = make_player(client, coach_headers, "Early", "Starter")
        group = make_group(client, coach_headers, "Safeties", [early["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        late = make_player(client, coach_headers, "David", "Late")
        client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": [late["id"]]},
            headers=coach_headers,
        )

        assert sorted(ids_in(picker(client, code["code"]))) == sorted(
            [early["id"], late["id"]]
        ), "somebody added after the quiz went out is offered a start"

    def test_a_player_in_two_linked_groups_appears_once(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Evan", "Both")
        a = make_group(client, coach_headers, "Safeties", [player["id"]])
        b = make_group(client, coach_headers, "Special Teams", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [a["id"], b["id"]])

        assert ids_in(picker(client, code["code"])) == [player["id"]]

    def test_live_eligibility_and_an_attempt_do_not_duplicate_a_player(
        self, client, coach_headers, quiz_with_question
    ):
        # Both authorities apply to the same person; they must not stack.
        player = make_player(client, coach_headers, "Finn", "Started")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        start(client, code["id"], "Finn Started", player["id"])

        assert ids_in(picker(client, code["code"])) == [player["id"]]


class TestDeactivation:
    def test_a_deactivated_player_with_no_attempt_is_not_offered(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Gone", "Player")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        deactivate(client, coach_headers, player["id"])

        assert picker(client, code["code"]) == []

    def test_a_deactivated_player_who_started_is_still_offered_and_resumes(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Hurt", "Player")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        first = start(client, code["id"], "Hurt Player", player["id"])
        attempt_id = first.get_json()["attempt_id"]

        deactivate(client, coach_headers, player["id"])

        assert ids_in(picker(client, code["code"])) == [player["id"]]
        resumed = start(client, code["id"], "Hurt Player", player["id"])
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == attempt_id


class TestIdentityIsNeverInvented:
    def test_two_players_sharing_a_name_stay_two_rows(
        self, client, coach_headers, quiz_with_question
    ):
        # The whole reason the picker carries player_id. One of them starts and
        # is then removed; both must still be tellable apart.
        one = make_player(client, coach_headers, "Chris", "Williams")
        two = make_player(client, coach_headers, "Chris", "Williams")
        group = make_group(client, coach_headers, "Safeties", [one["id"], two["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        start(client, code["id"], "Chris Williams", one["id"])
        remove(client, coach_headers, group["id"], one["id"])

        options = picker(client, code["code"])
        assert sorted(ids_in(options)) == sorted([one["id"], two["id"]])
        assert len(options) == 2, "one row each, never collapsed by name"

    def test_a_same_named_player_cannot_resume_the_other_s_attempt(
        self, client, coach_headers, quiz_with_question
    ):
        one = make_player(client, coach_headers, "Chris", "Williams")
        two = make_player(client, coach_headers, "Chris", "Williams")
        group = make_group(client, coach_headers, "Safeties", [one["id"], two["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        theirs = start(client, code["id"], "Chris Williams", one["id"]).get_json()["attempt_id"]

        mine = start(client, code["id"], "Chris Williams", two["id"])

        assert mine.status_code == 201, "a new attempt of their own"
        assert mine.get_json()["attempt_id"] != theirs

    def test_a_legacy_attempt_is_offered_without_acquiring_an_identity(
        self, client, coach_headers, quiz_with_question
    ):
        # A free-text roster entry has no canonical player. It must still be
        # resumable, and must NOT be quietly promoted into one by being listed.
        quiz_id = quiz_with_question["id"]
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": ["Legacy Larry"]},
            headers=coach_headers,
        )
        code = activate(client, coach_headers, quiz_id, [])
        started = start(client, code["id"], "Legacy Larry")
        assert started.status_code == 201

        options = picker(client, code["code"])
        larry = [o for o in options if o["name"] == "Legacy Larry"]
        assert len(larry) == 1
        assert larry[0]["player_id"] is None, "no id was invented for a free-text entry"

        resumed = start(client, code["id"], "Legacy Larry")
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == started.get_json()["attempt_id"]


class TestTheFullReturnJourney:
    def test_start_leave_get_removed_come_back_and_finish(
        self, client, coach_headers, quiz_with_question
    ):
        """The scenario end to end, exactly as a player lives it."""
        player = make_player(client, coach_headers, "Mike", "Beaudry")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        # 1-3. Starts the quiz, then closes the tab.
        first = start(client, code["id"], "Mike Beaudry", player["id"])
        attempt_id = first.get_json()["attempt_id"]

        # 4. The coach reorganises the position group.
        remove(client, coach_headers, group["id"], player["id"])

        # 5-7. Comes back and types the code. Their name is still there.
        options = picker(client, code["code"])
        chosen = [o for o in options if o["player_id"] == player["id"]]
        assert chosen, "the player can find themselves again"

        # 8-9. Selecting it resumes; it does not create a second attempt.
        resumed = start(client, code["id"], "Mike Beaudry", chosen[0]["player_id"])
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == attempt_id

        # 10. And they can finish.
        question_id = client.post(
            "/api/play/validate-code", json={"code": code["code"]}
        ).get_json()["quiz"]["questions"][0]["id"]
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": "Mike Beaudry",
                "player_id": player["id"],
                "answers": [{"question_id": question_id, "answer_text": "True"}],
            },
        )
        assert submitted.status_code in (200, 201), submitted.get_json()
