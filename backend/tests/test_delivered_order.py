"""Phase 4B step 1 - THE DELIVERED ORDER IS THE RECORD.

    An attempt's ORDER comes from the same place its CONTENT does:
    the delivered snapshot. The live quiz is consulted only for an
    attempt that has no snapshot at all.

WHY THIS IS ITS OWN STEP, AHEAD OF ANY FEATURE
----------------------------------------------
`presented_question_ids` used to rebuild an attempt's order from
`quiz.questions` on every read. Two things made that a trap rather than merely
an inconsistency:

1. **Graded attempts store `question_order = NULL`.** `frozen_question_order`
   returns None for anything non-randomized, deliberately. So a graded attempt
   has no frozen list, and its order was re-derived from the LIVE quiz every
   single time it was read.
2. Nothing filtered `quiz.questions` - yet. Question retirement (Phase 4B step
   2) is exactly such a filter, and it would have reached backwards into
   attempts already underway: a snapshot-backed player would have watched a
   question jump to the end of their quiz, and a legacy player would have
   watched it disappear.

There was also a live inconsistency: `question_order` could name a question
the delivered `questions` payload did not contain, because the two came from
different sources. The tests below pin both halves.

THIS STEP ADDS NO FEATURE. No retirement, no filtering, no schema change.
"""

import pytest

