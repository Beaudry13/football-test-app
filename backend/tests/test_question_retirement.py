"""Phase 4B step 2 - STOP SENDING THIS QUESTION.

    Retirement changes WHO GETS THE QUESTION IN FUTURE.
    It changes nothing about an attempt that already received it.

THE THREE OPERATIONS THIS MUST NOT BECOME
-----------------------------------------
| Operation | Changes |
|---|---|
| Correct (edit) | the live question, for future attempts |
| **Stop sending** (this file) | whether NEW attempts receive it |
| Don't count (Phase 3) | whether it scores, for players who already have it |

They are separate on purpose and none implies another. A coach who stops
sending a broken question has NOT excused the players who already answered it
- that is a second, deliberate decision.

WHAT MAKES THIS SAFE
--------------------
Exactly one function filters: `attempts.deliverable_questions`, on the
NEW-attempt path. `Quiz.questions` is never filtered, because a legacy attempt
with no snapshot falls back to the live quiz - filtering at the model layer
would silently delete a retired question out of a PAST attempt that received
it. The tests below pin both the filtering and the not-filtering.
"""

import pytest

from app.extensions import db
from app.models import AttemptQuestionSnapshot, PlayerAttempt, Question
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


def retire(client, headers, quiz_id, question_id):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/retire", headers=headers
    )


def restore(client, headers, quiz_id, question_id):
    return client.delete(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/retire", headers=headers
    )


def activate(client, headers, quiz_id, **payload):
    return client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json=payload, headers=headers
    )


@pytest.fixture
def quiz3(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Retirement"}, headers=coach_headers
    ).get_json()
    q1 = _q(client, coach_headers, quiz["id"], "Q1 keeper")
    q2 = _q(client, coach_headers, quiz["id"], "Q2 the bad one")
    q3 = _q(client, coach_headers, quiz["id"], "Q3 keeper")
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = activate(client, coach_headers, quiz["id"]).get_json()
    return {"id": quiz["id"], "q1": q1, "q2": q2, "q3": q3, "code": code}


# ---------------------------------------------------------------------------
# New attempts stop receiving it; existing attempts are untouched
# ---------------------------------------------------------------------------


class TestDelivery:
    def test_a_new_attempt_does_not_receive_a_stopped_question(
        self, client, coach_headers, quiz3
    ):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        body = start(client, quiz3["code"]).get_json()

        assert texts(body) == ["Q1 keeper", "Q3 keeper"]
        assert quiz3["q2"]["id"] not in body["question_order"]

    def test_an_attempt_already_underway_KEEPS_it(self, client, coach_headers, quiz3):
        """THE INVARIANT. Retirement must never remove a question from an
        attempt that already received it."""
        before = start(client, quiz3["code"]).get_json()
        assert "Q2 the bad one" in texts(before)

        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        resumed = start(client, quiz3["code"])
        assert resumed.status_code == 200, "same attempt, resumed"
        assert texts(resumed.get_json()) == ["Q1 keeper", "Q2 the bad one", "Q3 keeper"]
        assert resumed.get_json()["question_order"] == before["question_order"]

    def test_an_answer_to_a_stopped_question_still_saves(
        self, client, coach_headers, quiz3
    ):
        """The player was given it, so they must be able to finish it."""
        start(client, quiz3["code"])
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        saved = client.post(
            "/api/play/answers",
            json={
                "access_code_id": quiz3["code"]["id"],
                "player_name": PLAYER,
                "question_id": quiz3["q2"]["id"],
                "selected_option_id": quiz3["q2"]["options"][0]["id"],
                "answer_text": None,
            },
        )
        assert saved.status_code == 204

    def test_an_attempt_underway_can_still_be_SUBMITTED(
        self, client, coach_headers, quiz3
    ):
        """require_all_answers validates the DELIVERED set, which still
        contains the stopped question - so the player is held to it and is not
        stranded by it."""
        body = start(client, quiz3["code"]).get_json()
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": quiz3["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": q["options"][0]["id"],
                        "answer_text": None,
                    }
                    for q in body["questions"]
                ],
            },
        )
        assert submitted.status_code == 201, submitted.get_json()

    def test_the_stopped_question_is_still_snapshotted_for_the_old_attempt(
        self, app, client, coach_headers, quiz3
    ):
        attempt_id = start(client, quiz3["code"]).get_json()["attempt_id"]
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        with app.app_context():
            ids = {
                row.question_id
                for row in AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt_id)
            }
            assert quiz3["q2"]["id"] in ids

    def test_a_new_attempt_records_only_what_it_was_given(
        self, app, client, coach_headers, quiz3
    ):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        attempt_id = start(client, quiz3["code"], player=OTHER).get_json()["attempt_id"]

        with app.app_context():
            ids = {
                row.question_id
                for row in AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt_id)
            }
            assert ids == {quiz3["q1"]["id"], quiz3["q3"]["id"]}


