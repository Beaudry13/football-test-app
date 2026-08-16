"""Phase 4a - historical Results show WHAT THE PLAYER RECEIVED.

This file began life as `test_historical_display_characterization.py`, which
asserted the OLD, wrong behaviour so the bugs were reproduced rather than
described. Six of those eleven tests flipped the moment Phase 4a landed, and
this is the same file rewritten into the correct expectation on purpose. The
"before" is recorded in each docstring, because a test that only states the
answer teaches nobody why it is the answer.

THE RULE
--------
    An attempt's historical display comes from its DELIVERED-QUESTION SNAPSHOT.
    The live question row describes the quiz as it is TODAY, which is what
    future players will receive - and nothing else.

WHAT IS DELIBERATELY UNCHANGED
------------------------------
`answers.is_correct` remains the historical verdict; nothing regrades from the
snapshot's answer key. Scoring still counts answer rows. Snapshots are written
once at /play/start and are never rewritten - these are all reads.
"""

import csv
import io

import pytest

from app.extensions import db
from app.models import Answer, AttemptQuestionSnapshot, PlayerAttempt, Question

PLAYER = "Jordan Smith"


def _mc(client, headers, quiz_id, text, right="Right", wrong="Wrong"):
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


def _pick(question, correct):
    return next(o["id"] for o in question["options"] if o["is_correct_answer"] is correct)


@pytest.fixture
def delivered(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Historical display"}, headers=coach_headers
    ).get_json()
    q1 = _mc(client, coach_headers, quiz["id"], "ORIGINAL Q1 text")
    q2 = _mc(client, coach_headers, quiz["id"], "ORIGINAL Q2 text")
    q3 = _mc(client, coach_headers, quiz["id"], "ORIGINAL Q3 text")

    client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()

    assert (
        client.post(
            "/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER}
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": _pick(q, True),
                        "answer_text": None,
                    }
                    for q in (q1, q2, q3)
                ],
            },
        ).status_code
        == 201
    )
    return {"quiz_id": quiz["id"], "q1": q1, "q2": q2, "q3": q3, "code": code}


def player_results(client, delivered):
    return client.post(
        "/api/play/results",
        json={"code": delivered["code"]["code"], "player_name": PLAYER},
    ).get_json()


def csv_rows(client, headers, quiz_id):
    raw = client.get(f"/api/quizzes/{quiz_id}/export.csv", headers=headers).get_data(as_text=True)
    return list(csv.DictReader(io.StringIO(raw)))


def reorder(client, headers, delivered, ids):
    return client.post(
        f"/api/quizzes/{delivered['quiz_id']}/questions/reorder",
        json={"question_ids": ids},
        headers=headers,
    )


def quiz_card_average(client, headers, quiz_id):
    body = client.get("/api/quizzes", headers=headers).get_json()
    return next(q for q in body if q["id"] == quiz_id).get("average_score_percent")


# ---------------------------------------------------------------------------
# 1-3. Text, options and the selected answer
# ---------------------------------------------------------------------------


