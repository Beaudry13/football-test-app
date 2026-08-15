"""Phase 4a-bis - THE ATTEMPT VERSION INVARIANT.

    ONCE AN ATTEMPT STARTS, IT STAYS ON THE VERSION IT WAS DELIVERED.
    Coach corrections apply to NEW attempts only.

WHY THIS EXISTS
---------------
Question CONTENT and attempt IDENTITY used to arrive from two different calls,
in that order: `/validate-code` returns the live quiz before the player has
picked a name, and `/play/start` then resumes the attempt and returns only the
order and the saved answers. A refresh mid-quiz therefore re-fetched live
content and rendered version B inside a version-A attempt - the snapshot said
one thing, the player saw another, and an answer could be recorded against an
option the snapshot never contained.

`/play/start` is the first moment the server knows WHICH attempt belongs to the
caller, so that is where the delivered questions are served from.

THE SECURITY HALF is not incidental. That payload goes to a player MID-QUIZ, so
it must never carry the answer key. `to_player_payload` builds a safe shape
rather than filtering an unsafe one, and the tests below inspect the raw
response body rather than trusting the serialiser.
"""

import json

import pytest

from app.extensions import db
from app.models import AttemptQuestionSnapshot, PlayerAttempt, Question
from app.models.assessment_mode import PRACTICE

PLAYER = "Jordan Smith"


def _mc(client, headers, quiz_id, text, right="OLD RIGHT", wrong="OLD WRONG"):
    r = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": right, "is_correct_answer": True},
                {"option_text": wrong, "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def _right(question):
    return next(o["id"] for o in question["options"] if o["is_correct_answer"])


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


@pytest.fixture
def started(client, coach_headers):
    """One attempt, started on version A and left in progress."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Version invariant"}, headers=coach_headers
    ).get_json()
    q1 = _mc(client, coach_headers, quiz["id"], "VERSION A text")
    q2 = _mc(client, coach_headers, quiz["id"], "Second question")
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, "Alex Lee"]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()

    first = start(client, code)
    assert first.status_code == 201
    return {"quiz_id": quiz["id"], "q1": q1, "q2": q2, "code": code, "start": first.get_json()}


def delivered_texts(payload):
    return [q["question_text"] for q in payload["questions"]]


# ---------------------------------------------------------------------------
# 1-4. Text: existing attempt stays on A, new attempt gets B
# ---------------------------------------------------------------------------


class TestTextCorrection:
    def test_start_returns_the_delivered_questions(self, started):
        assert delivered_texts(started["start"]) == ["VERSION A text", "Second question"]

    def test_a_resumed_attempt_still_receives_version_A(self, client, coach_headers, started):
        """THE HEADLINE. A refresh re-runs /validate-code and gets B; /start
        hands back A, and the client renders A."""
        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )

        resumed = start(client, started["code"])
        assert resumed.status_code == 200, "same attempt, resumed"
        assert "VERSION A text" in delivered_texts(resumed.get_json())
        assert "VERSION B text" not in delivered_texts(resumed.get_json())

    def test_validate_code_still_returns_the_LIVE_quiz(self, client, coach_headers, started):
        """Unchanged on purpose: it is identity-free, so it cannot know which
        version to serve. The client prefers /start's copy."""
        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )

        body = client.post(
            "/api/play/validate-code", json={"code": started["code"]["code"]}
        ).get_json()
        assert "VERSION B text" in [q["question_text"] for q in body["quiz"]["questions"]]

    def test_a_NEW_attempt_receives_version_B(self, client, coach_headers, started):
        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )

        fresh = start(client, started["code"], player="Alex Lee")
        assert fresh.status_code == 201
        assert "VERSION B text" in delivered_texts(fresh.get_json())
        assert "VERSION A text" not in delivered_texts(fresh.get_json())


# ---------------------------------------------------------------------------
# 5-8. Options, and the answer that survives
# ---------------------------------------------------------------------------


