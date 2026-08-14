"""Delivered-question snapshots - Phase 1: WRITE + PRESERVE.

Three properties are being proved here, and they are not the same property:

1. **Complete.** Every question an attempt was delivered gets a row, including
   ones the player never answered - because exclusion (a later phase) changes
   the DENOMINATOR, and the denominator counts unanswered questions.
2. **Historical.** A snapshot is written once and never rewritten. A coach
   editing the live question afterwards must not change what the record says a
   player was shown.
3. **Durable.** A snapshot that points at a stored image must keep pointing at
   real bytes, even after the coach replaces or deletes that image - and when
   that cannot be guaranteed, the coach's destructive operation FAILS rather
   than destroying the evidence.

Phase 1 ships with zero user-visible change, so the last class here asserts
what must NOT have moved.
"""

import pytest

from app.extensions import db
from app.models import (
    Answer,
    AttemptQuestionSnapshot,
    PlayerAttempt,
    Question,
    QuestionOption,
    QuestionType,
    Quiz,
)
from app.models.assessment_mode import PRACTICE
from app.services.file_storage import StorageError, get_file_storage
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
OTHER_PLAYER = "Alex Lee"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def build_quiz(client, headers, *, count=3, title="Install"):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    questions = []
    for index in range(count):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Question {index + 1}",
                "question_type": "true_false",
                "answer_explanation": f"Because of reason {index + 1}",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
            },
            headers=headers,
        )
        assert response.status_code == 201, response.get_json()
        questions.append(response.get_json())
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER_PLAYER]},
        headers=headers,
    )
    return quiz, questions


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


def start(client, access_code_id, player_name=PLAYER):
    return client.post(
        "/api/play/start",
        json={"access_code_id": access_code_id, "player_name": player_name},
    )


def upload_image(client, headers, quiz_id, question_id, name="play.png", size=(20, 20)):
    # `size` is the test seam that makes one upload's bytes distinguishable
    # from another's - make_image_file paints a flat colour, so two same-sized
    # uploads compress to byte-identical JPEGs and "the copy holds the right
    # picture" would pass without meaning anything.
    buffer, filename = make_image_file(name, size)
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=headers,
    )
    return response


def snapshots_for(attempt_id):
    return (
        AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt_id)
        .order_by(AttemptQuestionSnapshot.position)
        .all()
    )


# ---------------------------------------------------------------------------
# 1. Complete: written at /play/start, for everything delivered
# ---------------------------------------------------------------------------