from app.extensions import db
from app.models import AttemptQuestionSnapshot, PlayerAttempt
from app.models.assessment_mode import PRACTICE

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def _q(client, headers, quiz_id, text):
    r = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Right", "is_correct_answer": True},
                {"option_text": "Wrong", "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def texts(payload):
    return [q["question_text"] for q in payload["questions"]]


def reorder(client, headers, quiz_id, ordered_ids):
    """Reordering takes the WHOLE list - the route rejects a partial one.

    (A PATCH with `position` looks like it should work and silently does
    nothing, which is how the first draft of these tests passed while proving
    the opposite of what they claimed.)
    """
    r = client.post(
        f"/api/quizzes/{quiz_id}/questions/reorder",
        json={"question_ids": ordered_ids},
        headers=headers,
    )
    assert r.status_code == 200, r.get_json()
    return r


@pytest.fixture
def graded(client, coach_headers):
    """A GRADED attempt on a three-question quiz.

    Graded specifically, because that is the case with `question_order = NULL`
    - the one whose order used to be rebuilt from the live quiz on every read.
    """
    quiz = client.post(
        "/api/quizzes", json={"title": "Delivered order"}, headers=coach_headers
    ).get_json()
    q1 = _q(client, coach_headers, quiz["id"], "Q1 first")
    q2 = _q(client, coach_headers, quiz["id"], "Q2 second")
    q3 = _q(client, coach_headers, quiz["id"], "Q3 third")
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    first = start(client, code)
    assert first.status_code == 201
    return {
        "quiz_id": quiz["id"],
        "q1": q1,
        "q2": q2,
        "q3": q3,
        "code": code,
        "start": first.get_json(),
    }


# ---------------------------------------------------------------------------
# 1-4. Reorder: the existing attempt keeps its order, a new one gets the new
# ---------------------------------------------------------------------------


class TestReorder:
    def test_the_graded_attempt_stores_no_frozen_order(self, app, graded):
        """THE PRECONDITION THAT MADE THIS DANGEROUS. If this ever starts
        storing a list, re-read this whole file - the risk it guards changed."""
        with app.app_context():
            attempt = PlayerAttempt.query.get(graded["start"]["attempt_id"])
            assert attempt.question_order is None

    def test_it_starts_in_authored_order(self, graded):
        assert texts(graded["start"]) == ["Q1 first", "Q2 second", "Q3 third"]
        assert graded["start"]["question_order"] == [
            graded["q1"]["id"],
            graded["q2"]["id"],
            graded["q3"]["id"],
        ]

    def test_an_existing_attempt_keeps_its_delivered_order_after_a_reorder(
        self, client, coach_headers, graded
    ):
        """THE HEADLINE. The coach moves Q3 to the front; the player already
        underway keeps the order they were given."""
        reorder(
            client,
            coach_headers,
            graded["quiz_id"],
            [graded["q3"]["id"], graded["q1"]["id"], graded["q2"]["id"]],
        )

        resumed = start(client, graded["code"])
        assert resumed.status_code == 200, "same attempt, resumed"
        body = resumed.get_json()

        assert texts(body) == ["Q1 first", "Q2 second", "Q3 third"]
        assert body["question_order"] == [
            graded["q1"]["id"],
            graded["q2"]["id"],
            graded["q3"]["id"],
        ]

    def test_a_new_attempt_receives_the_new_live_order(
        self, client, coach_headers, graded
    ):
        reorder(
            client,
            coach_headers,
            graded["quiz_id"],
            [graded["q3"]["id"], graded["q1"]["id"], graded["q2"]["id"]],
        )

        fresh = start(client, graded["code"], player=OTHER)
        assert fresh.status_code == 201
        assert texts(fresh.get_json())[0] == "Q3 third"

    def test_order_and_content_agree_after_a_reorder(self, client, coach_headers, graded):
        """The inconsistency this step closes: order and content used to come
        from different sources, so they could name different question sets."""
        reorder(
            client,
            coach_headers,
            graded["quiz_id"],
            [graded["q3"]["id"], graded["q1"]["id"], graded["q2"]["id"]],
        )

        body = start(client, graded["code"]).get_json()

        assert [q["id"] for q in body["questions"]] == body["question_order"]


# ---------------------------------------------------------------------------
# 5-7. A question added mid-attempt
# ---------------------------------------------------------------------------


class TestQuestionAddedLater:
    def test_an_existing_attempt_does_not_gain_it(self, client, coach_headers, graded):
        _q(client, coach_headers, graded["quiz_id"], "Q4 added later")

        body = start(client, graded["code"]).get_json()

        assert texts(body) == ["Q1 first", "Q2 second", "Q3 third"]

    def test_the_added_question_is_not_in_the_existing_attempts_ORDER_either(
        self, client, coach_headers, graded
    ):
        """The precise bug this step fixes. `questions` already excluded the
        new question after 4a-bis, but `question_order` still listed it - so
        the two payloads disagreed about what the attempt contained."""
        added = _q(client, coach_headers, graded["quiz_id"], "Q4 added later")

        body = start(client, graded["code"]).get_json()

        assert added["id"] not in body["question_order"]
        assert [q["id"] for q in body["questions"]] == body["question_order"]

    def test_a_new_attempt_does_receive_it(self, client, coach_headers, graded):
        _q(client, coach_headers, graded["quiz_id"], "Q4 added later")

        fresh = start(client, graded["code"], player=OTHER).get_json()

        assert "Q4 added later" in texts(fresh)


# ---------------------------------------------------------------------------
# 8-9. Deletion, within the rules the edit lock still allows
# ---------------------------------------------------------------------------


class TestDeletion:
    def test_deleting_an_unanswered_question_leaves_the_delivered_set_intact(
        self, client, coach_headers, graded
    ):
        """Deleting an ANSWERED question is still blocked
        (_reject_if_already_answered), so this deletes an unanswered one - the
        only deletion the product currently permits."""
        assert (
            client.delete(
                f"/api/quizzes/{graded['quiz_id']}/questions/{graded['q2']['id']}",
                headers=coach_headers,
            ).status_code
            == 204
        )

        body = start(client, graded["code"]).get_json()

        # The row survives with question_id NULL, so the question drops out of
        # both payloads together rather than one of them.
        assert texts(body) == ["Q1 first", "Q3 third"]
        assert [q["id"] for q in body["questions"]] == body["question_order"]
        assert graded["q2"]["id"] not in body["question_order"]

    def test_the_snapshot_row_itself_is_not_deleted(self, app, client, coach_headers, graded):
        client.delete(
            f"/api/quizzes/{graded['quiz_id']}/questions/{graded['q2']['id']}",
            headers=coach_headers,
        )

        with app.app_context():
            rows = AttemptQuestionSnapshot.query.filter_by(
                attempt_id=graded["start"]["attempt_id"]
            ).all()
            assert len(rows) == 3, "history is preserved even when the question is gone"
            assert any(row.question_id is None for row in rows)


# ---------------------------------------------------------------------------
# 10. Randomized practice
# ---------------------------------------------------------------------------


class TestRandomizedPractice:
    @pytest.fixture
    def practice(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Shuffled"}, headers=coach_headers
        ).get_json()
        questions = [
            _q(client, coach_headers, quiz["id"], f"Q{i} of six") for i in range(1, 7)
        ]
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER, OTHER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": PRACTICE, "randomize_questions": True},
            headers=coach_headers,
        ).get_json()
        return {"quiz_id": quiz["id"], "questions": questions, "code": code}

    def test_a_randomized_attempt_resumes_in_the_SAME_shuffled_order(
        self, client, practice
    ):
        first = start(client, practice["code"]).get_json()
        assert first["question_order"], "randomized practice freezes an order"

        resumed = start(client, practice["code"]).get_json()

        assert resumed["question_order"] == first["question_order"]
        assert texts(resumed) == texts(first)

    def test_the_shuffled_order_survives_a_live_reorder(
        self, client, coach_headers, practice
    ):
        first = start(client, practice["code"]).get_json()

        ids = [q["id"] for q in practice["questions"]]
        reorder(client, coach_headers, practice["quiz_id"], [ids[-1], *ids[:-1]])

        resumed = start(client, practice["code"]).get_json()
        assert resumed["question_order"] == first["question_order"]

    def test_the_delivered_payload_follows_the_shuffled_order(self, client, practice):
        """Order and content agree here too - the shuffle is recorded in the
        snapshot POSITIONS, so reading positions reproduces it."""
        body = start(client, practice["code"]).get_json()

        assert [q["id"] for q in body["questions"]] == body["question_order"]

    def test_try_again_gets_a_fresh_delivery(self, client, coach_headers, practice):
        """Practice retakes are new attempts, so they pick up live changes -
        which is what makes retirement (step 2) land on new attempts only."""
        first = start(client, practice["code"]).get_json()
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": practice["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": q["options"][0]["id"],
                        "answer_text": None,
                    }
                    for q in first["questions"]
                ],
            },
        )
        _q(client, coach_headers, practice["quiz_id"], "Q7 added between attempts")

        retake = start(client, practice["code"]).get_json()

        assert retake["attempt_id"] != first["attempt_id"]
        assert "Q7 added between attempts" in texts(retake)


