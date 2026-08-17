"""Draw Response Phase C - A PLAYER SEES THEIR OWN DRAWING.

    The player's results page shows the drawing they made, over the exact
    image they were given - not the words "Drawing submitted".

ONE INTERPRETATION, TWO AUDIENCES
---------------------------------
The image and the document come from the same delivered record the coach's
view reads. That is deliberate: a player and their coach looking at the same
answer must never see different pictures, and the only way to guarantee that
is to stop the two sides deriving it separately.

WHAT THE PLAYER STILL DOES NOT GET
----------------------------------
Nothing coach-only rides along. No answer key, no expected answers, no
exclusion reason - the coach's private note about why a question stopped
counting is for the audit trail, not for the player it affected.
"""

import json

import pytest

from app.extensions import db
from app.models import AnswerDrawing
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
            {"tool": "pen", "color": "#ff0000", "width": 4, "points": [i, i, i + 2, i + 2]}
            for i in range(strokes)
        ],
    }


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def results(client, code, player=PLAYER):
    return client.post(
        "/api/play/results", json={"code": code["code"], "player_name": player}
    )


def answer_for(payload, question_id):
    return next(a for a in payload["answers"] if a["question_id"] == question_id)


@pytest.fixture
def submitted(client, coach_headers):
    """One Draw Response with a drawing, one written question, both submitted."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
    ).get_json()
    draw = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Draw the rotation", "question_type": "draw_response", "options": []},
        headers=coach_headers,
    ).get_json()
    buffer, filename = make_image_file("film.png", (40, 40))
    client.post(
        f"/api/quizzes/{quiz['id']}/questions/{draw['id']}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    written = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Explain it", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = start(client, code).get_json()
    image_id = started["questions"][0]["image"]["id"]
    delivered_url = started["questions"][0]["image"]["image_url"]

    client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": PLAYER,
            "answers": [
                {
                    "question_id": draw["id"],
                    "selected_option_id": None,
                    "answer_text": None,
                    "drawing": document_for(image_id, strokes=3),
                },
                {
                    "question_id": written["id"],
                    "selected_option_id": None,
                    "answer_text": "Because of the leverage",
                },
            ],
        },
    )
    return {
        "quiz_id": quiz["id"],
        "draw": draw,
        "written": written,
        "code": code,
        "image_id": image_id,
        "delivered_url": delivered_url,
    }


class TestTheDrawingIsReturned:
    def test_the_player_gets_their_drawing(self, client, submitted):
        row = answer_for(results(client, submitted["code"]).get_json(), submitted["draw"]["id"])

        assert row["drawing"] is not None
        assert len(row["drawing"]["document"]["strokes"]) == 3

    def test_it_carries_the_image_to_draw_it_over(self, client, submitted):
        row = answer_for(results(client, submitted["code"]).get_json(), submitted["draw"]["id"])

        assert row["drawing"]["image_url"] == submitted["delivered_url"]

    def test_the_drawing_still_names_the_delivered_image(self, client, submitted):
        row = answer_for(results(client, submitted["code"]).get_json(), submitted["draw"]["id"])

        assert row["drawing"]["document"]["source"]["image_id"] == str(submitted["image_id"])

    def test_a_written_answer_is_unchanged(self, client, submitted):
        row = answer_for(results(client, submitted["code"]).get_json(), submitted["written"]["id"])

        assert row["drawing"] is None
        assert row["your_answer"] == "Because of the leverage"


class TestHistoricalImage:
    def test_replacing_the_image_does_not_change_past_results(
        self, client, coach_headers, submitted
    ):
        """THE HEADLINE. The player keeps looking at the picture they drew on."""
        before = answer_for(
            results(client, submitted["code"]).get_json(), submitted["draw"]["id"]
        )["drawing"]["image_url"]

        buffer, filename = make_image_file("replacement.png", (80, 80))
        client.post(
            f"/api/quizzes/{submitted['quiz_id']}/questions/{submitted['draw']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )

        after = answer_for(
            results(client, submitted["code"]).get_json(), submitted["draw"]["id"]
        )["drawing"]

        live = client.get(
            f"/api/quizzes/{submitted['quiz_id']}", headers=coach_headers
        ).get_json()["questions"][0]["image"]["image_url"]

        assert after["image_url"] != live, "not the coach's new picture"
        assert client.get(after["image_url"]).status_code == 200, "and it still resolves"
        assert after["document"]["source"]["image_id"] == str(submitted["image_id"])
        assert before  # the pre-replacement url existed

    def test_the_coach_and_the_player_see_the_same_pair(
        self, client, coach_headers, submitted
    ):
        """One interpretation, two audiences."""
        player = answer_for(
            results(client, submitted["code"]).get_json(), submitted["draw"]["id"]
        )
        coach = client.get(
            f"/api/quizzes/{submitted['quiz_id']}/responses", headers=coach_headers
        ).get_json()[0]
        coach_delivered = next(
            d for d in coach["delivered_questions"] if d["question_id"] == submitted["draw"]["id"]
        )
        coach_answer = next(
            a for a in coach["answers"] if a["question_id"] == submitted["draw"]["id"]
        )

        assert player["drawing"]["image_url"] == coach_delivered["image"]["image_url"]
        assert player["drawing"]["document"] == coach_answer["drawing"]["document"]


class TestExclusion:
    def test_an_excluded_drawing_is_still_shown(self, app, client, coach_headers, submitted):
        """Exclusion sets a question aside; it does not erase the evidence.
        Hiding the drawing would read as a penalty."""
        from app.models import QuestionExclusion

        with app.app_context():
            db.session.add(
                QuestionExclusion(
                    question_id=submitted["draw"]["id"],
                    access_code_id=None,
                    coach_id=None,
                    reason="Bad film",
                )
            )
            db.session.commit()

        row = answer_for(results(client, submitted["code"]).get_json(), submitted["draw"]["id"])

        assert row["is_excluded"] is True
        assert row["drawing"] is not None
        assert len(row["drawing"]["document"]["strokes"]) == 3

    def test_the_coachs_private_reason_never_reaches_the_player(
        self, app, client, coach_headers, submitted
    ):
        from app.models import QuestionExclusion

        with app.app_context():
            db.session.add(
                QuestionExclusion(
                    question_id=submitted["draw"]["id"],
                    access_code_id=None,
                    coach_id=None,
                    reason="Bad film",
                )
            )
            db.session.commit()

        blob = json.dumps(results(client, submitted["code"]).get_json())

        assert "Bad film" not in blob


class TestDegradesHonestly:
    def test_a_draw_response_with_no_drawing_returns_none(
        self, client, coach_headers
    ):
        quiz = client.post(
            "/api/quizzes", json={"title": "Skipped"}, headers=coach_headers
        ).get_json()
        draw = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Draw", "question_type": "draw_response", "options": []},
            headers=coach_headers,
        ).get_json()
        buffer, filename = make_image_file("skip.png", (40, 40))
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{draw['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        start(client, code)
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {"question_id": draw["id"], "selected_option_id": None, "answer_text": None}
                ],
            },
        )

        row = answer_for(results(client, code).get_json(), draw["id"])

        assert row["drawing"] is None

    def test_an_empty_document_is_not_offered_as_a_drawing(
        self, app, client, submitted
    ):
        """Strokes make a drawing. An empty envelope is just the image."""
        with app.app_context():
            stored = AnswerDrawing.query.first()
            stored.document = {**stored.document, "strokes": []}
            db.session.commit()

        row = answer_for(results(client, submitted["code"]).get_json(), submitted["draw"]["id"])

        assert row["drawing"] is None


class TestPrivacy:
    def test_another_players_drawing_is_not_returned(self, client, submitted):
        start(client, submitted["code"], player=OTHER)

        other = results(client, submitted["code"], player=OTHER)

        # OTHER has not submitted, so there are no results to read at all.
        assert other.status_code == 404

    def test_no_answer_key_rides_along(self, client, submitted):
        blob = json.dumps(results(client, submitted["code"]).get_json())

        for leaked in (
            "is_correct_answer",
            "expected_answers",
            "answer_matching",
            "answer_explanation",
            "preview_url",
            "answer_id",
            "revision",
        ):
            assert leaked not in blob

    def test_results_still_need_the_right_name(self, client, submitted):
        wrong = client.post(
            "/api/play/results",
            json={"code": submitted["code"]["code"], "player_name": "Nobody At All"},
        )

        assert wrong.status_code == 404


class TestQueryCost:
    def test_drawings_are_loaded_in_one_query(self, app, client, coach_headers, submitted):
        from sqlalchemy import event

        queries = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        with app.app_context():
            engine = db.engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            results(client, submitted["code"])
        finally:
            event.remove(engine, "before_cursor_execute", listener)

        drawing_queries = [q for q in queries if "answer_drawings" in q]
        assert len(drawing_queries) == 1, drawing_queries