# ---------------------------------------------------------------------------
# Never filtered where it would rewrite the past
# ---------------------------------------------------------------------------


class TestNeverFiltersHistory:
    def test_the_coach_editor_still_shows_a_stopped_question(
        self, client, coach_headers, quiz3
    ):
        """A stopped question a coach cannot see is one they cannot restore."""
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        quiz = client.get(f"/api/quizzes/{quiz3['id']}", headers=coach_headers).get_json()

        by_id = {q["id"]: q for q in quiz["questions"]}
        assert quiz3["q2"]["id"] in by_id
        assert by_id[quiz3["q2"]["id"]]["is_retired"] is True
        assert by_id[quiz3["q2"]["id"]]["retired_at"] is not None
        assert by_id[quiz3["q1"]["id"]]["is_retired"] is False

    def test_a_LEGACY_attempt_still_shows_a_stopped_question(
        self, app, client, coach_headers, quiz3
    ):
        """THE STRONGEST ARGUMENT FOR NEVER FILTERING AT THE MODEL LAYER.

        A pre-Phase-1 attempt has no snapshot and falls back to the LIVE quiz.
        If retirement filtered `Quiz.questions`, this attempt would silently
        lose a question it almost certainly received.
        """
        attempt_id = start(client, quiz3["code"]).get_json()["attempt_id"]
        with app.app_context():
            AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt_id).delete()
            db.session.commit()

        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        body = start(client, quiz3["code"]).get_json()
        assert "Q2 the bad one" in texts(body)

    def test_historical_results_still_show_a_stopped_question(
        self, client, coach_headers, quiz3
    ):
        body = start(client, quiz3["code"]).get_json()
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": quiz3["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": q["options"][0]["id"],
                        "answer_text": None,
                    }
                    for q in body["questions"]
                ],
            },
        )

        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        results = client.post(
            "/api/play/results",
            json={"code": quiz3["code"]["code"], "player_name": PLAYER},
        ).get_json()
        shown = [a["question_text"] for a in results["answers"]]
        assert "Q2 the bad one" in shown


# ---------------------------------------------------------------------------
# Reversible
# ---------------------------------------------------------------------------


class TestRestore:
    def test_restoring_returns_it_to_future_delivery(self, client, coach_headers, quiz3):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])
        restore(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        body = start(client, quiz3["code"]).get_json()

        assert texts(body) == ["Q1 keeper", "Q2 the bad one", "Q3 keeper"]

    def test_restore_clears_both_columns(self, app, client, coach_headers, quiz3):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])
        restore(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        with app.app_context():
            question = db.session.get(Question, quiz3["q2"]["id"])
            assert question.retired_at is None
            assert question.retired_by_coach_id is None

    def test_nothing_is_deleted(self, app, client, coach_headers, quiz3):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        with app.app_context():
            assert db.session.get(Question, quiz3["q2"]["id"]) is not None

    def test_retiring_twice_keeps_the_original_timestamp(
        self, app, client, coach_headers, quiz3
    ):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])
        with app.app_context():
            first = db.session.get(Question, quiz3["q2"]["id"]).retired_at

        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        with app.app_context():
            assert db.session.get(Question, quiz3["q2"]["id"]).retired_at == first

    def test_restoring_an_active_question_is_a_no_op(self, client, coach_headers, quiz3):
        assert restore(client, coach_headers, quiz3["id"], quiz3["q1"]["id"]).status_code == 200

    def test_it_records_WHO_stopped_it(self, app, client, coach_headers, quiz3):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        with app.app_context():
            assert db.session.get(Question, quiz3["q2"]["id"]).retired_by_coach_id is not None


# ---------------------------------------------------------------------------
# Stopping is allowed exactly when the other edits are not
# ---------------------------------------------------------------------------


