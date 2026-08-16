"""Draw Response Phase A - THE DRAWING IS BOUND TO THE IMAGE IT WAS DRAWN ON.

    A drawing, the image it was drawn on, and the coordinate space it was
    drawn in belong together permanently.

THE GAP THIS CLOSES
-------------------
A DrawingDocument records `source.image_id`, and that field is authored on the
CLIENT. Before Phase A the client read it from the LIVE question - so a coach
replacing the picture mid-attempt could produce a drawing whose strokes were
made on one image while claiming another.

Nothing downstream would have noticed. The coach's viewer renders the delivered
image and the stored strokes side by side and trusts that they belong together;
a silently mismatched pair looks exactly like a correct one.

NO SECOND VERSIONING SYSTEM
---------------------------
The delivered snapshot already answers "what did this attempt receive". Phase A
adds the image's identity to that same record and enforces it - it does not
invent a parallel history. `image_id` is a HISTORICAL FACT, not a live foreign
key: after a replacement it names a QuestionImage row that no longer exists,
which is precisely what makes it useful.

LEGACY IS SILENT, NOT GUESSED
-----------------------------
A snapshot written before Phase A has no `image_id`; a pre-Phase-1 attempt has
no snapshot at all. `None` means "not recorded" and NEVER "matches anything",
so those attempts keep working exactly as before and no history is invented.
"""

import pytest

from app.extensions import db
from app.models import AnswerDrawing, AttemptQuestionSnapshot
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def document_for(image_id, *, width=1000):
    return {
        "format": "peira.drawing",
        "version": 1,
        "coordinate_width": width,
        "coordinate_height": 600,
        "source": {"image_id": str(image_id)},
        "strokes": [
            {"tool": "pen", "color": "#ff0000", "width": 4, "points": [10, 10, 20, 20]}
        ],
    }


def save_drawing(client, code, question_id, document, player=PLAYER, base_revision=None):
    payload = {
        "access_code_id": code["id"],
        "player_name": player,
        "question_id": question_id,
        "document": document,
    }
    if base_revision is not None:
        payload["base_revision"] = base_revision
    return client.put("/api/play/drawing", json=payload)


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