class TestCaptureAtStart:
    def test_start_records_one_snapshot_per_delivered_question(
        self, app, client, coach_headers
    ):
        quiz, questions = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        response = start(client, code["id"])
        assert response.status_code == 201

        with app.app_context():
            rows = snapshots_for(response.get_json()["attempt_id"])
            assert [row.question_id for row in rows] == [q["id"] for q in questions]
            assert [row.position for row in rows] == [0, 1, 2]

    def test_a_question_the_player_never_answers_is_still_snapshotted(
        self, app, client, coach_headers
    ):
        """THE REASON THIS IS A SIBLING TABLE. An unanswered question has no
        Answer row at all, so a snapshot living on `answers` could not describe
        it - and a skipped question is exactly what a later exclusion has to be
        able to talk about."""
        quiz, questions = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": questions[0]["id"],
                "selected_option_id": questions[0]["options"][0]["id"],
                "answer_text": None,
            },
        )

        with app.app_context():
            answered = {a.question_id for a in Answer.query.filter_by(attempt_id=attempt_id)}
            assert answered == {questions[0]["id"]}

            snapshotted = {row.question_id for row in snapshots_for(attempt_id)}
            assert snapshotted == {q["id"] for q in questions}

    def test_resuming_an_attempt_does_not_snapshot_it_again(
        self, app, client, coach_headers
    ):
        quiz, questions = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        first = start(client, code["id"])
        second = start(client, code["id"])
        assert first.status_code == 201
        assert second.status_code == 200

        with app.app_context():
            assert len(snapshots_for(first.get_json()["attempt_id"])) == len(questions)
            assert AttemptQuestionSnapshot.query.count() == len(questions)

    def test_each_player_gets_their_own_delivery_record(self, app, client, coach_headers):
        quiz, questions = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        one = start(client, code["id"], PLAYER).get_json()["attempt_id"]
        two = start(client, code["id"], OTHER_PLAYER).get_json()["attempt_id"]

        with app.app_context():
            assert len(snapshots_for(one)) == len(questions)
            assert len(snapshots_for(two)) == len(questions)
            assert AttemptQuestionSnapshot.query.count() == 2 * len(questions)

    def test_a_practice_retake_records_its_own_delivery(self, app, client, coach_headers):
        """Practice is unlimited, so each retake is a separate attempt - and
        each one was delivered separately."""
        quiz, questions = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)

        first = start(client, code["id"]).get_json()["attempt_id"]
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": question["options"][0]["id"],
                        "answer_text": None,
                    }
                    for question in questions
                ],
            },
        )
        assert submitted.status_code == 201, submitted.get_json()

        second = start(client, code["id"]).get_json()["attempt_id"]
        assert second != first

        with app.app_context():
            assert len(snapshots_for(first)) == len(questions)
            assert len(snapshots_for(second)) == len(questions)

    def test_position_records_the_order_the_player_actually_saw(
        self, app, client, coach_headers, monkeypatch
    ):
        """A randomized practice attempt disagrees with the quiz's authored
        order. `position` is the delivered one, not questions.position."""
        import random

        from app.services import attempts as attempts_service

        quiz, questions = build_quiz(client, coach_headers, count=6)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE, randomize=True)

        original = attempts_service.frozen_question_order
        monkeypatch.setattr(
            "app.routes.play.frozen_question_order",
            lambda quiz_, randomize: original(
                quiz_, randomize=randomize, rng=random.Random(1234)
            ),
        )

        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            attempt = db.session.get(PlayerAttempt, attempt_id)
            frozen = attempt.question_order
            assert frozen is not None
            authored = [q["id"] for q in questions]
            assert frozen != authored, "the seeded shuffle needs to actually reorder"

            rows = snapshots_for(attempt_id)
            assert [row.question_id for row in rows] == frozen
            assert [row.position for row in rows] == list(range(len(frozen)))


# ---------------------------------------------------------------------------
# 2. Contents: the minimum trustworthy set, and nothing more
# ---------------------------------------------------------------------------