class TestAllowedAfterAnswers:
    def test_a_question_can_be_stopped_AFTER_players_have_answered_it(
        self, client, coach_headers, quiz3
    ):
        """THE WHOLE POINT. A coach discovers the question is broken because
        players answered it - so the one moment this must work is the moment
        every other edit is blocked."""
        body = start(client, quiz3["code"]).get_json()
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": quiz3["code"]["id"],
                "player_name": PLAYER,
                "question_id": quiz3["q2"]["id"],
                "selected_option_id": quiz3["q2"]["options"][0]["id"],
                "answer_text": None,
            },
        )
        assert body

        assert retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"]).status_code == 200

    def test_changing_the_ANSWER_KEY_is_still_blocked(self, client, coach_headers, quiz3):
        """Retirement does not unlock grading, and neither does Phase 4C.

        This used to assert that ANY option edit was blocked. Phase 4C allows
        rewording an option after delivery (the row is mutated in place, so no
        answer is detached), so what belongs here now is the half that stays
        shut: moving which answer is correct.
        """
        start(client, quiz3["code"])
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": quiz3["code"]["id"],
                "player_name": PLAYER,
                "question_id": quiz3["q2"]["id"],
                "selected_option_id": quiz3["q2"]["options"][0]["id"],
                "answer_text": None,
            },
        )

        blocked = client.patch(
            f"/api/quizzes/{quiz3['id']}/questions/{quiz3['q2']['id']}",
            json={
                "options": [
                    {"option_text": "Right", "is_correct_answer": False},
                    {"option_text": "Wrong", "is_correct_answer": True},
                ]
            },
            headers=coach_headers,
        )
        assert blocked.status_code == 422
        assert blocked.get_json()["reason"] == "correct_answer_change_blocked"


# ---------------------------------------------------------------------------
# Scoring and Phase 3 exclusions stay independent
# ---------------------------------------------------------------------------


class TestIndependentOfScoring:
    def submit_all(self, client, code, questions, player=PLAYER, correct=True):
        return client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": player,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": q["options"][0 if correct else 1]["id"],
                        "answer_text": None,
                    }
                    for q in questions
                ],
            },
        )

    def test_stopping_a_question_does_not_change_an_existing_grade(
        self, client, coach_headers, quiz3
    ):
        """RETIREMENT IS NOT EXCLUSION. A player who answered it keeps that
        answer, that grade, and that denominator until the coach separately
        says otherwise.

        Asserted over the coach's response payload because the player results
        endpoint carries no score - the grades themselves are the scoring
        input, so proving they are untouched proves the score is.
        """
        body = start(client, quiz3["code"]).get_json()
        self.submit_all(client, quiz3["code"], body["questions"])

        def grades():
            responses = client.get(
                f"/api/quizzes/{quiz3['id']}/responses", headers=coach_headers
            ).get_json()
            return {
                (a["question_id"], a["is_correct"]) for a in responses[0]["answers"]
            }

        before = grades()

        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        assert grades() == before
        assert any(qid == quiz3["q2"]["id"] for qid, _ in before), "it was graded"

    def test_a_stopped_question_is_not_marked_excluded(self, client, coach_headers, quiz3):
        """The two states are reported separately, so a coach can tell which
        decision they actually made."""
        body = start(client, quiz3["code"]).get_json()
        self.submit_all(client, quiz3["code"], body["questions"])
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        results = client.post(
            "/api/play/results",
            json={"code": quiz3["code"]["code"], "player_name": PLAYER},
        ).get_json()
        row = next(a for a in results["answers"] if a["question_id"] == quiz3["q2"]["id"])
        assert row["is_excluded"] is False


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------


class TestActivation:
    def test_activation_refuses_when_every_question_is_stopped(
        self, client, coach_headers, quiz3
    ):
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        refused = activate(client, coach_headers, quiz3["id"])

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "no_deliverable_questions"

    def test_the_refusal_does_not_claim_the_quiz_is_empty(
        self, client, coach_headers, quiz3
    ):
        """The questions are right there in the editor - telling the coach
        there are none would send them looking for content they can see."""
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        message = activate(client, coach_headers, quiz3["id"]).get_json()["error"]

        assert "no questions" not in message.lower()
        assert "stopped" in message.lower()

    def test_activation_still_works_with_one_deliverable_question(
        self, client, coach_headers, quiz3
    ):
        retire(client, coach_headers, quiz3["id"], quiz3["q1"]["id"])
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        assert activate(client, coach_headers, quiz3["id"]).status_code == 201

    def test_a_stopped_BROKEN_question_no_longer_blocks_activation(
        self, app, client, coach_headers
    ):
        """A Draw Response question with no image is unanswerable - but if no
        future player will ever receive it, it is not a reason to refuse."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Broken"}, headers=coach_headers
        ).get_json()
        good = _q(client, coach_headers, quiz["id"], "Fine question")
        broken = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Draw it", "question_type": "draw_response", "options": []},
            headers=coach_headers,
        ).get_json()
        assert good
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )

        assert activate(client, coach_headers, quiz["id"]).status_code == 422

        retire(client, coach_headers, quiz["id"], broken["id"])

        assert activate(client, coach_headers, quiz["id"]).status_code == 201

    def test_activation_error_numbering_counts_only_deliverable_questions(
        self, client, coach_headers
    ):
        """"Question 2 needs an image" has to mean the second question a
        future player actually receives - not the second row in the editor."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Numbering"}, headers=coach_headers
        ).get_json()
        first = _q(client, coach_headers, quiz["id"], "Q1")
        second = _q(client, coach_headers, quiz["id"], "Q2")
        broken = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Draw it", "question_type": "draw_response", "options": []},
            headers=coach_headers,
        ).get_json()
        assert first and broken

        # With everything deliverable the broken one is #3.
        refused = activate(client, coach_headers, quiz["id"]).get_json()
        assert refused["details"]["questions_needing_images"] == [3]

        # Stop Q2, and the broken question becomes the SECOND thing delivered.
        retire(client, coach_headers, quiz["id"], second["id"])

        refused = activate(client, coach_headers, quiz["id"]).get_json()
        assert refused["details"]["questions_needing_images"] == [2]