@pytest.fixture
def drawn(client, coach_headers):
    """A Draw Response question with an image, delivered to one player."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
    ).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Draw the FS rotation",
            "question_type": "draw_response",
            "options": [],
        },
        headers=coach_headers,
    ).get_json()
    buffer, filename = make_image_file("coverage.png", (40, 40))
    assert (
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        ).status_code
        == 201
    )
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
        "start": started,
        "attempt_id": started["attempt_id"],
        "delivered_image": started["questions"][0]["image"],
    }


def replace_image(client, coach_headers, quiz_id, question_id, size=(80, 80)):
    buffer, filename = make_image_file("replacement.png", size)
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/image",
        data={"image": (buffer, filename)},
        content_type="multipart/form-data",
        headers=coach_headers,
    )


def live_image(client, coach_headers, quiz_id):
    return client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()[
        "questions"
    ][0]["image"]


# ---------------------------------------------------------------------------
# The delivered payload now carries the image's identity
# ---------------------------------------------------------------------------


class TestDeliveredIdentity:
    def test_the_player_payload_names_the_delivered_image(self, drawn):
        assert drawn["delivered_image"]["id"] is not None

    def test_it_matches_the_live_image_before_any_replacement(
        self, client, coach_headers, drawn
    ):
        assert drawn["delivered_image"]["id"] == live_image(
            client, coach_headers, drawn["quiz_id"]
        )["id"]

    def test_the_snapshot_records_it(self, app, drawn):
        with app.app_context():
            row = AttemptQuestionSnapshot.query.filter_by(
                attempt_id=drawn["attempt_id"]
            ).first()
            assert row.snapshot["image"]["image_id"] == drawn["delivered_image"]["id"]

    def test_a_resumed_attempt_keeps_naming_the_DELIVERED_image(
        self, client, coach_headers, drawn
    ):
        """THE HEADLINE. After the coach replaces the picture, the live id
        changes - and the resumed attempt still names the one it was given."""
        original_id = drawn["delivered_image"]["id"]

        assert replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"]).status_code == 201
        new_live_id = live_image(client, coach_headers, drawn["quiz_id"])["id"]
        assert new_live_id != original_id, "the replacement really is a new row"

        resumed = start(client, drawn["code"]).get_json()

        assert resumed["questions"][0]["image"]["id"] == original_id

    def test_a_NEW_attempt_names_the_replacement(self, client, coach_headers, drawn):
        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])
        new_live_id = live_image(client, coach_headers, drawn["quiz_id"])["id"]

        fresh = start(client, drawn["code"], player=OTHER).get_json()

        assert fresh["questions"][0]["image"]["id"] == new_live_id


# ---------------------------------------------------------------------------
# The binding is enforced, not merely recorded
# ---------------------------------------------------------------------------


class TestBindingEnforced:
    def test_a_drawing_on_the_delivered_image_is_accepted(self, client, drawn):
        saved = save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"]),
        )

        assert saved.status_code == 200, saved.get_json()

    def test_a_drawing_claiming_ANOTHER_image_is_refused(self, client, drawn):
        refused = save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"] + 9999),
        )

        assert refused.status_code == 409
        assert refused.get_json()["reason"] == "drawing_image_mismatch"

    def test_nothing_is_stored_when_the_binding_is_refused(self, app, client, drawn):
        save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"] + 9999),
        )

        with app.app_context():
            assert AnswerDrawing.query.count() == 0

    def test_a_drawing_bound_to_the_REPLACEMENT_is_refused_on_a_resumed_attempt(
        self, client, coach_headers, drawn
    ):
        """THE CASE THIS EXISTS FOR. The coach replaces the picture; a stale
        client tries to save a drawing bound to the new image against an
        attempt that was given the old one."""
        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])
        new_live_id = live_image(client, coach_headers, drawn["quiz_id"])["id"]

        refused = save_drawing(
            client, drawn["code"], drawn["question"]["id"], document_for(new_live_id)
        )

        assert refused.status_code == 409
        assert refused.get_json()["reason"] == "drawing_image_mismatch"

    def test_the_old_attempt_can_STILL_save_against_its_delivered_image(
        self, client, coach_headers, drawn
    ):
        """The refusal above must not lock a player out of their own attempt."""
        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])

        saved = save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"]),
        )

        assert saved.status_code == 200, saved.get_json()

    def test_a_new_attempt_binds_to_the_replacement(
        self, client, coach_headers, drawn
    ):
        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])
        fresh = start(client, drawn["code"], player=OTHER).get_json()

        saved = save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(fresh["questions"][0]["image"]["id"]),
            player=OTHER,
        )

        assert saved.status_code == 200, saved.get_json()


# ---------------------------------------------------------------------------
# The stored pair stays correct
# ---------------------------------------------------------------------------


class TestHistoricalPair:
    def test_the_stored_drawing_still_names_the_delivered_image_after_replacement(
        self, app, client, coach_headers, drawn
    ):
        save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"]),
        )

        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])

        with app.app_context():
            stored = AnswerDrawing.query.one()
            assert stored.document["source"]["image_id"] == str(
                drawn["delivered_image"]["id"]
            )

    def test_the_coach_sees_the_drawing_over_the_DELIVERED_image(
        self, client, coach_headers, drawn
    ):
        """The pair a coach opens must be the pair the player made."""
        save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"]),
        )
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": drawn["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": drawn["question"]["id"],
                        "selected_option_id": None,
                        "answer_text": None,
                        "drawing": document_for(drawn["delivered_image"]["id"]),
                    }
                ],
            },
        )

        replace_image(client, coach_headers, drawn["quiz_id"], drawn["question"]["id"])

        responses = client.get(
            f"/api/quizzes/{drawn['quiz_id']}/responses", headers=coach_headers
        ).get_json()
        delivered = responses[0]["delivered_questions"][0]
        answer = responses[0]["answers"][0]

        assert delivered["image"]["id"] == drawn["delivered_image"]["id"]
        assert answer["drawing"]["document"]["source"]["image_id"] == str(
            drawn["delivered_image"]["id"]
        )

    def test_the_delivered_coordinate_space_is_recorded_too(self, app, drawn):
        """A drawing is meaningless without the space it was authored in -
        rendering old strokes at a new canvas width moves every one of them."""
        with app.app_context():
            row = AttemptQuestionSnapshot.query.filter_by(
                attempt_id=drawn["attempt_id"]
            ).first()
            assert "canvas_width" in row.snapshot["image"]


# ---------------------------------------------------------------------------
# Legacy: silent, never guessed
# ---------------------------------------------------------------------------


class TestLegacy:
    def test_a_snapshot_without_an_image_id_does_not_block_saving(
        self, app, client, drawn
    ):
        """A snapshot written before Phase A records no image identity. `None`
        means "not recorded", so the binding check stands aside rather than
        refusing every drawing on every pre-Phase-A attempt."""
        with app.app_context():
            row = AttemptQuestionSnapshot.query.filter_by(
                attempt_id=drawn["attempt_id"]
            ).first()
            snapshot = dict(row.snapshot)
            image = dict(snapshot["image"])
            image.pop("image_id")
            snapshot["image"] = image
            row.snapshot = snapshot
            db.session.commit()

        saved = save_drawing(
            client, drawn["code"], drawn["question"]["id"], document_for(999999)
        )

        assert saved.status_code == 200, saved.get_json()

    def test_a_pre_phase_1_attempt_binds_against_the_LIVE_image(
        self, app, client, drawn
    ):
        """A legacy attempt has no delivered record, so the compatibility
        fallback serves the LIVE question - and the client, given no delivered
        image id, binds to that same live image. Enforcing against it is
        therefore consistent rather than an extra restriction: both halves are
        reading the one thing that exists.

        A bogus id is still refused, which is correct. Nothing a real client
        sends can produce one.
        """
        with app.app_context():
            AttemptQuestionSnapshot.query.filter_by(
                attempt_id=drawn["attempt_id"]
            ).delete()
            db.session.commit()

        refused = save_drawing(
            client, drawn["code"], drawn["question"]["id"], document_for(999999)
        )
        assert refused.status_code == 409

        accepted = save_drawing(
            client,
            drawn["code"],
            drawn["question"]["id"],
            document_for(drawn["delivered_image"]["id"]),
        )
        assert accepted.status_code == 200, accepted.get_json()


# ---------------------------------------------------------------------------
# Nothing else moved
# ---------------------------------------------------------------------------


class TestNoRegression:
    def test_a_question_with_no_image_is_unaffected(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "No picture"}, headers=coach_headers
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Type it",
                "question_type": "written",
                "options": [],
            },
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

        body = start(client, code).get_json()

        assert body["questions"][0]["image"] is None

    def test_the_player_payload_still_leaks_no_answer_key(self, drawn):
        import json

        blob = json.dumps(drawn["start"])
        for leaked in ("is_correct_answer", "expected_answers"):
            assert leaked not in blob