class TestSnapshotContents:
    def test_it_records_the_text_type_and_options_with_correctness(
        self, app, client, coach_headers
    ):
        quiz, questions = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            snapshot = snapshots_for(attempt_id)[0].snapshot
            assert snapshot["question_text"] == "Question 1"
            assert snapshot["question_type"] == "true_false"
            assert snapshot["options"] == [
                {
                    "id": questions[0]["options"][0]["id"],
                    "text": "True",
                    "is_correct_answer": True,
                },
                {
                    "id": questions[0]["options"][1]["id"],
                    "text": "False",
                    "is_correct_answer": False,
                },
            ]

    def test_it_is_stamped_with_a_version(self, app, client, coach_headers):
        """So a future reader can tell an old shape from a new one without
        sniffing which keys happen to be present."""
        from app.services.question_snapshots import SNAPSHOT_VERSION

        quiz, _ = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            assert snapshots_for(attempt_id)[0].snapshot["version"] == SNAPSHOT_VERSION

    def test_it_never_records_the_answer_explanation(self, app, client, coach_headers):
        """Post-answer teaching material, already freely editable by design.
        Freezing it would make a coach's better explanation invisible to the
        players who needed it."""
        quiz, _ = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            snapshot = snapshots_for(attempt_id)[0].snapshot
            assert "answer_explanation" not in snapshot
            assert "Because of reason" not in str(snapshot)

    def test_it_records_expected_answers_and_the_matching_mode(
        self, app, client, coach_headers
    ):
        """What a typed answer was graded against IS the correct answer for a
        Fill in the Blank question.

        Built directly rather than through the API: a FILL_BLANK question is
        authored from a playbook region, and dragging a source document into
        this test would prove nothing about the snapshot.
        """
        from app.services.question_snapshots import build_snapshot

        quiz, _ = build_quiz(client, coach_headers, count=1)

        with app.app_context():
            question = Question(
                quiz_id=quiz["id"],
                question_text="Name the coverage",
                question_type=QuestionType.FILL_BLANK,
                position=1,
                expected_answers=["Cover 3", "C3"],
                answer_matching="exact",
            )
            db.session.add(question)
            db.session.commit()

            snapshot = build_snapshot(question)

        assert snapshot["question_type"] == "fill_blank"
        assert snapshot["expected_answers"] == ["Cover 3", "C3"]
        assert snapshot["answer_matching"] == "exact"

    def test_an_optionless_type_records_no_options_even_if_inert_rows_survive(
        self, app, client, coach_headers
    ):
        """A Draw Response converted from multiple choice keeps its old option
        rows (migration d2b5f8a41c32). Recording them would claim the player
        was offered choices they never saw."""
        from app.services.question_snapshots import build_snapshot

        quiz, _ = build_quiz(client, coach_headers, count=1)

        with app.app_context():
            question = Question(
                quiz_id=quiz["id"],
                question_text="Draw the route",
                question_type=QuestionType.DRAW_RESPONSE,
                position=1,
            )
            question.options.append(
                QuestionOption(option_text="Left", is_correct_answer=True, position=0)
            )
            db.session.add(question)
            db.session.commit()

            assert question.options, "the inert rows must actually exist"
            assert build_snapshot(question)["options"] == []

    def test_it_records_the_image_with_its_coordinate_space_and_annotations(
        self, app, client, coach_headers
    ):
        """`annotations` are coordinates in the space `canvas_width` names,
        against that specific image. The three travel together or none of them
        mean anything."""
        quiz, questions = build_quiz(client, coach_headers, count=1)
        question_id = questions[0]["id"]
        image = upload_image(client, coach_headers, quiz["id"], question_id)
        assert image.status_code == 201, image.get_json()
        image_url = image.get_json()["image_url"]

        annotations = [{"type": "arrow", "x": 10, "y": 20}]
        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question_id}/image/annotations",
            json={"annotations": annotations, "canvas_width": 900},
            headers=coach_headers,
        )

        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            snapshot = snapshots_for(attempt_id)[0].snapshot
            assert snapshot["image"] == {
                "image_url": image_url,
                "canvas_width": 900,
                "annotations": annotations,
            }

    def test_a_question_with_no_image_records_none(self, app, client, coach_headers):
        quiz, _ = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        with app.app_context():
            assert snapshots_for(attempt_id)[0].snapshot["image"] is None


# ---------------------------------------------------------------------------
# 3. Historical: written once, never rewritten
# ---------------------------------------------------------------------------


class TestItIsAHistoricalRecord:
    @pytest.fixture
    def delivered(self, client, coach_headers):
        quiz, questions = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]
        return quiz, questions[0], code, attempt_id

    def test_editing_the_question_text_afterwards_does_not_rewrite_the_snapshot(
        self, app, client, coach_headers, delivered
    ):
        quiz, question, _, attempt_id = delivered

        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"question_text": "Completely different question"},
            headers=coach_headers,
        )

        with app.app_context():
            assert snapshots_for(attempt_id)[0].snapshot["question_text"] == "Question 1"
            assert db.session.get(Question, question["id"]).question_text == (
                "Completely different question"
            )

    def test_editing_the_explanation_afterwards_does_not_rewrite_the_snapshot(
        self, app, client, coach_headers, delivered
    ):
        quiz, question, _, attempt_id = delivered

        with app.app_context():
            before = snapshots_for(attempt_id)[0].snapshot

        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"answer_explanation": "A much better explanation"},
            headers=coach_headers,
        )

        with app.app_context():
            assert snapshots_for(attempt_id)[0].snapshot == before

    def test_re_annotating_the_image_afterwards_does_not_rewrite_the_snapshot(
        self, app, client, coach_headers
    ):
        quiz, questions = build_quiz(client, coach_headers, count=1)
        question_id = questions[0]["id"]
        upload_image(client, coach_headers, quiz["id"], question_id)
        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question_id}/image/annotations",
            json={"annotations": [{"type": "arrow"}], "canvas_width": 900},
            headers=coach_headers,
        )
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question_id}/image/annotations",
            json={"annotations": [{"type": "circle"}], "canvas_width": 1200},
            headers=coach_headers,
        )

        with app.app_context():
            image = snapshots_for(attempt_id)[0].snapshot["image"]
            assert image["annotations"] == [{"type": "arrow"}]
            assert image["canvas_width"] == 900


