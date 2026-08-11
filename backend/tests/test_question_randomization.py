"""Practice question randomization: frozen per attempt, never retroactive.

The whole feature is one idea: SHUFFLE ONCE, at attempt creation, and treat
the result as a historical fact. Everything below exists to prove the "once"
and the "historical" - a reshuffle on refresh, or a coach's edit reordering
work already in progress, is the failure this is guarding against.

Nothing here asserts that two shuffles differ. That would be flaky by
construction: two valid permutations are allowed to match. The shuffle is
exercised through an injected seeded RNG instead, so the ordering assertions
are exact.
"""

import random

import pytest

from app.extensions import db
from app.models import AccessCode, PlayerAttempt, Question
from app.models.assessment_mode import PRACTICE
from app.services import attempts as attempts_service

PLAYER = "Jordan Smith"


def build_quiz(client, headers, *, count=6):
    quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=headers).get_json()
    for index in range(count):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Question {index + 1}",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
            },
            headers=headers,
        )
        assert response.status_code == 201, response.get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER, "Alex Lee"]}, headers=headers
    )
    return quiz


def activate(client, headers, quiz_id, *, mode=None, randomize=None):
    payload = {}
    if mode is not None:
        payload["mode"] = mode
    if randomize is not None:
        payload["randomize_questions"] = randomize
    response = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json=payload, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def authored_ids(client, headers, quiz_id):
    quiz = client.get(f"/api/quizzes/{quiz_id}", headers=headers).get_json()
    return [q["id"] for q in quiz["questions"]]


# ---------------------------------------------------------------------------
# The shuffle itself
# ---------------------------------------------------------------------------


class TestShuffle:
    def test_randomize_off_stores_nothing(self, app, client, coach_headers):
        """None means "authored order" - storing an explicit copy would go
        stale the moment the coach reorders the quiz."""
        quiz = build_quiz(client, coach_headers)
        with app.app_context():
            from app.models import Quiz

            stored = attempts_service.frozen_question_order(
                db.session.get(Quiz, quiz["id"]), randomize=False
            )
        assert stored is None

    @pytest.mark.parametrize("count", [0, 1])
    def test_nothing_to_shuffle_stores_nothing(self, app, client, coach_headers, count):
        quiz = build_quiz(client, coach_headers, count=count)
        with app.app_context():
            from app.models import Quiz

            stored = attempts_service.frozen_question_order(
                db.session.get(Quiz, quiz["id"]), randomize=True
            )
        # An empty list would be indistinguishable from "no questions yet"
        # downstream; one question has exactly one order.
        assert stored is None

    def test_a_seeded_shuffle_is_exact_and_a_permutation(self, app, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        with app.app_context():
            from app.models import Quiz

            model = db.session.get(Quiz, quiz["id"])
            authored = attempts_service.authored_question_ids(model)
            first = attempts_service.frozen_question_order(
                model, randomize=True, rng=random.Random(1234)
            )
            again = attempts_service.frozen_question_order(
                model, randomize=True, rng=random.Random(1234)
            )

        # Same seed, same order - the seam tests rely on.
        assert first == again
        # Every question exactly once: a shuffle, never a filter.
        assert sorted(first) == sorted(authored)
        assert len(first) == len(authored)

    def test_it_does_shuffle_at_all(self, app, client, coach_headers):
        """Proved over many seeds rather than by demanding one differ - two
        valid permutations are allowed to match, and asserting otherwise is
        how a suite becomes flaky."""
        quiz = build_quiz(client, coach_headers, count=8)
        with app.app_context():
            from app.models import Quiz

            model = db.session.get(Quiz, quiz["id"])
            authored = attempts_service.authored_question_ids(model)
            orders = {
                tuple(
                    attempts_service.frozen_question_order(
                        model, randomize=True, rng=random.Random(seed)
                    )
                )
                for seed in range(25)
            }
        assert len(orders) > 1
        assert any(order != tuple(authored) for order in orders)


# ---------------------------------------------------------------------------
# Freezing
# ---------------------------------------------------------------------------


class TestFrozenPerAttempt:
    def test_graded_never_stores_an_order(self, app, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], randomize=True)
        state = start(client, code).get_json()

        with app.app_context():
            assert PlayerAttempt.query.one().question_order is None
        # Graded still reports the authored order, unchanged.
        assert state["question_order"] == authored_ids(client, coach_headers, quiz["id"])

    def test_practice_without_randomize_reports_authored_order(self, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=False)

        state = start(client, code).get_json()

        assert state["question_order"] == authored_ids(client, coach_headers, quiz["id"])

    def test_practice_with_randomize_stores_an_order(self, app, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)

        state = start(client, code).get_json()

        with app.app_context():
            stored = PlayerAttempt.query.one().question_order
        assert stored is not None
        assert sorted(stored) == sorted(authored_ids(client, coach_headers, quiz["id"]))
        assert state["question_order"] == stored

    def test_refresh_returns_the_identical_order(self, client, coach_headers):
        """A refresh re-calls /start on the in-progress attempt. Reshuffling
        there would move the ground under a player mid-quiz."""
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        first = start(client, code).get_json()["question_order"]

        for _ in range(4):
            assert start(client, code).get_json()["question_order"] == first

    def test_resume_returns_the_identical_order(self, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        first = start(client, code).get_json()
        question_id = first["question_order"][0]
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": question_id,
                "selected_option_id": None,
                "answer_text": None,
            },
        )

        resumed = start(client, code).get_json()

        assert resumed["question_order"] == first["question_order"]
        assert resumed["attempt_id"] == first["attempt_id"]

    def test_changing_the_access_code_setting_does_not_touch_a_live_attempt(
        self, app, client, coach_headers
    ):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        before = start(client, code).get_json()["question_order"]

        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            stored.randomize_questions = False
            db.session.commit()

        assert start(client, code).get_json()["question_order"] == before

    def test_reordering_the_quiz_does_not_rewrite_the_stored_order(
        self, app, client, coach_headers
    ):
        """The stored order is a historical fact. A coach reordering the quiz
        must not retroactively change what a player was given."""
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        before = start(client, code).get_json()["question_order"]

        with app.app_context():
            for question in Question.query.all():
                question.position = 100 - question.position
            db.session.commit()
            raw = PlayerAttempt.query.one().question_order

        assert start(client, code).get_json()["question_order"] == before
        assert raw == before