# ---------------------------------------------------------------------------
# /play/start protection - activation alone is not enough
# ---------------------------------------------------------------------------


class TestZeroQuestionAttempt:
    def test_start_refuses_when_everything_was_stopped_after_activation(
        self, client, coach_headers, quiz3
    ):
        """The code was activated while questions were deliverable. Nothing
        revokes it, so /play/start has to hold this line itself."""
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        refused = start(client, quiz3["code"])

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "no_deliverable_questions"

    def test_no_attempt_row_is_created(self, app, client, coach_headers, quiz3):
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        start(client, quiz3["code"])

        with app.app_context():
            assert PlayerAttempt.query.count() == 0

    def test_it_does_NOT_fall_through_to_the_legacy_path(
        self, app, client, coach_headers, quiz3
    ):
        """THE HAZARD THIS EXISTS FOR. `delivered_questions()` reads "zero
        snapshot rows" as "pre-Phase-1 attempt" and falls back to the LIVE
        quiz. A zero-question attempt would therefore have rendered the live
        quiz WITH the stopped questions in it - the exact opposite of what was
        asked for. Refusing to create one keeps "zero rows = legacy" true."""
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        refused = start(client, quiz3["code"])

        assert refused.status_code == 422
        assert "questions" not in refused.get_json()

    def test_an_attempt_ALREADY_underway_is_still_resumable(
        self, client, coach_headers, quiz3
    ):
        """The refusal is placed after the resume branch on purpose - a player
        mid-quiz must not be locked out by a decision about future attempts."""
        before = start(client, quiz3["code"]).get_json()
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        resumed = start(client, quiz3["code"])

        assert resumed.status_code == 200
        assert texts(resumed.get_json()) == texts(before)

    def test_the_player_message_names_no_internals(self, client, coach_headers, quiz3):
        for key in ("q1", "q2", "q3"):
            retire(client, coach_headers, quiz3["id"], quiz3[key]["id"])

        message = start(client, quiz3["code"]).get_json()["error"]

        for leaked in ("retired", "retire", "SQL", "None", "null"):
            assert leaked not in message


# ---------------------------------------------------------------------------
# Practice
# ---------------------------------------------------------------------------


class TestPractice:
    @pytest.fixture
    def practice(self, client, coach_headers, quiz3):
        code = activate(
            client, coach_headers, quiz3["id"], mode=PRACTICE, randomize_questions=True
        ).get_json()
        return {**quiz3, "code": code}

    def test_try_again_is_a_NEW_attempt_and_drops_the_stopped_question(
        self, client, coach_headers, practice
    ):
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

        retire(client, coach_headers, practice["id"], practice["q2"]["id"])

        retake = start(client, practice["code"]).get_json()

        assert retake["attempt_id"] != first["attempt_id"]
        assert "Q2 the bad one" not in texts(retake)
        assert "Q2 the bad one" in texts(first)

    def test_the_shuffle_never_includes_a_stopped_question(
        self, client, coach_headers, practice
    ):
        retire(client, coach_headers, practice["id"], practice["q2"]["id"])

        body = start(client, practice["code"]).get_json()

        assert practice["q2"]["id"] not in body["question_order"]
        assert sorted(body["question_order"]) == sorted(
            [practice["q1"]["id"], practice["q3"]["id"]]
        )


# ---------------------------------------------------------------------------
# Duplication - OPTION A, confirmed by the owner
# ---------------------------------------------------------------------------


