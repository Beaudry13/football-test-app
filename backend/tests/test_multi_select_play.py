"""Multi-Select M3 - ANSWERING, GRADING AND RESUMING A SET.

    The player's selected set must EXACTLY equal the correct set.
    Missing one is wrong. One extra is wrong. Order means nothing.

ANSWERED AND CORRECT ARE DIFFERENT QUESTIONS
--------------------------------------------
An empty selection is UNANSWERED, not incorrect - a player who never answered
has not answered wrongly, and grading them 0 for it is the "fabricating a grade
when nothing was given" CLAUDE.md forbids. Equally, ANY selection satisfies
require-all-answers: a player must never be forced to find every correct option
merely to be allowed to submit.

SCORING IS UNTOUCHED
--------------------
`answers.is_correct` stays the boolean every scoring surface already reads, so
services/scoring never learns that multi-select exists. Exact-set equality
decides the boolean; nothing downstream changes.
"""

import json

import pytest

from app.extensions import db
from app.models import Answer, AnswerSelectedOption

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def opt(text, correct=False):
    return {"option_text": text, "is_correct_answer": correct}


@pytest.fixture
def multi(client, coach_headers):
    """A + C + D correct, B and E wrong."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Pressure"}, headers=coach_headers
    ).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Who is in the pressure?",
            "question_type": "multiple_choice",
            "allows_multiple_answers": True,
            "options": [
                opt("A", True),
                opt("B"),
                opt("C", True),
                opt("D", True),
                opt("E"),
            ],
        },
        headers=coach_headers,
    )
    assert question.status_code == 201, question.get_json()
    question = question.get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert code.status_code == 201, code.get_json()
    code = code.get_json()
    by_text = {o["option_text"]: o["id"] for o in question["options"]}
    return {"quiz_id": quiz["id"], "question": question, "code": code, "ids": by_text}


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def select(client, multi, texts, player=PLAYER):
    start(client, multi["code"], player)
    return client.post(
        "/api/play/answers",
        json={
            "access_code_id": multi["code"]["id"],
            "player_name": player,
            "question_id": multi["question"]["id"],
            "selected_option_id": None,
            "selected_option_ids": [multi["ids"][t] for t in texts],
            "answer_text": None,
        },
    )


def verdict(app, question_id):
    with app.app_context():
        return Answer.query.filter_by(question_id=question_id).one().is_correct


# ---------------------------------------------------------------------------
# Exact set equality
# ---------------------------------------------------------------------------


class TestGrading:
    def test_the_exact_correct_set_is_correct(self, app, client, multi):
        assert select(client, multi, ["A", "C", "D"]).status_code == 204

        assert verdict(app, multi["question"]["id"]) is True

    def test_a_different_ORDER_is_still_correct(self, app, client, multi):
        """Sets have no order, and a player's tap sequence must never decide a
        grade."""
        assert select(client, multi, ["D", "A", "C"]).status_code == 204

        assert verdict(app, multi["question"]["id"]) is True

    def test_missing_one_correct_answer_is_incorrect(self, app, client, multi):
        select(client, multi, ["A", "C"])

        assert verdict(app, multi["question"]["id"]) is False

    def test_one_extra_wrong_answer_is_incorrect(self, app, client, multi):
        select(client, multi, ["A", "C", "D", "E"])

        assert verdict(app, multi["question"]["id"]) is False

    def test_a_single_correct_selection_out_of_three_is_incorrect(
        self, app, client, multi
    ):
        select(client, multi, ["A"])

        assert verdict(app, multi["question"]["id"]) is False

    def test_selecting_everything_is_incorrect(self, app, client, multi):
        select(client, multi, ["A", "B", "C", "D", "E"])

        assert verdict(app, multi["question"]["id"]) is False

    def test_an_empty_set_is_UNGRADED_not_incorrect(self, app, client, multi):
        """A player who never answered has not answered wrongly."""
        select(client, multi, [])

        assert verdict(app, multi["question"]["id"]) is None

    def test_a_multi_select_with_one_correct_answer_grades_normally(
        self, app, client, coach_headers
    ):
        quiz = client.post(
            "/api/quizzes", json={"title": "One right"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Select all that apply",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [opt("Only this", True), opt("Not this"), opt("Nor this")],
            },
            headers=coach_headers,
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        ids = {o["option_text"]: o["id"] for o in question["options"]}
        bundle = {"question": question, "code": code, "ids": ids}

        select(client, bundle, ["Only this"])
        assert verdict(app, question["id"]) is True

        select(client, bundle, ["Only this", "Not this"])
        assert verdict(app, question["id"]) is False


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class TestStorage:
    def test_the_complete_set_is_stored(self, app, client, multi):
        select(client, multi, ["A", "C", "D"])

        with app.app_context():
            answer = Answer.query.one()
            stored = {s.option_id for s in answer.selected_options}
            assert stored == {multi["ids"][t] for t in ("A", "C", "D")}

    def test_selected_option_id_stays_NULL_for_a_set(self, app, client, multi):
        """One column cannot honestly hold three choices, and picking one of
        them would be a lie every downstream reader would believe."""
        select(client, multi, ["A", "C", "D"])

        with app.app_context():
            assert Answer.query.one().selected_option_id is None

    def test_changing_the_selection_REPLACES_it(self, app, client, multi):
        select(client, multi, ["A", "C", "D"])
        select(client, multi, ["B"])

        with app.app_context():
            stored = {s.option_id for s in Answer.query.one().selected_options}
            assert stored == {multi["ids"]["B"]}, "no orphans from the previous set"

    def test_deselecting_everything_leaves_nothing_behind(self, app, client, multi):
        select(client, multi, ["A", "C"])
        select(client, multi, [])

        with app.app_context():
            assert AnswerSelectedOption.query.count() == 0

    def test_a_duplicate_id_records_one_selection(self, app, client, multi):
        """The client sending the same option twice is a set of one, not a
        duplicate-key error."""
        a = multi["ids"]["A"]
        start(client, multi["code"])
        saved = client.post(
            "/api/play/answers",
            json={
                "access_code_id": multi["code"]["id"],
                "player_name": PLAYER,
                "question_id": multi["question"]["id"],
                "selected_option_id": None,
                "selected_option_ids": [a, a, a],
                "answer_text": None,
            },
        )

        assert saved.status_code == 204
        with app.app_context():
            assert AnswerSelectedOption.query.count() == 1

    def test_an_option_from_another_question_is_refused(self, client, coach_headers, multi):
        """Ids from a client are never trusted - the join table has no foreign
        key, so this check is the only thing standing between a payload and a
        meaningless stored number."""
        other = client.post(
            f"/api/quizzes/{multi['quiz_id']}/questions",
            json={
                "question_text": "Different question",
                "question_type": "multiple_choice",
                "options": [opt("X", True), opt("Y")],
            },
            headers=coach_headers,
        ).get_json()
        start(client, multi["code"])

        refused = client.post(
            "/api/play/answers",
            json={
                "access_code_id": multi["code"]["id"],
                "player_name": PLAYER,
                "question_id": multi["question"]["id"],
                "selected_option_id": None,
                "selected_option_ids": [other["options"][0]["id"]],
                "answer_text": None,
            },
        )

        assert refused.status_code == 422

    def test_a_nonexistent_option_id_is_refused(self, client, multi):
        start(client, multi["code"])

        refused = client.post(
            "/api/play/answers",
            json={
                "access_code_id": multi["code"]["id"],
                "player_name": PLAYER,
                "question_id": multi["question"]["id"],
                "selected_option_id": None,
                "selected_option_ids": [999999],
                "answer_text": None,
            },
        )

        assert refused.status_code == 422


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------


class TestResume:
    def test_resume_restores_the_COMPLETE_set(self, client, multi):
        """Not one of them. This is the failure the join table exists to make
        impossible."""
        select(client, multi, ["A", "C", "D"])

        resumed = start(client, multi["code"]).get_json()

        entry = next(
            a
            for a in resumed["answers"]
            if a["question_id"] == multi["question"]["id"]
        )
        assert set(entry["selected_option_ids"]) == {
            multi["ids"][t] for t in ("A", "C", "D")
        }

    def test_a_single_choice_answer_also_reports_its_set(self, client, coach_headers):
        """One shape for the client to read, whichever kind of question it is."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Single"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "One only",
                "question_type": "multiple_choice",
                "options": [opt("Right", True), opt("Wrong")],
            },
            headers=coach_headers,
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        chosen = question["options"][0]["id"]
        start(client, code)
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": question["id"],
                "selected_option_id": chosen,
                "answer_text": None,
            },
        )

        entry = start(client, code).get_json()["answers"][0]

        assert entry["selected_option_id"] == chosen, "unchanged"
        assert entry["selected_option_ids"] == [chosen], "and the set agrees"

    def test_the_delivered_question_says_it_takes_several_answers(self, client, multi):
        started = start(client, multi["code"]).get_json()

        assert started["questions"][0]["allows_multiple_answers"] is True

    def test_a_coach_turning_the_setting_off_does_not_change_a_live_attempt(
        self, client, coach_headers, multi
    ):
        """THE PHASE 4 INVARIANT. The delivered snapshot decides how this
        attempt behaves, not the live question."""
        select(client, multi, ["A", "C"])

        client.patch(
            f"/api/quizzes/{multi['quiz_id']}/questions/{multi['question']['id']}",
            json={"allows_multiple_answers": False},
            headers=coach_headers,
        )

        resumed = start(client, multi["code"]).get_json()

        assert resumed["questions"][0]["allows_multiple_answers"] is True
        entry = next(
            a for a in resumed["answers"] if a["question_id"] == multi["question"]["id"]
        )
        assert len(entry["selected_option_ids"]) == 2, "their selections survive"