# ---------------------------------------------------------------------------
# 4. No backfill
# ---------------------------------------------------------------------------


class TestNoBackfill:
    def test_an_attempt_that_predates_the_table_stays_empty(
        self, app, client, coach_headers
    ):
        """Manufacturing snapshots from today's questions would create false
        history. A legacy attempt reads honestly as "delivered content not
        recorded" - and nothing later fills it in."""
        quiz, questions = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        # Make it look like an attempt from before this table existed.
        with app.app_context():
            AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt_id).delete()
            db.session.commit()

        # Everything a player does from here still works, and none of it
        # invents a record.
        assert start(client, code["id"]).status_code == 200
        assert (
            client.post(
                "/api/play/answers",
                json={
                    "access_code_id": code["id"],
                    "player_name": PLAYER,
                    "question_id": questions[0]["id"],
                    "selected_option_id": questions[0]["options"][0]["id"],
                    "answer_text": None,
                },
            ).status_code
            == 204
        )
        assert (
            client.post(
                "/api/play/submit",
                json={
                    "access_code_id": code["id"],
                    "player_name": PLAYER,
                    "answers": [
                        {
                            "question_id": questions[0]["id"],
                            "selected_option_id": questions[0]["options"][0]["id"],
                            "answer_text": None,
                        }
                    ],
                },
            ).status_code
            == 201
        )

        with app.app_context():
            assert snapshots_for(attempt_id) == []

    def test_the_migration_creates_no_rows(self):
        """A grep-level guard: the migration is additive only. An INSERT in it
        would be a backfill by another name."""
        from pathlib import Path

        source = Path(__file__).resolve().parents[1] / "migrations" / "versions"
        migration = next(source.glob("*_add_attempt_question_snapshots.py"))
        text = migration.read_text(encoding="utf-8").lower()
        for forbidden in ("insert", "bulk_insert", "op.execute"):
            assert forbidden not in text, f"the migration references {forbidden}"


# ---------------------------------------------------------------------------
# 5. A start that cannot be recorded is not a start
# ---------------------------------------------------------------------------


class TestFailureRollsBackTheStart:
    def test_a_failed_snapshot_rolls_the_whole_attempt_back(
        self, app, client, coach_headers, monkeypatch
    ):
        """A NEW attempt must never become "legacy" because a write failed -
        there is no backfill that could tell the difference later."""
        from app.routes import play as play_route

        quiz, _ = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])

        def boom(attempt):
            raise RuntimeError("snapshot storage unavailable")

        monkeypatch.setattr(play_route, "capture_attempt_snapshots", boom)

        response = start(client, code["id"])

        assert response.status_code == 500
        assert response.get_json()["reason"] == "attempt_not_recorded"

        with app.app_context():
            db.session.rollback()
            assert PlayerAttempt.query.count() == 0
            assert AttemptQuestionSnapshot.query.count() == 0

    def test_the_player_can_start_normally_once_the_failure_clears(
        self, app, client, coach_headers, monkeypatch
    ):
        """The failed start must leave nothing behind that blocks a retry -
        no half-made attempt for the unique index to collide with."""
        from app.routes import play as play_route

        quiz, questions = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])

        def boom(attempt):
            raise RuntimeError("transient")

        monkeypatch.setattr(play_route, "capture_attempt_snapshots", boom)
        assert start(client, code["id"]).status_code == 500
        monkeypatch.undo()

        retried = start(client, code["id"])
        assert retried.status_code == 201

        with app.app_context():
            rows = snapshots_for(retried.get_json()["attempt_id"])
            assert [row.question_id for row in rows] == [q["id"] for q in questions]

    def test_a_partial_snapshot_is_never_committed(self, app, client, coach_headers, monkeypatch):
        """Failing on the SECOND question must not leave the first one behind -
        a partially recorded attempt is indistinguishable, forever, from one
        that predates the table."""
        from app.services import question_snapshots

        quiz, _ = build_quiz(client, coach_headers, count=3)
        code = activate(client, coach_headers, quiz["id"])

        real_build = question_snapshots.build_snapshot
        calls = {"n": 0}

        def failing_build(question):
            calls["n"] += 1
            if calls["n"] == 2:
                raise question_snapshots.SnapshotError("could not read question")
            return real_build(question)

        monkeypatch.setattr(question_snapshots, "build_snapshot", failing_build)

        assert start(client, code["id"]).status_code == 500

        with app.app_context():
            db.session.rollback()
            assert AttemptQuestionSnapshot.query.count() == 0
            assert PlayerAttempt.query.count() == 0