class TestCorrectingTheQuizDoesNotRewriteHistory:
    def test_historical_question_text_survives_a_live_edit(
        self, client, coach_headers, delivered
    ):
        """BEFORE: the player's own results showed the coach's new wording for
        a question they never saw."""
        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED FOR FUTURE PLAYERS"},
            headers=coach_headers,
        )

        texts = [a["question_text"] for a in player_results(client, delivered)["answers"]]
        assert "ORIGINAL Q1 text" in texts
        assert "CORRECTED FOR FUTURE PLAYERS" not in texts

    def test_the_csv_exports_the_delivered_wording(self, client, coach_headers, delivered):
        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED FOR FUTURE PLAYERS"},
            headers=coach_headers,
        )

        questions = {r["Question"] for r in csv_rows(client, coach_headers, delivered["quiz_id"])}
        assert "ORIGINAL Q1 text" in questions
        assert "CORRECTED FOR FUTURE PLAYERS" not in questions

    def test_the_selected_answer_still_reads_as_the_player_saw_it(
        self, client, coach_headers, delivered
    ):
        answers = player_results(client, delivered)["answers"]
        assert all(a["your_answer"] == "Right" for a in answers)

    def test_historical_option_text_survives_an_option_edit(
        self, app, client, coach_headers, delivered
    ):
        """Option edits are blocked once a question has ANY answer, so the only
        way to reach this state is a SECOND attempt that started before the
        edit. That attempt's snapshot holds the old wording."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Option edit"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Q", right="OLD RIGHT", wrong="OLD WRONG")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        # Snapshot captured here, before any answer exists.
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER})

        edited = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={
                "options": [
                    {"option_text": "NEW RIGHT", "is_correct_answer": True},
                    {"option_text": "NEW WRONG", "is_correct_answer": False},
                ]
            },
            headers=coach_headers,
        )
        assert edited.status_code == 200, "no answers yet, so the edit is allowed"

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(access_code_id=code["id"]).one()
            snap = AttemptQuestionSnapshot.query.filter_by(attempt_id=attempt.id).one()
            assert [o["text"] for o in snap.snapshot["options"]] == ["OLD RIGHT", "OLD WRONG"]

    def test_an_option_the_snapshot_never_saw_falls_back_to_the_live_text(
        self, client, coach_headers
    ):
        """The one reachable gap, handled explicitly: start (snapshot taken),
        an option ADDED while unanswered, THEN answered with that new option id.
        Blanking the cell would erase a real answer to protect a record that
        does not describe it.

        Reached via an APPENDED option since Phase 4C. Rewording a delivered
        question's options now mutates the rows in place, so it can no longer
        produce an id the snapshot never saw - adding one still can, and that
        is exactly the case this fallback exists for.
        """
        quiz = client.post(
            "/api/quizzes", json={"title": "Late answer"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Q", right="OLD RIGHT", wrong="OLD WRONG")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER})

        updated = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={
                "options": [
                    {"option_text": "OLD RIGHT", "is_correct_answer": True},
                    {"option_text": "OLD WRONG", "is_correct_answer": False},
                    {"option_text": "NEW RIGHT", "is_correct_answer": False},
                ]
            },
            headers=coach_headers,
        ).get_json()
        new_right = next(o["id"] for o in updated["options"] if o["option_text"] == "NEW RIGHT")

        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {"question_id": question["id"], "selected_option_id": new_right, "answer_text": None}
                ],
            },
        )

        body = client.post(
            "/api/play/results", json={"code": code["code"], "player_name": PLAYER}
        ).get_json()
        assert body["answers"][0]["your_answer"] == "NEW RIGHT", (
            "the answer must still be shown, not blanked"
        )


# ---------------------------------------------------------------------------
# 6-7. Question type
# ---------------------------------------------------------------------------


class TestQuestionType:
    def test_a_bare_question_type_change_is_now_BLOCKED_once_answered(
        self, client, coach_headers, delivered
    ):
        """BEFORE: allowed (200), because the guard only fired when `options`
        was in the payload - and it blanked every player's answer."""
        response = client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_type": "written"},
            headers=coach_headers,
        )

        assert response.status_code == 422
        assert "type" in response.get_json()["error"]

    def test_setting_the_SAME_type_is_not_treated_as_a_change(
        self, client, coach_headers, delivered
    ):
        """An editor that always sends the full form must not be refused for
        submitting the value the question already has."""
        response = client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_type": "multiple_choice", "question_text": "Tidied wording"},
            headers=coach_headers,
        )
        assert response.status_code == 200

    def test_the_type_is_still_editable_before_anyone_answers(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Unanswered"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Q")

        response = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}",
            json={"question_type": "written"},
            headers=coach_headers,
        )
        assert response.status_code == 200

    def test_historical_display_uses_the_DELIVERED_type(
        self, app, client, coach_headers, delivered
    ):
        """Belt and braces. Even if a type change reached the database by some
        other route, the display asks the snapshot which column to read."""
        with app.app_context():
            question = db.session.get(Question, delivered["q1"]["id"])
            from app.models import QuestionType

            question.question_type = QuestionType.WRITTEN
            db.session.commit()

        answer = player_results(client, delivered)["answers"][0]
        assert answer["question_type"] == "multiple_choice"
        assert answer["your_answer"] == "Right", "the answer does NOT vanish"


# ---------------------------------------------------------------------------
# 8-9. Numbering and the live quiz
# ---------------------------------------------------------------------------