# ---------------------------------------------------------------------------
# Submitting
# ---------------------------------------------------------------------------


class TestRequireAllAnswers:
    @pytest.fixture
    def strict(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes",
            json={"title": "Strict", "require_all_answers": True},
            headers=coach_headers,
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who is in the pressure?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [opt("A", True), opt("B"), opt("C", True)],
            },
            headers=coach_headers,
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        return {"question": question, "code": code}

    def submit(self, client, strict, ids):
        start(client, strict["code"])
        return client.post(
            "/api/play/submit",
            json={
                "access_code_id": strict["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": strict["question"]["id"],
                        "selected_option_id": None,
                        "selected_option_ids": ids,
                        "answer_text": None,
                    }
                ],
            },
        )

    def test_one_selection_is_enough_to_submit(self, client, strict):
        """ANSWERED, NOT CORRECT. Requiring every correct option here would
        make submission impossible until the player already knew the answer."""
        partial = [strict["question"]["options"][0]["id"]]

        assert self.submit(client, strict, partial).status_code == 201

    def test_an_empty_selection_blocks_submission(self, client, strict):
        refused = self.submit(client, strict, [])

        assert refused.status_code == 422
        assert "answer all questions" in refused.get_json()["error"].lower()


# ---------------------------------------------------------------------------
# Nothing else moved
# ---------------------------------------------------------------------------