# ---------------------------------------------------------------------------
# 6. Historical image preservation
# ---------------------------------------------------------------------------


class TestHistoricalImagePreservation:
    """The Duplicate Quiz bug in a different costume.

    `_reject_if_already_answered` does not guard the image routes, so a coach
    replacing or deleting an image after delivery used to physically destroy
    the object every snapshot of that delivery points at.
    """

    @pytest.fixture
    def delivered_image(self, app, client, coach_headers):
        """A quiz whose one question has an image, delivered to one player."""
        quiz, questions = build_quiz(client, coach_headers, count=1)
        question_id = questions[0]["id"]
        image = upload_image(client, coach_headers, quiz["id"], question_id)
        assert image.status_code == 201, image.get_json()
        original_url = image.get_json()["image_url"]

        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]
        return {
            "quiz_id": quiz["id"],
            "question_id": question_id,
            "original_url": original_url,
            "attempt_id": attempt_id,
            "code": code,
        }

    def test_replacing_a_delivered_image_moves_the_snapshot_onto_a_copy(
        self, app, client, coach_headers, delivered_image
    ):
        with app.app_context():
            original_bytes = get_file_storage().load_image_bytes(
                delivered_image["original_url"]
            )
            assert original_bytes is not None

        response = upload_image(
            client,
            coach_headers,
            delivered_image["quiz_id"],
            delivered_image["question_id"],
            name="replacement.png",
            size=(32, 32),
        )
        assert response.status_code == 201
        new_live_url = response.get_json()["image_url"]

        with app.app_context():
            storage = get_file_storage()
            preserved_url = snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ]

            # The snapshot moved to its own object...
            assert preserved_url not in (delivered_image["original_url"], new_live_url)
            # ...which holds the bytes the player was actually shown...
            assert storage.load_image_bytes(preserved_url) == original_bytes
            # ...while the live question shows the replacement, and the old
            # object is gone (it is superseded, and now unreferenced).
            assert db.session.get(Question, delivered_image["question_id"]).image.image_url == (
                new_live_url
            )
            assert storage.load_image_bytes(delivered_image["original_url"]) is None

    def test_deleting_a_delivered_image_preserves_it_for_the_snapshot(
        self, app, client, coach_headers, delivered_image
    ):
        with app.app_context():
            original_bytes = get_file_storage().load_image_bytes(
                delivered_image["original_url"]
            )

        response = client.delete(
            f"/api/quizzes/{delivered_image['quiz_id']}/questions/"
            f"{delivered_image['question_id']}/image",
            headers=coach_headers,
        )
        assert response.status_code == 204

        with app.app_context():
            storage = get_file_storage()
            preserved_url = snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ]
            assert preserved_url != delivered_image["original_url"]
            assert storage.load_image_bytes(preserved_url) == original_bytes
            assert db.session.get(Question, delivered_image["question_id"]).image is None

    def test_deleting_a_delivered_but_unanswered_question_preserves_its_image(
        self, app, client, coach_headers, delivered_image
    ):
        """ANSWERED is not the same as DELIVERED. The edit lock only fires once
        a player has an Answer row, so a delivered-and-skipped question can
        still be deleted - and used to take its image with it."""
        with app.app_context():
            assert Answer.query.count() == 0, "the point is that nobody answered"
            original_bytes = get_file_storage().load_image_bytes(
                delivered_image["original_url"]
            )

        response = client.delete(
            f"/api/quizzes/{delivered_image['quiz_id']}/questions/"
            f"{delivered_image['question_id']}",
            headers=coach_headers,
        )
        assert response.status_code == 204

        with app.app_context():
            rows = snapshots_for(delivered_image["attempt_id"])
            assert len(rows) == 1
            # The question is gone; the record of what it WAS is not.
            assert rows[0].question_id is None
            assert rows[0].snapshot["question_text"] == "Question 1"
            preserved_url = rows[0].snapshot["image"]["image_url"]
            assert get_file_storage().load_image_bytes(preserved_url) == original_bytes

    def test_an_undelivered_image_is_simply_deleted_with_no_copy(
        self, app, client, coach_headers
    ):
        """The cost is paid only when a coach edits a DELIVERED image. A
        question nobody has been shown copies nothing."""
        quiz, questions = build_quiz(client, coach_headers, count=1)
        original_url = upload_image(
            client, coach_headers, quiz["id"], questions[0]["id"]
        ).get_json()["image_url"]

        with app.app_context():
            before = _stored_object_count(app)

        response = client.delete(
            f"/api/quizzes/{quiz['id']}/questions/{questions[0]['id']}/image",
            headers=coach_headers,
        )
        assert response.status_code == 204

        with app.app_context():
            assert get_file_storage().load_image_bytes(original_url) is None
            assert _stored_object_count(app) == before - 1

    def test_every_affected_attempt_lands_on_the_same_single_copy(
        self, app, client, coach_headers, delivered_image
    ):
        """One copy serves every affected snapshot. Copying per snapshot could
        leave some attempts on the old asset and some on a copy - one of the
        four states this must never reach."""
        start(client, delivered_image["code"]["id"], OTHER_PLAYER)

        with app.app_context():
            before = _stored_object_count(app)

        upload_image(
            client,
            coach_headers,
            delivered_image["quiz_id"],
            delivered_image["question_id"],
            name="replacement.png",
            size=(32, 32),
        )

        with app.app_context():
            urls = {
                row.snapshot["image"]["image_url"]
                for row in AttemptQuestionSnapshot.query.all()
            }
            assert len(urls) == 1
            assert urls != {delivered_image["original_url"]}
            # original replaced by (one copy + one replacement) = net +1
            assert _stored_object_count(app) == before + 1

    def test_a_second_replacement_leaves_the_earlier_copy_alone(
        self, app, client, coach_headers, delivered_image
    ):
        """A snapshot already moved to a copy is already safe. Repointing it
        again would abandon a perfectly good object."""
        upload_image(
            client,
            coach_headers,
            delivered_image["quiz_id"],
            delivered_image["question_id"],
            name="second.png",
            size=(32, 32),
        )
        with app.app_context():
            preserved_url = snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ]
            preserved_bytes = get_file_storage().load_image_bytes(preserved_url)
            before = _stored_object_count(app)

        upload_image(
            client,
            coach_headers,
            delivered_image["quiz_id"],
            delivered_image["question_id"],
            name="third.png",
            size=(48, 48),
        )

        with app.app_context():
            after_url = snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ]
            assert after_url == preserved_url
            assert get_file_storage().load_image_bytes(after_url) == preserved_bytes
            # No second copy was made - only the live object turned over.
            assert _stored_object_count(app) == before

    def test_a_failed_copy_refuses_the_edit_rather_than_destroying_evidence(
        self, app, client, coach_headers, delivered_image, monkeypatch
    ):
        """Same philosophy as the duplicate fix: when history cannot be
        preserved, the COACH'S destructive operation fails."""
        with app.app_context():
            original_bytes = get_file_storage().load_image_bytes(
                delivered_image["original_url"]
            )

        class Failing:
            def __getattr__(self, name):
                return getattr(get_file_storage(), name)

            def copy_image(self, image_url):
                raise StorageError("bucket unavailable")

        monkeypatch.setattr("app.routes.questions.get_file_storage", lambda: Failing())

        response = client.delete(
            f"/api/quizzes/{delivered_image['quiz_id']}/questions/"
            f"{delivered_image['question_id']}/image",
            headers=coach_headers,
        )

        assert response.status_code == 502
        assert response.get_json()["reason"] == "image_preservation_failed"

        monkeypatch.undo()
        with app.app_context():
            db.session.rollback()
            storage = get_file_storage()
            # Nothing was destroyed and nothing was repointed.
            assert storage.load_image_bytes(delivered_image["original_url"]) == original_bytes
            assert snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ] == delivered_image["original_url"]
            live = db.session.get(Question, delivered_image["question_id"]).image
            assert live is not None
            assert live.image_url == delivered_image["original_url"]

    def test_a_database_failure_after_copying_removes_the_orphan_copy(
        self, app, client, coach_headers, delivered_image, monkeypatch
    ):
        """A rollback that left the copy behind would leak one object per
        failed edit, invisibly, forever - and the original must survive, since
        the transaction it was being superseded in never landed."""
        created: list[str] = []

        class Tracking:
            def __getattr__(self, name):
                return getattr(get_file_storage(), name)

            def copy_image(self, image_url):
                url = get_file_storage().copy_image(image_url)
                created.append(url)
                return url

        def boom():
            raise RuntimeError("db died")

        monkeypatch.setattr("app.routes.questions.get_file_storage", lambda: Tracking())
        monkeypatch.setattr(db.session, "commit", boom)

        response = client.delete(
            f"/api/quizzes/{delivered_image['quiz_id']}/questions/"
            f"{delivered_image['question_id']}/image",
            headers=coach_headers,
        )
        assert response.status_code == 500

        monkeypatch.undo()
        with app.app_context():
            db.session.rollback()
            storage = get_file_storage()
            assert created, "the test needs a copy to have happened"
            for url in created:
                assert storage.load_image_bytes(url) is None
            # The original survives, still referenced by both the live question
            # and the snapshot.
            assert storage.load_image_bytes(delivered_image["original_url"]) is not None
            assert snapshots_for(delivered_image["attempt_id"])[0].snapshot["image"][
                "image_url"
            ] == delivered_image["original_url"]
            assert db.session.get(Question, delivered_image["question_id"]).image is not None

    def test_the_superseded_object_is_only_removed_after_the_commit(
        self, app, client, coach_headers, delivered_image, monkeypatch
    ):
        """Ordering, stated as its own test, because it is the property the
        whole design rests on: copy, then commit, and ONLY THEN unlink. The
        code this replaces unlinked first."""
        events: list[str] = []
        real_commit = db.session.commit

        class Watching:
            def __getattr__(self, name):
                return getattr(get_file_storage(), name)

            def copy_image(self, image_url):
                events.append("copy")
                return get_file_storage().copy_image(image_url)

            def delete_image(self, image_url):
                events.append(f"delete:{image_url}")
                return get_file_storage().delete_image(image_url)

        def watched_commit():
            events.append("commit")
            return real_commit()

        monkeypatch.setattr("app.routes.questions.get_file_storage", lambda: Watching())
        monkeypatch.setattr(db.session, "commit", watched_commit)

        response = client.delete(
            f"/api/quizzes/{delivered_image['quiz_id']}/questions/"
            f"{delivered_image['question_id']}/image",
            headers=coach_headers,
        )
        assert response.status_code == 204

        assert events == [
            "copy",
            "commit",
            f"delete:{delivered_image['original_url']}",
        ]