class TestHistoricalNumbering:
    def test_the_csv_keeps_the_number_the_player_was_given(
        self, client, coach_headers, delivered
    ):
        """BEFORE: reordering the live quiz retitled a historical export."""
        reorder(
            client,
            coach_headers,
            delivered,
            [delivered["q3"]["id"], delivered["q1"]["id"], delivered["q2"]["id"]],
        )

        numbers = {
            r["Question"]: r["Question #"]
            for r in csv_rows(client, coach_headers, delivered["quiz_id"])
        }
        assert numbers["ORIGINAL Q1 text"] == "1"
        assert numbers["ORIGINAL Q2 text"] == "2"
        assert numbers["ORIGINAL Q3 text"] == "3"

    def test_the_players_own_results_keep_their_numbering(
        self, client, coach_headers, delivered
    ):
        reorder(
            client,
            coach_headers,
            delivered,
            [delivered["q3"]["id"], delivered["q1"]["id"], delivered["q2"]["id"]],
        )

        numbered = {
            a["question_text"]: a["question_number"]
            for a in player_results(client, delivered)["answers"]
        }
        assert numbered == {
            "ORIGINAL Q1 text": 1,
            "ORIGINAL Q2 text": 2,
            "ORIGINAL Q3 text": 3,
        }

    def test_the_LIVE_breakdown_does_renumber_and_that_is_correct(
        self, client, coach_headers, delivered
    ):
        """The per-question breakdown is a LIVE, quiz-level view aggregating
        every attempt - and different attempts can have had different orders
        (randomized practice already does), so no single historical number
        exists for it. It follows the quiz as it stands today, on purpose."""
        reorder(
            client,
            coach_headers,
            delivered,
            [delivered["q3"]["id"], delivered["q1"]["id"], delivered["q2"]["id"]],
        )

        body = client.get(
            f"/api/quizzes/{delivered['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        numbering = {q["question_text"]: q["question_number"] for q in body["question_breakdown"]}
        assert numbering["ORIGINAL Q3 text"] == 1

    def test_a_future_attempt_receives_the_corrected_quiz(
        self, client, coach_headers, delivered
    ):
        """Corrections are FOR future players - that is the whole point."""
        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED FOR FUTURE PLAYERS"},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{delivered['quiz_id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        client.put(
            f"/api/quizzes/{delivered['quiz_id']}/roster",
            json={"players": [PLAYER, "Alex Lee"]},
            headers=coach_headers,
        )

        payload = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        texts = [q["question_text"] for q in payload["quiz"]["questions"]]
        assert "CORRECTED FOR FUTURE PLAYERS" in texts
        assert "ORIGINAL Q1 text" not in texts


# ---------------------------------------------------------------------------
# 4-5. Images
# ---------------------------------------------------------------------------


class TestHistoricalImages:
    def test_the_delivered_image_is_the_preserved_copy_after_a_replacement(
        self, app, client, coach_headers
    ):
        """Phase 1 preserved the old object; Phase 4a is what finally READS it.

        OLD ATTEMPT -> preserved old image
        LIVE QUESTION -> the corrected image
        """
        from tests.conftest import make_image_file
        from app.services.delivered_questions import delivered_questions

        quiz = client.post(
            "/api/quizzes", json={"title": "Picture error"}, headers=coach_headers
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
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER})
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": _pick(question, True),
                        "answer_text": None,
                    }
                ],
            },
        )

        buffer2, name2 = make_image_file("corrected.png", (32, 32))
        live_url = client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer2, name2)},
            content_type="multipart/form-data",
            headers=coach_headers,
        ).get_json()["image_url"]

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(access_code_id=code["id"]).one()
            quiz_row = attempt.quiz
            historical = delivered_questions(attempt, quiz_row)[0]

            assert historical.image.image_url != live_url, (
                "the past attempt must not render the corrected picture"
            )
            assert historical.image.image_url != original_url, (
                "it renders the PRESERVED COPY, since the original was unlinked"
            )
            # And the bytes are still there to render.
            from app.services.file_storage import get_file_storage

            assert get_file_storage().load_image_bytes(historical.image.image_url) is not None
            assert db.session.get(Question, question["id"]).image.image_url == live_url

    def test_delivered_annotations_and_canvas_width_are_the_delivered_values(
        self, app, client, coach_headers
    ):
        from tests.conftest import make_image_file
        from app.services.delivered_questions import delivered_questions

        quiz = client.post(
            "/api/quizzes", json={"title": "Annotations"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Q")
        buffer, name = make_image_file()
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer, name)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
            json={"annotations": [{"type": "arrow"}], "canvas_width": 900},
            headers=coach_headers,
        )
        client.put(
            f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER]}, headers=coach_headers
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": PLAYER})

        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
            json={"annotations": [{"type": "circle"}], "canvas_width": 1200},
            headers=coach_headers,
        )

        with app.app_context():
            attempt = PlayerAttempt.query.filter_by(access_code_id=code["id"]).one()
            historical = delivered_questions(attempt, attempt.quiz)[0]
            assert historical.image.annotations == [{"type": "arrow"}]
            assert historical.image.canvas_width == 900


# ---------------------------------------------------------------------------
# 10-11. Grades and scores never move
# ---------------------------------------------------------------------------