class TestNoLeaks:
    def test_the_player_payload_carries_no_answer_key(self, client, multi):
        blob = json.dumps(start(client, multi["code"]).get_json())

        for leaked in ("is_correct_answer", "expected_answers", "answer_matching"):
            assert leaked not in blob

    def test_players_do_not_share_selections(self, app, client, multi):
        select(client, multi, ["A", "C"], player=PLAYER)
        select(client, multi, ["B"], player=OTHER)

        resumed = start(client, multi["code"], player=OTHER).get_json()
        entry = next(
            a for a in resumed["answers"] if a["question_id"] == multi["question"]["id"]
        )

        assert entry["selected_option_ids"] == [multi["ids"]["B"]]


class TestQueryCost:
    def test_resuming_loads_selections_in_ONE_query(
        self, app, client, coach_headers, multi
    ):
        """Scale-invariant: a flat ceiling would let an N+1 pass on a small
        fixture. Several answered questions, one selection query."""
        from sqlalchemy import event

        for index in range(5):
            client.post(
                f"/api/quizzes/{multi['quiz_id']}/questions",
                json={
                    "question_text": f"Extra {index}",
                    "question_type": "multiple_choice",
                    "allows_multiple_answers": True,
                    "options": [opt("Yes", True), opt("No")],
                },
                headers=coach_headers,
            )

        started = start(client, multi["code"]).get_json()
        for question in started["questions"]:
            client.post(
                "/api/play/answers",
                json={
                    "access_code_id": multi["code"]["id"],
                    "player_name": PLAYER,
                    "question_id": question["id"],
                    "selected_option_id": None,
                    "selected_option_ids": [question["options"][0]["id"]],
                    "answer_text": None,
                },
            )

        queries = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        with app.app_context():
            engine = db.engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            resumed = start(client, multi["code"])
        finally:
            event.remove(engine, "before_cursor_execute", listener)

        assert resumed.status_code == 200, resumed.get_json()
        selection_queries = [q for q in queries if "answer_selected_options" in q]
        assert len(selection_queries) == 1, selection_queries