def _stored_object_count(app) -> int:
    """How many objects local storage currently holds. Local-disk only, which
    is what the test config uses."""
    from pathlib import Path

    folder = Path(app.config["UPLOAD_FOLDER"])
    if not folder.exists():
        return 0
    return len([p for p in folder.iterdir() if p.is_file()])


# ---------------------------------------------------------------------------
# 7. Lifetime
# ---------------------------------------------------------------------------


class TestLifetime:
    def test_resetting_an_attempt_takes_its_delivery_record_with_it(
        self, app, client, coach_headers
    ):
        """A reset deletes the attempt outright. Its snapshot describes THAT
        attempt and means nothing without it."""
        quiz, _ = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        response = client.delete(
            f"/api/quizzes/{quiz['id']}/attempts/{attempt_id}", headers=coach_headers
        )
        assert response.status_code == 204

        with app.app_context():
            assert AttemptQuestionSnapshot.query.count() == 0

    def test_deleting_the_quiz_takes_every_snapshot_with_it(
        self, app, client, coach_headers
    ):
        quiz, _ = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code["id"])

        response = client.delete(f"/api/quizzes/{quiz['id']}", headers=coach_headers)
        assert response.status_code == 204

        with app.app_context():
            assert AttemptQuestionSnapshot.query.count() == 0
            assert Quiz.query.count() == 0

    def test_a_deleted_question_leaves_its_snapshot_readable(
        self, app, client, coach_headers
    ):
        """ON DELETE SET NULL, not CASCADE. The whole point is to outlive the
        question."""
        quiz, questions = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        response = client.delete(
            f"/api/quizzes/{quiz['id']}/questions/{questions[0]['id']}", headers=coach_headers
        )
        assert response.status_code == 204

        with app.app_context():
            rows = snapshots_for(attempt_id)
            assert len(rows) == 2
            orphaned = next(row for row in rows if row.question_id is None)
            assert orphaned.snapshot["question_text"] == "Question 1"
            assert orphaned.snapshot["options"][0]["is_correct_answer"] is True

    def test_two_questions_deleted_after_delivery_both_survive(
        self, app, client, coach_headers
    ):
        """Postgres treats NULLs as distinct in the unique constraint, which is
        REQUIRED here: two deleted questions both land on question_id NULL for
        the same attempt."""
        quiz, questions = build_quiz(client, coach_headers, count=3)
        code = activate(client, coach_headers, quiz["id"])
        attempt_id = start(client, code["id"]).get_json()["attempt_id"]

        for question in questions[:2]:
            assert (
                client.delete(
                    f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
                    headers=coach_headers,
                ).status_code
                == 204
            )

        with app.app_context():
            rows = snapshots_for(attempt_id)
            assert len(rows) == 3
            assert sum(1 for row in rows if row.question_id is None) == 2
            assert {row.snapshot["question_text"] for row in rows} == {
                "Question 1",
                "Question 2",
                "Question 3",
            }