class TestOptionCorrection:
    def test_a_resumed_attempt_receives_only_its_DELIVERED_option_ids(
        self, client, coach_headers, started
    ):
        """The option-mismatch case, closed by architecture. The player can no
        longer be shown - so cannot submit - an id the snapshot never saw."""
        original = {o["id"] for o in started["start"]["questions"][0]["options"]}

        updated = client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={
                "options": [
                    {"option_text": "NEW RIGHT", "is_correct_answer": True},
                    {"option_text": "NEW WRONG", "is_correct_answer": False},
                ]
            },
            headers=coach_headers,
        )
        assert updated.status_code == 200, "allowed - nobody has answered yet"
        new_ids = {o["id"] for o in updated.get_json()["options"]}
        assert not (original & new_ids), "the edit really did replace the rows"

        resumed = start(client, started["code"]).get_json()
        resumed_ids = {o["id"] for o in resumed["questions"][0]["options"]}
        resumed_text = {o["option_text"] for o in resumed["questions"][0]["options"]}

        assert resumed_ids == original
        assert resumed_text == {"OLD RIGHT", "OLD WRONG"}
        assert "NEW RIGHT" not in resumed_text

    def test_a_new_attempt_receives_the_corrected_options(
        self, client, coach_headers, started
    ):
        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={
                "options": [
                    {"option_text": "NEW RIGHT", "is_correct_answer": True},
                    {"option_text": "NEW WRONG", "is_correct_answer": False},
                ]
            },
            headers=coach_headers,
        )

        fresh = start(client, started["code"], player="Alex Lee").get_json()
        texts = {o["option_text"] for o in fresh["questions"][0]["options"]}
        assert texts == {"NEW RIGHT", "NEW WRONG"}

    def test_a_saved_answer_survives_resume_and_resolves_to_its_delivered_option(
        self, client, coach_headers, started
    ):
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": started["code"]["id"],
                "player_name": PLAYER,
                "question_id": started["q1"]["id"],
                "selected_option_id": _right(started["q1"]),
                "answer_text": None,
            },
        )

        resumed = start(client, started["code"]).get_json()
        saved = next(a for a in resumed["answers"] if a["question_id"] == started["q1"]["id"])
        assert saved["selected_option_id"] == _right(started["q1"])

        # ...and it renders as the option the player actually chose.
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": started["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": started["q1"]["id"],
                        "selected_option_id": _right(started["q1"]),
                        "answer_text": None,
                    }
                ],
            },
        )
        results = client.post(
            "/api/play/results",
            json={"code": started["code"]["code"], "player_name": PLAYER},
        ).get_json()
        assert results["answers"][0]["your_answer"] == "OLD RIGHT"


# ---------------------------------------------------------------------------
# 9-11. SECURITY: the answer key must never reach a player
# ---------------------------------------------------------------------------


class TestPlayerPayloadLeaksNoAnswerKey:
    def test_the_raw_body_contains_no_is_correct_answer(self, started, client):
        """Inspects the RAW BODY rather than the parsed object - a leak added
        anywhere in the shape would show up here."""
        raw = client.post(
            "/api/play/start",
            json={"access_code_id": started["code"]["id"], "player_name": PLAYER},
        ).get_data(as_text=True)

        assert "is_correct_answer" not in raw
        assert "expected_answers" not in raw
        assert "answer_matching" not in raw
        assert "answer_explanation" not in raw

    def test_no_option_carries_a_correctness_flag(self, started):
        for question in started["start"]["questions"]:
            for option in question["options"]:
                assert set(option) == {"id", "option_text"}, option

    def test_the_correct_option_text_is_not_identifiable_from_ordering_metadata(
        self, started
    ):
        """The payload must not hint at the answer through extra fields."""
        question = started["start"]["questions"][0]
        assert set(question) <= {
            "id",
            "question_text",
            "question_type",
            "options",
            "image",
            "masked_image_url",
        }, question.keys()

    def test_a_fill_blank_delivers_no_accepted_answers(self, app, client, coach_headers):
        """Fill in the Blank keeps its answer key in `expected_answers`, which
        is exactly what a mid-quiz payload must not contain."""
        from app.models import QuestionType

        quiz = client.post(
            "/api/quizzes", json={"title": "Fill blank"}, headers=coach_headers
        ).get_json()
        _mc(client, coach_headers, quiz["id"], "Ordinary")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        with app.app_context():
            question = Question(
                quiz_id=quiz["id"],
                question_text="Name the coverage",
                question_type=QuestionType.FILL_BLANK,
                position=1,
                expected_answers=["COVER THREE SECRET"],
                answer_matching="exact",
            )
            db.session.add(question)
            db.session.commit()

        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        # Activation refuses a region-less FILL_BLANK, so this quiz cannot be
        # activated with it - which is itself the guard. Exercise the
        # serializer directly instead.
        from app.services.delivered_questions import _from_live, to_player_payload

        with app.app_context():
            live = Question.query.filter_by(question_text="Name the coverage").one()
            payload = to_player_payload(_from_live(live, 1))

        assert "COVER THREE SECRET" not in json.dumps(payload)
        assert "expected_answers" not in payload
        assert code is not None or True