# ---------------------------------------------------------------------------
# 14. Nothing here mutates a snapshot
# ---------------------------------------------------------------------------


class TestNoSnapshotMutation:
    def test_reading_the_order_never_writes(self, app, client, coach_headers, graded):
        with app.app_context():
            before = {
                (row.id, row.position, row.question_id)
                for row in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=graded["start"]["attempt_id"]
                )
            }

        reorder(
            client,
            coach_headers,
            graded["quiz_id"],
            [graded["q3"]["id"], graded["q1"]["id"], graded["q2"]["id"]],
        )
        start(client, graded["code"])
        start(client, graded["code"])

        with app.app_context():
            after = {
                (row.id, row.position, row.question_id)
                for row in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=graded["start"]["attempt_id"]
                )
            }
        assert before == after


# ---------------------------------------------------------------------------
# 12. Legacy attempts keep the compatibility fallback
# ---------------------------------------------------------------------------


class TestLegacyFallback:
    def test_an_attempt_with_no_snapshot_still_reconciles_against_the_live_quiz(
        self, app, client, coach_headers, graded
    ):
        """A pre-Phase-1 attempt has no delivered record, so the live quiz is
        the only thing there is to answer with. COMPATIBILITY FALLBACK, not
        history - and deliberately still reached."""
        with app.app_context():
            AttemptQuestionSnapshot.query.filter_by(
                attempt_id=graded["start"]["attempt_id"]
            ).delete()
            db.session.commit()

        reorder(
            client,
            coach_headers,
            graded["quiz_id"],
            [graded["q3"]["id"], graded["q1"]["id"], graded["q2"]["id"]],
        )

        body = start(client, graded["code"]).get_json()

        # Follows the LIVE order, because there is no delivered one.
        assert texts(body)[0] == "Q3 third"

    def test_zero_snapshot_rows_is_distinct_from_an_empty_delivered_list(
        self, app, client, coach_headers, graded
    ):
        """`delivered_question_ids` returns None for "unrecorded" and a list
        for "recorded". Collapsing the two would make a legitimately empty
        delivery indistinguishable from a legacy attempt - the hazard recorded
        in the Phase 4B audit, §12."""
        from app.services.attempts import delivered_question_ids

        with app.app_context():
            attempt = PlayerAttempt.query.get(graded["start"]["attempt_id"])
            assert delivered_question_ids(attempt) is not None

            AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt.id).delete()
            db.session.commit()
            db.session.refresh(attempt)
            assert delivered_question_ids(attempt) is None
