"""Multi-Select M2 - A COACH CAN AUTHOR "SELECT ALL THAT APPLY".

    Multiple choice gains one setting. It does not gain a question type, a
    second editor, or a new vocabulary.

THE VALIDATION RULES, AND WHY THEY DIFFER
-----------------------------------------
Single choice: exactly one correct answer. Unchanged, and deliberately so -
radios enforce it in the UI, and loosening it would turn a guarantee into a
runtime error for every coach who never wanted this feature.

Multi-select: at least one correct answer, at least two options.

**Exactly one correct answer is VALID on a multi-select.** "Select all that
apply" where only one does is a real question a coach might mean, and refusing
it would be the product second-guessing their material.

THE M2 ACTIVATION FENCE IS GONE
-------------------------------
M2 temporarily blocked activation, because a coach could author one of these
before players could answer it. M3 built the player side and removed the block,
and `TestActivationIsNoLongerFenced` below replaces those tests rather than
letting them vanish - a guard that disappears without a replacement is a guard
nobody notices losing.

Competition is still fenced, in
test_multi_select_practice_and_competition.py.
"""

import pytest

PLAYER = "Jordan Smith"


def opt(text, correct=False):
    return {"option_text": text, "is_correct_answer": correct}


def make_question(client, headers, quiz_id, *, options, multi=False, qtype="multiple_choice"):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": "Who is in the pressure?",
            "question_type": qtype,
            "allows_multiple_answers": multi,
            "options": options,
        },
        headers=headers,
    )


def add_roster(client, headers, quiz_id):
    client.put(
        f"/api/quizzes/{quiz_id}/roster",
        json={"players": [PLAYER]},
        headers=headers,
    )


def activate(client, headers, quiz_id):
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=headers
    )


@pytest.fixture
def quiz_id(client, coach_headers):
    return client.post(
        "/api/quizzes", json={"title": "Pressure"}, headers=coach_headers
    ).get_json()["id"]


class TestAuthoring:
    def test_a_coach_can_create_a_select_all_question(self, client, coach_headers, quiz_id):
        created = make_question(
            client,
            coach_headers,
            quiz_id,
            multi=True,
            options=[opt("Mike", True), opt("Will", True), opt("Nickel"), opt("FS")],
        )

        assert created.status_code == 201, created.get_json()
        assert created.get_json()["allows_multiple_answers"] is True

    def test_two_correct_answers_are_valid_ONLY_when_multi(
        self, client, coach_headers, quiz_id
    ):
        """The rule that makes this a distinct shape: the same option list is
        valid multi-select and invalid single-choice."""
        options = [opt("Mike", True), opt("Will", True)]

        assert (
            make_question(client, coach_headers, quiz_id, multi=True, options=options).status_code
            == 201
        )
        assert (
            make_question(client, coach_headers, quiz_id, multi=False, options=options).status_code
            == 422
        )

    def test_exactly_one_correct_answer_is_VALID_on_a_multi_select(
        self, client, coach_headers, quiz_id
    ):
        """Select all that apply, where only one does. A real question, and
        refusing it would second-guess the coach."""
        created = make_question(
            client,
            coach_headers,
            quiz_id,
            multi=True,
            options=[opt("Mike", True), opt("Will"), opt("Nickel")],
        )

        assert created.status_code == 201, created.get_json()

    def test_a_multi_select_needs_at_least_one_correct_answer(
        self, client, coach_headers, quiz_id
    ):
        refused = make_question(
            client, coach_headers, quiz_id, multi=True, options=[opt("Mike"), opt("Will")]
        )

        assert refused.status_code == 422

    def test_a_multi_select_needs_at_least_two_options(self, client, coach_headers, quiz_id):
        refused = make_question(
            client, coach_headers, quiz_id, multi=True, options=[opt("Mike", True)]
        )

        assert refused.status_code == 422

    def test_single_choice_validation_is_completely_unchanged(
        self, client, coach_headers, quiz_id
    ):
        assert (
            make_question(
                client, coach_headers, quiz_id, options=[opt("Mike", True), opt("Will")]
            ).status_code
            == 201
        )
        assert (
            make_question(
                client, coach_headers, quiz_id, options=[opt("Mike"), opt("Will")]
            ).status_code
            == 422
        ), "still exactly one correct answer"

    def test_the_flag_is_ignored_on_a_type_that_cannot_use_it(
        self, client, coach_headers, quiz_id
    ):
        """A written question is not a selection question. The flag is dropped
        rather than erroring - a client sending it is confused, not malicious,
        and the question it asked for is unambiguous."""
        created = make_question(
            client, coach_headers, quiz_id, multi=True, qtype="written", options=[]
        )

        assert created.status_code == 201
        assert created.get_json()["allows_multiple_answers"] is False

    def test_it_can_be_turned_on_after_creation(self, client, coach_headers, quiz_id):
        question = make_question(
            client, coach_headers, quiz_id, options=[opt("Mike", True), opt("Will")]
        ).get_json()
        assert question["allows_multiple_answers"] is False

        updated = client.patch(
            f"/api/quizzes/{quiz_id}/questions/{question['id']}",
            json={
                "allows_multiple_answers": True,
                "options": [opt("Mike", True), opt("Will", True)],
            },
            headers=coach_headers,
        )

        assert updated.status_code == 200, updated.get_json()
        assert updated.get_json()["allows_multiple_answers"] is True

    def test_duplicating_a_quiz_keeps_the_setting(self, client, coach_headers, quiz_id):
        """Losing it would silently turn the copy into single-choice with two
        correct answers - a shape validation then rejects."""
        make_question(
            client,
            coach_headers,
            quiz_id,
            multi=True,
            options=[opt("Mike", True), opt("Will", True)],
        )

        copy = client.post(
            f"/api/quizzes/{quiz_id}/duplicate", headers=coach_headers
        ).get_json()

        assert copy["questions"][0]["allows_multiple_answers"] is True


class TestActivationIsNoLongerFenced:
    """REPLACES the temporary M2 fence, which is gone.

    M2 blocked activation because players could not answer these questions
    yet. M3 built the player side, so the block was removed - and these tests
    take its place rather than the old ones simply disappearing, which is how
    a removed guard goes unnoticed.

    Competition remains fenced, and that lives in
    test_multi_select_practice_and_competition.py where the rest of the
    Competition behaviour is.
    """

    def test_a_quiz_containing_one_CAN_now_be_sent(self, client, coach_headers, quiz_id):
        make_question(
            client,
            coach_headers,
            quiz_id,
            multi=True,
            options=[opt("Mike", True), opt("Will", True)],
        )
        add_roster(client, coach_headers, quiz_id)

        assert activate(client, coach_headers, quiz_id).status_code == 201

    def test_an_ordinary_quiz_still_activates(self, client, coach_headers, quiz_id):
        make_question(client, coach_headers, quiz_id, options=[opt("Mike", True), opt("Will")])
        add_roster(client, coach_headers, quiz_id)

        assert activate(client, coach_headers, quiz_id).status_code == 201

    def test_a_quiz_with_no_questions_is_still_refused(
        self, client, coach_headers, quiz_id
    ):
        """The activation guards that were always there are untouched."""
        add_roster(client, coach_headers, quiz_id)

        assert activate(client, coach_headers, quiz_id).status_code == 422