# ---------------------------------------------------------------------------
# 8. Phase 1 ships with ZERO user-visible change
# ---------------------------------------------------------------------------


class TestNothingUserVisibleChanged:
    def test_the_start_payload_says_nothing_about_snapshots(self, client, coach_headers):
        quiz, _ = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])

        body = start(client, code["id"]).get_json()

        assert set(body) == {"attempt_id", "status", "mode", "question_order", "answers", "feedback"}

    def test_scoring_and_results_are_untouched(self, client, coach_headers):
        quiz, questions = build_quiz(client, coach_headers, count=2)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code["id"])
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": questions[0]["id"],
                        "selected_option_id": questions[0]["options"][0]["id"],
                        "answer_text": None,
                    },
                    {
                        "question_id": questions[1]["id"],
                        "selected_option_id": questions[1]["options"][1]["id"],
                        "answer_text": None,
                    },
                ],
            },
        )

        results = client.post(
            "/api/play/results", json={"code": code["code"], "player_name": PLAYER}
        )
        assert results.status_code == 200
        body = results.get_json()
        assert [a["is_correct"] for a in body["answers"]] == [True, False]
        for answer in body["answers"]:
            assert "snapshot" not in answer

    def test_the_edit_lock_still_blocks_changing_an_answered_question(
        self, client, coach_headers
    ):
        """Phase 1 unlocks nothing. Correction is Phase 4."""
        quiz, questions = build_quiz(client, coach_headers, count=1)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code["id"])
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": questions[0]["id"],
                "selected_option_id": questions[0]["options"][0]["id"],
                "answer_text": None,
            },
        )

        blocked = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{questions[0]['id']}",
            json={
                "options": [
                    {"option_text": "True", "is_correct_answer": False},
                    {"option_text": "False", "is_correct_answer": True},
                ]
            },
            headers=coach_headers,
        )
        assert blocked.status_code == 422

        deletion = client.delete(
            f"/api/quizzes/{quiz['id']}/questions/{questions[0]['id']}", headers=coach_headers
        )
        assert deletion.status_code == 422

    def test_competition_mode_is_untouched(self):
        """M2 is frozen. Forward-compatible only - the same table COULD later
        capture at `_freeze_question_order`, and deliberately does not.

        Matched on the identifiers, not on the word "snapshot": competition's
        own code already uses that word for its frozen question list, and a
        bare word match would fire on a comment that has nothing to do with
        this table.
        """
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / "app"
        targets = [root / "routes" / "competition.py"] + sorted(
            (root / "services").glob("competition*.py")
        )
        assert targets
        for path in targets:
            source = path.read_text(encoding="utf-8")
            for forbidden in (
                "AttemptQuestionSnapshot",
                "attempt_question_snapshots",
                "question_snapshots",
                "capture_attempt_snapshots",
            ):
                assert forbidden not in source, f"{path.name} references {forbidden}"