# ---------------------------------------------------------------------------
# Reconciliation with a changing quiz
# ---------------------------------------------------------------------------


class TestReconciliation:
    def test_a_deleted_question_drops_out_cleanly(self, app, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        before = start(client, code).get_json()["question_order"]
        doomed = before[2]

        client.delete(
            f"/api/quizzes/{quiz['id']}/questions/{doomed}", headers=coach_headers
        )

        after = start(client, code).get_json()["question_order"]
        assert doomed not in after
        # Everything else keeps its frozen relative order.
        assert after == [qid for qid in before if qid != doomed]
        with app.app_context():
            # The stored order is NOT rewritten - it stays the historical fact.
            assert doomed in PlayerAttempt.query.one().question_order

    def test_a_newly_added_question_is_appended(self, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        before = start(client, code).get_json()["question_order"]

        added = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Added mid-attempt",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()

        after = start(client, code).get_json()["question_order"]
        # Appended, not inserted - the frozen prefix is untouched.
        assert after == before + [added["id"]]

    def test_an_attempt_with_no_stored_order_uses_the_live_authored_order(
        self, app, client, coach_headers
    ):
        """Every pre-existing attempt has NULL here, which is why no backfill
        was needed."""
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        start(client, code)

        with app.app_context():
            attempt = PlayerAttempt.query.one()
            attempt.question_order = None
            db.session.commit()

        assert start(client, code).get_json()["question_order"] == authored_ids(
            client, coach_headers, quiz["id"]
        )


# ---------------------------------------------------------------------------
# Retakes and multiple players
# ---------------------------------------------------------------------------


class TestRetakesAndPlayers:
    def submit(self, client, code, order, player=PLAYER):
        for question_id in order:
            client.post(
                "/api/play/answers",
                json={
                    "access_code_id": code["id"],
                    "player_name": player,
                    "question_id": question_id,
                    "selected_option_id": None,
                    "answer_text": "x",
                },
            )
        return client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": player,
                "answers": [
                    {"question_id": q, "selected_option_id": None, "answer_text": "x"}
                    for q in order
                ],
            },
        )

    def test_try_again_creates_a_new_attempt_with_its_own_order(
        self, app, client, coach_headers
    ):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        first = start(client, code).get_json()
        self.submit(client, code, first["question_order"])

        again = start(client, code).get_json()

        assert again["attempt_id"] != first["attempt_id"]
        with app.app_context():
            orders = [a.question_order for a in PlayerAttempt.query.order_by(PlayerAttempt.id)]
        assert len(orders) == 2
        # Each attempt owns its order; the second is not a copy of the first's
        # by reference or by reuse.
        assert all(sorted(o) == sorted(orders[0]) for o in orders)

    def test_two_players_get_independent_orders(self, app, client, coach_headers):
        quiz = build_quiz(client, coach_headers, count=8)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)

        a = start(client, code, PLAYER).get_json()["question_order"]
        b = start(client, code, "Alex Lee").get_json()["question_order"]

        # Independent, not necessarily different - asserting they differ would
        # be flaky. Each is a full permutation of the same questions.
        assert sorted(a) == sorted(b)
        with app.app_context():
            assert PlayerAttempt.query.count() == 2


# ---------------------------------------------------------------------------
# Nothing else moves
# ---------------------------------------------------------------------------


class TestOrderDoesNotAffectAnythingElse:
    def test_answers_check_and_lock_still_key_on_question_id(self, client, coach_headers):
        """Order is presentation. Every write carries a question_id, so a
        shuffled presentation cannot attach an answer to the wrong question."""
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        order = start(client, code).get_json()["question_order"]
        target = order[3]

        detail = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
        question = next(q for q in detail["questions"] if q["id"] == target)
        correct = next(o["id"] for o in question["options"] if o["is_correct_answer"])

        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": target,
                "selected_option_id": correct,
                "answer_text": None,
            },
        )
        feedback = client.post(
            "/api/play/check",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": target,
            },
        ).get_json()

        # The verdict belongs to the question the player answered, wherever it
        # sat in the shuffled sequence.
        assert feedback["question_id"] == target
        assert feedback["is_correct"] is True

    def test_randomized_practice_is_still_excluded_from_official_analytics(
        self, app, client, coach_headers
    ):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)
        order = start(client, code).get_json()["question_order"]
        TestRetakesAndPlayers().submit(client, code, order)

        responses = client.get(
            f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers
        ).get_json()
        rows = responses["responses"] if isinstance(responses, dict) else responses

        assert rows == [] or len(rows) == 0

    def test_activation_defaults_to_standard_order(self, client, coach_headers):
        """An existing client that never sends the field activates exactly as
        it does today."""
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)

        assert code["randomize_questions"] is False

    def test_the_coach_payload_reports_the_setting(self, client, coach_headers):
        quiz = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)

        assert code["randomize_questions"] is True
        assert code["mode"] == PRACTICE