# ---------------------------------------------------------------------------
# 12-13. Images
# ---------------------------------------------------------------------------


class TestImages:
    def test_a_resumed_attempt_keeps_its_delivered_image(
        self, app, client, coach_headers
    ):
        from tests.conftest import make_image_file

        quiz = client.post(
            "/api/quizzes", json={"title": "Picture"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Q with a picture")
        buffer, name = make_image_file("original.png", (20, 20))
        original_url = client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer, name)},
            content_type="multipart/form-data",
            headers=coach_headers,
        ).get_json()["image_url"]
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER, "Alex Lee"]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code)

        buffer2, name2 = make_image_file("corrected.png", (32, 32))
        live_url = client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer2, name2)},
            content_type="multipart/form-data",
            headers=coach_headers,
        ).get_json()["image_url"]

        resumed = start(client, code).get_json()
        resumed_url = resumed["questions"][0]["image"]["image_url"]
        assert resumed_url != live_url, "the in-progress player keeps their picture"
        assert resumed_url != original_url, "which is now Phase 1's preserved copy"

        fresh = start(client, code, player="Alex Lee").get_json()
        assert fresh["questions"][0]["image"]["image_url"] == live_url

    def test_a_region_backed_question_keeps_a_masked_image_on_resume(
        self, app, client, coach_headers
    ):
        """THE DOCUMENTED SEAM. The snapshot does not record region geometry,
        so the masked render comes from the LIVE region - truthful only while
        region editing stays blocked after delivery."""
        from app.models import DocumentPage, QuestionRegion, SourceDocument
        from app.models.question_region import RegionRole
        from app.models import QuestionType

        quiz = client.post(
            "/api/quizzes", json={"title": "Region"}, headers=coach_headers
        ).get_json()
        with app.app_context():
            from app.models import Coach

            coach = Coach.query.filter_by(username="coach1").one()
            document = SourceDocument(
                organization_id=coach.organization_id,
                uploaded_by_coach_id=coach.id,
                title="Playbook",
                original_filename="p.pdf",
                storage_key="k",
                byte_size=1024,
                page_count=1,
                content_hash="0" * 64,
            )
            db.session.add(document)
            db.session.flush()
            page = DocumentPage(
                source_document_id=document.id,
                page_number=1,
                image_key="page.png",
                width_pt=612,
                height_pt=792,
                render_width=1000,
                render_height=800,
                render_dpi=150,
                renderer_version="test",
            )
            db.session.add(page)
            db.session.flush()
            question = Question(
                quiz_id=quiz["id"],
                question_text="Name the coverage",
                question_type=QuestionType.FILL_BLANK,
                position=0,
                expected_answers=["Cover 3"],
                answer_matching="exact",
            )
            db.session.add(question)
            db.session.flush()
            db.session.add(
                QuestionRegion(
                    question_id=question.id,
                    document_page_id=page.id,
                    position=0,
                    role=RegionRole.MASK,
                    x=0.1,
                    y=0.1,
                    width=0.2,
                    height=0.2,
                )
            )
            db.session.commit()

        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()

        payload = start(client, code).get_json()
        region_question = payload["questions"][0]
        assert region_question["masked_image_url"], "the player must still see the page"
        assert region_question["masked_image_url"].startswith("/api/media/")

        resumed = start(client, code).get_json()
        assert resumed["questions"][0]["masked_image_url"].startswith("/api/media/")


# ---------------------------------------------------------------------------
# 14-15. require_all_answers uses the DELIVERED set
# ---------------------------------------------------------------------------