class TestNothingIsRegraded:
    def test_is_correct_is_never_recomputed_from_the_snapshot(
        self, app, client, coach_headers, delivered
    ):
        with app.app_context():
            before = {a.id: a.is_correct for a in Answer.query.all()}

        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED"},
            headers=coach_headers,
        )
        player_results(client, delivered)
        csv_rows(client, coach_headers, delivered["quiz_id"])
        client.get(
            f"/api/quizzes/{delivered['quiz_id']}/export-detailed.pdf", headers=coach_headers
        )

        with app.app_context():
            assert {a.id: a.is_correct for a in Answer.query.all()} == before

    def test_scores_do_not_move(self, client, coach_headers, delivered):
        before = quiz_card_average(client, coach_headers, delivered["quiz_id"])

        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED"},
            headers=coach_headers,
        )
        reorder(
            client,
            coach_headers,
            delivered,
            [delivered["q3"]["id"], delivered["q1"]["id"], delivered["q2"]["id"]],
        )

        assert quiz_card_average(client, coach_headers, delivered["quiz_id"]) == before

    def test_reading_history_never_mutates_a_snapshot_row(
        self, app, client, coach_headers, delivered
    ):
        """The record is written once at /play/start. Every surface here is a
        READ, and this proves it."""
        with app.app_context():
            before = {
                r.id: (r.position, r.question_id, r.snapshot)
                for r in AttemptQuestionSnapshot.query.all()
            }

        player_results(client, delivered)
        csv_rows(client, coach_headers, delivered["quiz_id"])
        client.get(
            f"/api/quizzes/{delivered['quiz_id']}/export-detailed.pdf", headers=coach_headers
        )
        client.get(f"/api/quizzes/{delivered['quiz_id']}/responses", headers=coach_headers)

        with app.app_context():
            after = {
                r.id: (r.position, r.question_id, r.snapshot)
                for r in AttemptQuestionSnapshot.query.all()
            }
        assert after == before


# ---------------------------------------------------------------------------
# 12. Exclusion still works against the historical display
# ---------------------------------------------------------------------------


class TestExclusionAgainstHistoricalContent:
    def test_an_excluded_question_shows_its_DELIVERED_content(
        self, client, coach_headers, delivered
    ):
        client.post(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}/exclusions",
            json={"access_code_id": None, "reason": "PICTURE ERROR"},
            headers=coach_headers,
        )
        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED"},
            headers=coach_headers,
        )

        answer = next(
            a
            for a in player_results(client, delivered)["answers"]
            if a["question_text"] == "ORIGINAL Q1 text"
        )
        assert answer["is_excluded"] is True
        assert answer["is_correct"] is None, "excluded reads as neither right nor wrong"
        assert answer["your_answer"] == "Right", "the answer is preserved"
        assert answer["question_number"] == 1, "and keeps the number it was delivered as"

    def test_the_csv_marks_it_excluded_against_delivered_content(
        self, client, coach_headers, delivered
    ):
        client.post(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}/exclusions",
            json={"access_code_id": None, "reason": None},
            headers=coach_headers,
        )

        row = next(
            r
            for r in csv_rows(client, coach_headers, delivered["quiz_id"])
            if r["Question"] == "ORIGINAL Q1 text"
        )
        assert row["Correct"] == "Excluded"
        assert row["Answer"] == "Right"


# ---------------------------------------------------------------------------
# 13. Legacy attempts
# ---------------------------------------------------------------------------


class TestLegacyAttempts:
    def test_an_attempt_with_no_snapshot_falls_back_to_the_live_question(
        self, app, client, coach_headers, delivered
    ):
        """No history is invented. A pre-Phase-1 attempt renders today's
        question, exactly as every surface did for it before Phase 4a."""
        from app.services.delivered_questions import delivered_questions

        with app.app_context():
            AttemptQuestionSnapshot.query.delete()
            db.session.commit()

        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "CORRECTED"},
            headers=coach_headers,
        )

        with app.app_context():
            attempt = PlayerAttempt.query.one()
            questions = delivered_questions(attempt, attempt.quiz)
            assert all(q.from_snapshot is False for q in questions)
            assert questions[0].text == "CORRECTED"
            assert [q.number for q in questions] == [1, 2, 3]

        # ...and the surfaces still render, rather than erroring on missing data.
        assert len(player_results(client, delivered)["answers"]) == 3
        assert (
            client.get(
                f"/api/quizzes/{delivered['quiz_id']}/export-detailed.pdf", headers=coach_headers
            ).status_code
            == 200
        )


# ---------------------------------------------------------------------------
# 15. Competition
# ---------------------------------------------------------------------------


class TestCompetitionUntouched:
    def test_no_competition_module_reads_delivered_questions(self):
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / "app"
        targets = [root / "routes" / "competition.py"] + sorted(
            (root / "services").glob("competition*.py")
        )
        assert targets
        for path in targets:
            source = path.read_text(encoding="utf-8")
            for forbidden in ("delivered_questions", "DeliveredQuestion"):
                assert forbidden not in source, f"{path.name} references {forbidden}"
