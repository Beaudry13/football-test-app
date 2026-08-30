"""An attempt already underway is its own authority.

Groups are LIVE distribution lists: who is in one right now decides who may
BEGIN a quiz, and a coach moving somebody between position groups on Tuesday
is deciding what gets sent next - not reaching into a quiz that player started
on Monday.

/submit has always re-derived the attempt from (access_code_id, player) and
never consulted the roster, so a removed player could always finish. /start
refused to hand their work back, so reloading the page locked them out of an
attempt the server would nonetheless have accepted. Submittable but not
resumable is the state these tests exist to keep closed.

The other half of the rule: a DEACTIVATED player may not begin, because that
is a coach saying "not on the team" - but deactivating somebody must never
orphan work already in progress.
"""

import pytest


@pytest.fixture
def quiz_with_question(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Install Week 2"}, headers=coach_headers
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


def remove(client, headers, group_id, player_id):
    return client.delete(f"/api/groups/{group_id}/members/{player_id}", headers=headers)


class TestResumeAfterRemoval:
    def test_removed_after_starting_can_still_resume(
        self, client, coach_headers, quiz_with_question
    ):
        # THE REGRESSION. Before this rule the second start returned 422 and
        # the player could not get back into work they had already begun.
        player = make_player(client, coach_headers, "Mike", "Safety")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        first = start(client, code["id"], "Mike Safety", player["id"])
        assert first.status_code == 201, "a new attempt is created"
        attempt_id = first.get_json()["attempt_id"]

        remove(client, coach_headers, group["id"], player["id"])

        resumed = start(client, code["id"], "Mike Safety", player["id"])
        assert resumed.status_code == 200, "resumed, not re-created"
        # The SAME attempt, not a second one.
        assert resumed.get_json()["attempt_id"] == attempt_id

    def test_removed_before_starting_still_cannot_start(
        self, client, coach_headers, quiz_with_question
    ):
        # Live membership still governs who may BEGIN. Nothing about this rule
        # hands a quiz to somebody the coach took off the list.
        player = make_player(client, coach_headers, "John", "Corner")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        remove(client, coach_headers, group["id"], player["id"])

        refused = start(client, code["id"], "John Corner", player["id"])
        assert refused.status_code == 422

    def test_added_after_the_quiz_was_sent_can_start(
        self, client, coach_headers, quiz_with_question
    ):
        # Deliberate product behaviour, not an accident: a transfer added to
        # Safeties on Tuesday receives the quiz sent on Monday.
        # The group already has somebody - a quiz cannot be sent to an empty
        # one - and the transfer arrives afterwards.
        already = make_player(client, coach_headers, "Existing", "Member")
        group = make_group(client, coach_headers, "Safeties", [already["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        late = make_player(client, coach_headers, "David", "Nickel")
        client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": [late["id"]]},
            headers=coach_headers,
        )

        assert start(client, code["id"], "David Nickel", late["id"]).status_code == 201

    def test_removed_from_every_linked_group_can_still_resume(
        self, client, coach_headers, quiz_with_question
    ):
        # Union eligibility is unchanged for a new start; an existing attempt
        # does not depend on any of it.
        player = make_player(client, coach_headers, "Evan", "Both")
        safeties = make_group(client, coach_headers, "Safeties", [player["id"]])
        teams = make_group(client, coach_headers, "Special Teams", [player["id"]])
        code = activate(
            client, coach_headers, quiz_with_question["id"], [safeties["id"], teams["id"]]
        )

        attempt_id = start(client, code["id"], "Evan Both", player["id"]).get_json()["attempt_id"]

        remove(client, coach_headers, safeties["id"], player["id"])
        assert start(client, code["id"], "Evan Both", player["id"]).status_code == 200

        remove(client, coach_headers, teams["id"], player["id"])
        again = start(client, code["id"], "Evan Both", player["id"])
        assert again.status_code == 200
        assert again.get_json()["attempt_id"] == attempt_id


class TestDeactivation:
    def test_deactivated_player_with_no_attempt_cannot_start(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Gone", "Player")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)

        # Still in the group - deactivation alone is what refuses them.
        assert start(client, code["id"], "Gone Player", player["id"]).status_code == 422

    def test_deactivated_player_with_an_attempt_can_resume_and_submit(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Injured", "Player")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        started = start(client, code["id"], "Injured Player", player["id"]).get_json()
        attempt_id = started["attempt_id"]

        client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)

        resumed = start(client, code["id"], "Injured Player", player["id"])
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == attempt_id

        quiz = client.get(
            f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
        ).get_json()
        question = quiz["questions"][0]
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": "Injured Player",
                "player_id": player["id"],
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": question["options"][0]["id"],
                    }
                ],
            },
        )
        assert submitted.status_code in (200, 201)

    def test_a_submitted_attempt_survives_deactivation(
        self, client, coach_headers, quiz_with_question
    ):
        player = make_player(client, coach_headers, "Left", "Team")
        group = make_group(client, coach_headers, "Safeties", [player["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])
        start(client, code["id"], "Left Team", player["id"])

        quiz = client.get(
            f"/api/quizzes/{quiz_with_question['id']}", headers=coach_headers
        ).get_json()
        question = quiz["questions"][0]
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": "Left Team",
                "player_id": player["id"],
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": question["options"][0]["id"],
                    }
                ],
            },
        )

        client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)
        remove(client, coach_headers, group["id"], player["id"])

        responses = client.get(
            f"/api/quizzes/{quiz_with_question['id']}/responses", headers=coach_headers
        ).get_json()
        assert "Left Team" in [r["display_name"] for r in responses]


