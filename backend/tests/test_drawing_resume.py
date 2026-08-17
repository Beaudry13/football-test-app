"""Draw Response Phase B - THE SERVER RESTORES A SAVED DRAWING.

    Once a drawing has successfully saved, the server is authoritative.
    localStorage stays useful, but it is no longer the only way back.

THE GAP THIS CLOSES
-------------------
Drawings have persisted to `answer_drawings` for some time, but `/play/start`
never sent one back. So the work was safe on the server and invisible to the
player: clear the browser, or pick up a different phone, and the canvas came
back empty while the drawing sat in the database.

WHERE THE PRECEDENCE RULE LIVES
-------------------------------
Choosing between a local draft and the server copy is a CLIENT decision - see
`frontend/src/pages/play/resumeDrawing.ts`, which orders them by `revision`
and never by a clock. This file proves the half the server owns: that the
document and its revision come back at all, that they stay bound to the
delivered image, that a stale write still loses, and that nothing crosses
between players or attempts.
"""

import json

import pytest

from app.extensions import db
from app.models import AttemptQuestionSnapshot
from app.models.assessment_mode import PRACTICE
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def document_for(image_id, *, strokes=1):
    return {
        "format": "peira.drawing",
        "version": 1,
        "coordinate_width": 1200,
        "coordinate_height": 800,
        "source": {"image_id": str(image_id)},
        "strokes": [
            {"tool": "pen", "color": "#ff0000", "width": 4, "points": [i, i, i + 1, i + 1]}
            for i in range(strokes)
        ],
    }


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def save(client, code, question_id, document, player=PLAYER, base_revision=None):
    return client.put(
        "/api/play/drawing",
        json={
            "access_code_id": code["id"],
            "player_name": player,
            "question_id": question_id,
            "document": document,
            "base_revision": base_revision,
        },
    )


def drawing_of(payload, question_id):
    entry = next(a for a in payload["answers"] if a["question_id"] == question_id)
    return entry["drawing"]


def add_draw_question(client, headers, quiz_id, text="Draw it", name="img.png"):
    question = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": text, "question_type": "draw_response", "options": []},
        headers=headers,
    ).get_json()
    buffer, filename = make_image_file(name, (40, 40))
    client.post(
        f"/api/quizzes/{quiz_id}/questions/{question['id']}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=headers,
    )
    return question


@pytest.fixture
def drawn(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Resume"}, headers=coach_headers
    ).get_json()
    question = add_draw_question(client, coach_headers, quiz["id"], name="resume.png")
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = start(client, code).get_json()
    return {
        "quiz_id": quiz["id"],
        "question": question,
        "code": code,
        "attempt_id": started["attempt_id"],
        "image_id": started["questions"][0]["image"]["id"],
    }


class TestResumeContract:
    def test_start_returns_the_saved_drawing_and_its_revision(self, client, drawn):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        resumed = start(client, drawn["code"]).get_json()

        drawing = drawing_of(resumed, drawn["question"]["id"])
        assert drawing is not None
        assert drawing["revision"] == 1
        assert len(drawing["document"]["strokes"]) == 1

    def test_the_revision_advances_with_each_save(self, client, drawn):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))
        save(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["image_id"], strokes=3),
            base_revision=1,
        )

        drawing = drawing_of(start(client, drawn["code"]).get_json(), drawn["question"]["id"])

        assert drawing["revision"] == 2
        assert len(drawing["document"]["strokes"]) == 3

    def test_an_answer_with_no_drawing_reports_none(self, client, drawn):
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": drawn["code"]["id"],
                "player_name": PLAYER,
                "question_id": drawn["question"]["id"],
                "answer_text": None,
                "selected_option_id": None,
            },
        )

        resumed = start(client, drawn["code"]).get_json()

        assert drawing_of(resumed, drawn["question"]["id"]) is None

    def test_the_existing_answer_fields_are_untouched(self, client, drawn):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        entry = next(
            a
            for a in start(client, drawn["code"]).get_json()["answers"]
            if a["question_id"] == drawn["question"]["id"]
        )

        for field in ("question_id", "selected_option_id", "answer_text", "checked"):
            assert field in entry

    def test_no_timestamp_is_sent(self, client, drawn):
        """The client orders by `revision`. Shipping a clock would invite it to
        compare one, which is exactly what the precedence rule forbids."""
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        drawing = drawing_of(start(client, drawn["code"]).get_json(), drawn["question"]["id"])

        assert set(drawing) == {"document", "revision"}