class TestDuplication:
    def test_the_copy_keeps_the_stopped_state(self, client, coach_headers, quiz3):
        """Silently reactivating a question the coach deliberately stopped
        would put that exact question back in front of players."""
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        copy = client.post(
            f"/api/quizzes/{quiz3['id']}/duplicate", headers=coach_headers
        ).get_json()

        by_text = {q["question_text"]: q for q in copy["questions"]}
        assert by_text["Q2 the bad one"]["is_retired"] is True
        assert by_text["Q1 keeper"]["is_retired"] is False

    def test_the_copy_still_CONTAINS_the_stopped_question(
        self, client, coach_headers, quiz3
    ):
        """Preserved, not dropped - the content is still there to restore."""
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])

        copy = client.post(
            f"/api/quizzes/{quiz3['id']}/duplicate", headers=coach_headers
        ).get_json()

        assert len(copy["questions"]) == 3

    def test_the_copy_can_be_restored_independently(self, client, coach_headers, quiz3):
        retire(client, coach_headers, quiz3["id"], quiz3["q2"]["id"])
        copy = client.post(
            f"/api/quizzes/{quiz3['id']}/duplicate", headers=coach_headers
        ).get_json()
        copied = next(q for q in copy["questions"] if q["question_text"] == "Q2 the bad one")

        restore(client, coach_headers, copy["id"], copied["id"])

        quiz = client.get(f"/api/quizzes/{quiz3['id']}", headers=coach_headers).get_json()
        original = next(q for q in quiz["questions"] if q["id"] == quiz3["q2"]["id"])
        assert original["is_retired"] is True, "the original is unaffected"


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------


class TestAuthorization:
    def test_retire_requires_authentication(self, client, quiz3):
        assert client.post(
            f"/api/quizzes/{quiz3['id']}/questions/{quiz3['q2']['id']}/retire"
        ).status_code == 401

    def test_restore_requires_authentication(self, client, quiz3):
        assert client.delete(
            f"/api/quizzes/{quiz3['id']}/questions/{quiz3['q2']['id']}/retire"
        ).status_code == 401

    def test_another_organizations_coach_cannot_stop_a_question(
        self, client, register_coach, quiz3
    ):
        _, _, outsider = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )

        blocked = retire(client, outsider, quiz3["id"], quiz3["q2"]["id"])

        assert blocked.status_code in (403, 404)

    def test_a_question_from_another_quiz_is_rejected(self, client, coach_headers, quiz3):
        other = client.post(
            "/api/quizzes", json={"title": "Elsewhere"}, headers=coach_headers
        ).get_json()

        blocked = retire(client, coach_headers, other["id"], quiz3["q2"]["id"])

        assert blocked.status_code == 404

    def test_the_coach_id_comes_from_the_session_not_the_payload(
        self, app, client, coach_headers, quiz3
    ):
        client.post(
            f"/api/quizzes/{quiz3['id']}/questions/{quiz3['q2']['id']}/retire",
            json={"retired_by_coach_id": 999999},
            headers=coach_headers,
        )

        with app.app_context():
            assert db.session.get(Question, quiz3["q2"]["id"]).retired_by_coach_id != 999999


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


class TestQueryCost:
    def test_the_filter_itself_issues_no_query(self, app, client, coach_headers):
        """`deliverable_questions` reads the already-loaded relationship rather
        than issuing its own SELECT, so retirement adds no per-question cost to
        the hottest player route.

        Measured directly rather than through /play/start. A FRESH start writes
        one snapshot row per question by design, so its total query count is
        legitimately O(n) - a scale-invariant assertion there would be
        measuring the snapshot writes, not this filter, and would fail for a
        reason that is not a bug. (It did, which is how this test got written
        this way.)
        """
        from sqlalchemy import event

        from app.models import Quiz
        from app.services.attempts import deliverable_questions

        quiz_id = client.post(
            "/api/quizzes", json={"title": "Cost"}, headers=coach_headers
        ).get_json()["id"]
        for i in range(15):
            _q(client, coach_headers, quiz_id, f"Q{i}")
        retire(
            client,
            coach_headers,
            quiz_id,
            client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()[
                "questions"
            ][3]["id"],
        )

        with app.app_context():
            quiz = db.session.get(Quiz, quiz_id)
            # Force the relationship to load OUTSIDE the measured window - the
            # filter is what is being measured, not the load it depends on.
            assert len(quiz.questions) == 15

            queries = []

            def listener(conn, cursor, statement, parameters, context, executemany):
                queries.append(statement)

            event.listen(db.engine, "before_cursor_execute", listener)
            try:
                deliverable = deliverable_questions(quiz)
            finally:
                event.remove(db.engine, "before_cursor_execute", listener)

            assert len(deliverable) == 14
            assert queries == [], f"filtering issued {len(queries)} queries"