class TestIdentityIsUnchanged:
    def test_resume_matches_the_canonical_player_not_the_name(
        self, client, coach_headers, quiz_with_question
    ):
        # Two people, one name. Each must resume their OWN attempt, and
        # removing one from the group must not hand the other's work over.
        one = make_player(client, coach_headers, "Chris", "Williams")
        two = make_player(client, coach_headers, "Chris", "Williams")
        group = make_group(client, coach_headers, "Safeties", [one["id"], two["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        a = start(client, code["id"], "Chris Williams", one["id"]).get_json()["attempt_id"]
        b = start(client, code["id"], "Chris Williams", two["id"]).get_json()["attempt_id"]
        assert a != b

        remove(client, coach_headers, group["id"], one["id"])

        resumed = start(client, code["id"], "Chris Williams", one["id"])
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == a

    def test_an_ambiguous_name_never_acquires_a_canonical_id(
        self, client, coach_headers, quiz_with_question
    ):
        # The safety net resolves a name to a player_id only when exactly one
        # candidate exists. This rule must not become a second, sloppier way
        # for an attempt to pick up an identity it cannot prove.
        one = make_player(client, coach_headers, "Same", "Name")
        two = make_player(client, coach_headers, "Same", "Name")
        group = make_group(client, coach_headers, "Safeties", [one["id"], two["id"]])
        code = activate(client, coach_headers, quiz_with_question["id"], [group["id"]])

        first = start(client, code["id"], "Same Name")
        assert first.status_code == 201
        assert first.get_json().get("player_id") is None

        # Resuming by the same ambiguous name returns the same unlinked
        # attempt and still refuses to guess which person it belongs to.
        again = start(client, code["id"], "Same Name")
        assert again.status_code == 200
        assert again.get_json()["attempt_id"] == first.get_json()["attempt_id"]
        assert again.get_json().get("player_id") is None

    def test_a_legacy_name_only_entry_resumes_exactly_as_before(
        self, client, coach_headers, quiz_with_question
    ):
        # A roster typed as free text, with no canonical Player behind it.
        # Its resume path is name-only and must be untouched by this change.
        client.put(
            f"/api/quizzes/{quiz_with_question['id']}/roster",
            json={"players": ["Legacy Typed"]},
            headers=coach_headers,
        )
        code = activate(client, coach_headers, quiz_with_question["id"], [])

        first = start(client, code["id"], "Legacy Typed")
        assert first.status_code == 201
        attempt_id = first.get_json()["attempt_id"]
        assert first.get_json().get("player_id") is None

        again = start(client, code["id"], "Legacy Typed")
        assert again.status_code == 200
        assert again.get_json()["attempt_id"] == attempt_id
        assert again.get_json().get("player_id") is None