class TestRecovery:
    def test_a_cleared_browser_loses_nothing(self, client, drawn):
        """localStorage is not modelled here at all - which IS the proof. The
        drawing comes back from a request carrying no client state beyond the
        access code and the player's name."""
        save(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["image_id"], strokes=4),
        )

        resumed = start(client, drawn["code"]).get_json()

        assert len(drawing_of(resumed, drawn["question"]["id"])["document"]["strokes"]) == 4

    def test_another_device_resumes_the_same_attempt(self, client, drawn):
        """Device A saves; Device B - same player, same attempt, no shared
        storage - receives it. This is the product gap Phase B closes."""
        save(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["image_id"], strokes=6),
        )

        device_b = start(client, drawn["code"]).get_json()

        assert device_b["attempt_id"] == drawn["attempt_id"]
        assert len(drawing_of(device_b, drawn["question"]["id"])["document"]["strokes"]) == 6


class TestIsolation:
    def test_players_do_not_see_each_others_drawings(self, client, drawn):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        other = start(client, drawn["code"], player=OTHER).get_json()

        assert other["attempt_id"] != drawn["attempt_id"]
        assert other["answers"] == []

    def test_a_practice_retake_starts_without_the_previous_drawing(
        self, client, coach_headers
    ):
        quiz = client.post(
            "/api/quizzes", json={"title": "Retake"}, headers=coach_headers
        ).get_json()
        question = add_draw_question(client, coach_headers, quiz["id"], name="retake.png")
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        ).get_json()
        first = start(client, code).get_json()
        image_id = first["questions"][0]["image"]["id"]
        save(client, code, question["id"], document_for(image_id))
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": question["id"],
                        "selected_option_id": None,
                        "answer_text": None,
                        "drawing": document_for(image_id),
                    }
                ],
            },
        )

        retake = start(client, code).get_json()

        assert retake["attempt_id"] != first["attempt_id"]
        assert retake["answers"] == []


class TestStillBoundToTheDeliveredImage:
    def test_a_replaced_image_does_not_rebind_the_resumed_drawing(
        self, client, coach_headers, drawn
    ):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        buffer, filename = make_image_file("replacement.png", (80, 80))
        client.post(
            f"/api/quizzes/{drawn['quiz_id']}/questions/{drawn['question']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )

        resumed = start(client, drawn["code"]).get_json()

        assert resumed["questions"][0]["image"]["id"] == drawn["image_id"]
        assert drawing_of(resumed, drawn["question"]["id"])["document"]["source"][
            "image_id"
        ] == str(drawn["image_id"])

    def test_a_stale_write_cannot_overwrite_a_newer_server_drawing(self, client, drawn):
        """The server half of the precedence rule. The client decides what to
        SHOW; `base_revision` decides what it is allowed to WRITE."""
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))
        save(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["image_id"], strokes=5),
            base_revision=1,
        )

        stale = save(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["image_id"], strokes=2),
            base_revision=1,
        )

        assert stale.status_code == 409
        drawing = drawing_of(start(client, drawn["code"]).get_json(), drawn["question"]["id"])
        assert len(drawing["document"]["strokes"]) == 5, "the newer save survived"


class TestInvariants:
    def test_the_resume_payload_leaks_no_answer_key(self, client, drawn):
        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))

        blob = json.dumps(start(client, drawn["code"]).get_json())

        for leaked in (
            "is_correct_answer",
            "expected_answers",
            "answer_matching",
            "answer_explanation",
            "preview_url",
            "answer_id",
        ):
            assert leaked not in blob

    def test_snapshots_are_not_mutated_by_resuming(self, app, client, drawn):
        with app.app_context():
            before = {
                (r.id, r.position, str(r.snapshot))
                for r in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=drawn["attempt_id"]
                )
            }

        save(client, drawn["code"], drawn["question"]["id"], document_for(drawn["image_id"]))
        start(client, drawn["code"])
        start(client, drawn["code"])

        with app.app_context():
            after = {
                (r.id, r.position, str(r.snapshot))
                for r in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=drawn["attempt_id"]
                )
            }
        assert after == before

    def test_resuming_costs_ONE_query_for_drawings_however_many_there_are(
        self, app, client, coach_headers, drawn
    ):
        """Batched on purpose. Walking `answer.drawing` per answer would be an
        N+1 on the route a whole squad hits at once."""
        from sqlalchemy import event

        for index in range(6):
            add_draw_question(
                client,
                coach_headers,
                drawn["quiz_id"],
                text=f"Draw {index}",
                name=f"extra{index}.png",
            )

        fresh = start(client, drawn["code"], player=OTHER).get_json()
        for question in fresh["questions"]:
            save(
                client,
                drawn["code"],
                question["id"],
                document_for(question["image"]["id"]),
                player=OTHER,
            )

        queries = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        with app.app_context():
            engine = db.engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            start(client, drawn["code"], player=OTHER)
        finally:
            event.remove(engine, "before_cursor_execute", listener)

        drawing_queries = [q for q in queries if "answer_drawings" in q]
        assert len(drawing_queries) == 1, drawing_queries