class TestRequireAllAnswers:
    @pytest.fixture
    def strict(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes",
            json={"title": "Strict"},
            headers=coach_headers,
        ).get_json()
        client.patch(
            f"/api/quizzes/{quiz['id']}",
            json={"require_all_answers": True},
            headers=coach_headers,
        )
        q1 = _mc(client, coach_headers, quiz["id"], "Q1")
        q2 = _mc(client, coach_headers, quiz["id"], "Q2")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER, "Alex Lee"]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code)
        return {"quiz_id": quiz["id"], "q1": q1, "q2": q2, "code": code}

    def test_a_question_added_after_the_attempt_started_does_not_block_submission(
        self, client, coach_headers, strict
    ):
        """BEFORE: submit validated against the LIVE quiz, so a coach adding a
        question could strand a player on one they had never been shown."""
        _mc(client, coach_headers, strict["quiz_id"], "Q3 ADDED LATER")

        response = client.post(
            "/api/play/submit",
            json={
                "access_code_id": strict["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": strict[q]["id"],
                        "selected_option_id": _right(strict[q]),
                        "answer_text": None,
                    }
                    for q in ("q1", "q2")
                ],
            },
        )
        assert response.status_code == 201, response.get_json()

    def test_a_new_attempt_IS_held_to_the_added_question(
        self, client, coach_headers, strict
    ):
        _mc(client, coach_headers, strict["quiz_id"], "Q3 ADDED LATER")
        start(client, strict["code"], player="Alex Lee")

        response = client.post(
            "/api/play/submit",
            json={
                "access_code_id": strict["code"]["id"],
                "player_name": "Alex Lee",
                "answers": [
                    {
                        "question_id": strict[q]["id"],
                        "selected_option_id": _right(strict[q]),
                        "answer_text": None,
                    }
                    for q in ("q1", "q2")
                ],
            },
        )
        assert response.status_code == 422, "the new attempt received three questions"

    def test_an_unanswered_delivered_question_still_blocks(
        self, client, coach_headers, strict
    ):
        response = client.post(
            "/api/play/submit",
            json={
                "access_code_id": strict["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": strict["q1"]["id"],
                        "selected_option_id": _right(strict["q1"]),
                        "answer_text": None,
                    }
                ],
            },
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# 16. Practice retake
# ---------------------------------------------------------------------------


class TestPracticeRetake:
    def test_try_again_receives_the_CORRECTED_version(self, client, coach_headers):
        """A retake is a genuinely new attempt, so it must not be pinned to the
        old version merely because the same player attempted before."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Practice"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "VERSION A text")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        ).get_json()

        first = start(client, code)
        assert "VERSION A text" in delivered_texts(first.get_json())
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": _right(question),
                        "answer_text": None,
                    }
                ],
            },
        )

        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )

        retake = start(client, code)
        assert retake.status_code == 201, "Try Again starts a NEW attempt"
        assert "VERSION B text" in delivered_texts(retake.get_json())
        assert "VERSION A text" not in delivered_texts(retake.get_json())

    def test_the_first_practice_attempts_history_still_shows_version_A(
        self, app, client, coach_headers
    ):
        """Both snapshots coexist - the retake does not rewrite the first."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Practice history"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "VERSION A text")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        ).get_json()
        start(client, code)
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": _right(question),
                        "answer_text": None,
                    }
                ],
            },
        )
        assert submitted.status_code == 201, submitted.get_json()
        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )
        start(client, code)

        with app.app_context():
            texts = sorted(
                row.snapshot["question_text"] for row in AttemptQuestionSnapshot.query.all()
            )
            assert texts == ["VERSION A text", "VERSION B text"]


# ---------------------------------------------------------------------------
# 17-22. Nothing else moves
# ---------------------------------------------------------------------------


class TestNothingElseMoves:
    def test_resuming_never_mutates_a_snapshot_row(self, app, client, coach_headers, started):
        with app.app_context():
            before = {
                r.id: (r.position, r.question_id, r.snapshot)
                for r in AttemptQuestionSnapshot.query.all()
            }

        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )
        start(client, started["code"])
        start(client, started["code"])

        with app.app_context():
            after = {
                r.id: (r.position, r.question_id, r.snapshot)
                for r in AttemptQuestionSnapshot.query.all()
            }
        assert after == before

    def test_resuming_creates_no_extra_attempt(self, app, client, started):
        start(client, started["code"])
        start(client, started["code"])

        with app.app_context():
            assert PlayerAttempt.query.filter_by(player_name=PLAYER).count() == 1

    def test_a_legacy_attempt_with_no_snapshot_still_plays(
        self, app, client, coach_headers, started
    ):
        """COMPATIBILITY FALLBACK. No snapshot means no delivered record, so
        the live questions are served - which is what happened before 4a-bis.
        Nothing is invented and nothing is backfilled."""
        with app.app_context():
            AttemptQuestionSnapshot.query.delete()
            db.session.commit()

        client.patch(
            f"/api/quizzes/{started['quiz_id']}/questions/{started['q1']['id']}",
            json={"question_text": "VERSION B text"},
            headers=coach_headers,
        )

        resumed = start(client, started["code"])
        assert resumed.status_code == 200
        assert "VERSION B text" in delivered_texts(resumed.get_json())

        with app.app_context():
            assert AttemptQuestionSnapshot.query.count() == 0, "no backfill"

    def test_a_question_deleted_after_delivery_is_dropped_from_the_resumed_payload(
        self, client, coach_headers, started
    ):
        """It cannot be answered (upsert_answer rejects it), so it is not shown
        as an unanswerable card. The snapshot record of it survives."""
        assert (
            client.delete(
                f"/api/quizzes/{started['quiz_id']}/questions/{started['q2']['id']}",
                headers=coach_headers,
            ).status_code
            == 204
        )

        resumed = start(client, started["code"]).get_json()
        assert [q["id"] for q in resumed["questions"]] == [started["q1"]["id"]]

    def _count_queries(self, app, work):
        from sqlalchemy import event

        queries = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        with app.app_context():
            engine = db.engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            work()
        finally:
            event.remove(engine, "before_cursor_execute", listener)
        return len(queries)

    def _quiz_of_size(self, client, coach_headers, size, player):
        quiz = client.post(
            "/api/quizzes", json={"title": f"Q{size}"}, headers=coach_headers
        ).get_json()
        questions = [
            _mc(client, coach_headers, quiz["id"], f"Question {i}") for i in range(size)
        ]
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [player]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code, player)
        return quiz, questions, code

    def test_the_delivered_payload_costs_no_extra_queries_per_question(
        self, app, client, coach_headers
    ):
        """SCALE-INVARIANT ON PURPOSE.

        A flat `< 20` bound passes an N+1 that simply has not grown yet, so
        this compares a 3-question quiz against a 15-question one. If resuming
        cost one lookup per delivered question the gap would be ~12; requiring
        it to stay tiny is what actually pins the eager loads.

        This caught a real regression: `_delivered_payload` originally asked
        `question.regions` per question, and the resume cost grew with quiz
        length on the hottest player route.
        """
        # Built (and started) OUTSIDE the measured window, so only the resume
        # itself is counted.
        _, _, small_code = self._quiz_of_size(client, coach_headers, 3, "Small Player")
        _, _, big_code = self._quiz_of_size(client, coach_headers, 15, "Big Player")

        small = self._count_queries(app, lambda: start(client, small_code, "Small Player"))
        big = self._count_queries(app, lambda: start(client, big_code, "Big Player"))

        assert small > 0, "measured nothing"
        assert big - small <= 2, f"{small} queries for 3 questions, {big} for 15"

    def test_player_results_costs_no_extra_queries_per_question(
        self, app, client, coach_headers
    ):
        """The same guard on the OTHER surface 4a rewired. `player_results`
        now reads snapshots and falls back to `answer.selected_option`; both
        lazy-load per question unless eagerly loaded, and this is what proves
        they are."""

        def submit_all(code, questions, player):
            client.post(
                "/api/play/submit",
                json={
                    "access_code_id": code["id"],
                    "player_name": player,
                    "answers": [
                        {
                            "question_id": q["id"],
                            "selected_option_id": _right(q),
                            "answer_text": None,
                        }
                        for q in questions
                    ],
                },
            )

        _, small_qs, small_code = self._quiz_of_size(client, coach_headers, 3, "Res Small")
        _, big_qs, big_code = self._quiz_of_size(client, coach_headers, 15, "Res Big")
        submit_all(small_code, small_qs, "Res Small")
        submit_all(big_code, big_qs, "Res Big")

        def results(code, player):
            # `code` here is the access-code STRING, not its id. Getting that
            # wrong makes the request 400 before it touches the database, and
            # the query-count assertion below then passes on ZERO queries while
            # proving nothing. It did exactly that when first written, which is
            # why the status and the floor are both asserted.
            def run():
                response = client.post(
                    "/api/play/results",
                    json={"code": code["code"], "player_name": player},
                )
                assert response.status_code == 200, response.get_json()

            return run

        small = self._count_queries(app, results(small_code, "Res Small"))
        big = self._count_queries(app, results(big_code, "Res Big"))

        assert small > 0, "measured nothing - the request never reached the database"
        assert big - small <= 2, f"{small} queries for 3 questions, {big} for 15"
