"""IF THE PLAYER WILL SEE IT, PREVIEW MUST SHOW IT.

THE BUG
-------
A region-backed question has NO `question_images` row - the masked render IS
its picture. That URL was minted in exactly two places, both player routes, so
the coach payload Preview builds its screen from contained no picture at all.
Preview drew an empty card for every playbook question while the real attempt
rendered correctly, which made the one surface a coach uses to check a quiz
before sending it the only surface that lied.

WHY THIS IS SAFE, AND WHY IT IS NOT A WEAKENING
-----------------------------------------------
The URL resolves to the MASKED render: the same pixels the player receives,
with the answer already removed from them. There is deliberately no token kind
that resolves to the unmasked page or the source PDF, so this cannot be widened
into a leak by passing a different argument - the capability does not exist.

What the coach payload still must never contain is an UNMASKED page URL or a
storage key, and `TestNoUnmaskedLeak` is what keeps that true.
"""

import json

import pytest

from app.extensions import db
from app.models import DocumentPage, Question, SourceDocument
from app.models.question_region import QuestionRegion, RegionRole

PLAYER = "Jordan Smith"


@pytest.fixture
def playbook_quiz(app, client, coach_headers):
    """A quiz whose Q1 is built from a playbook page, plus an ordinary
    uploaded-image question beside it as the control."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage install"}, headers=coach_headers
    ).get_json()

    plain = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this cover 2?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )
    assert plain.status_code == 201, plain.get_json()

    with app.app_context():
        import io

        from PIL import Image

        from app.models import Coach
        from app.services.private_storage import get_private_storage

        # A REAL raster in private storage. `test_the_url_actually_serves_an
        # _image` follows the URL and masks the page for real, so a fake key
        # would make it fail for a reason that has nothing to do with this fix.
        buffer = io.BytesIO()
        Image.new("RGB", (1275, 1650), "white").save(buffer, format="PNG")
        storage = get_private_storage()
        image_key = storage.save_private(
            buffer.getvalue(), content_type="image/png", extension="png"
        )

        coach = Coach.query.filter_by(username="coach1").one()
        source = SourceDocument(
            organization_id=coach.organization_id,
            uploaded_by_coach_id=coach.id,
            title="2026 Defensive Playbook",
            original_filename="defense.pdf",
            storage_key="private-key-never-served",
            byte_size=1024,
            page_count=1,
            content_hash="0" * 64,
        )
        db.session.add(source)
        db.session.flush()
        page = DocumentPage(
            source_document_id=source.id,
            page_number=12,
            width_pt=612.0,
            height_pt=792.0,
            render_width=1275,
            render_height=1650,
            render_dpi=150,
            renderer_version="test/1.0",
            image_key=image_key,
        )
        db.session.add(page)
        # COMMITTED, not just flushed: the route below is a separate request
        # with its own session, and a flushed-only row is invisible to it.
        db.session.commit()
        page_id = page.id

    region_q = client.post(
        f"/api/quizzes/{quiz['id']}/questions/from-region",
        json={
            "question_text": "WHAT COVERAGE IS THIS?",
            "document_page_id": page_id,
            "region": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.15},
            "expected_answers": ["Cover 3"],
            "answer_matching": "normalised",
            "position": None,
        },
        headers=coach_headers,
    )
    assert region_q.status_code == 201, region_q.get_json()

    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert code.status_code == 201, code.get_json()
    return {
        "quiz_id": quiz["id"],
        "region_question_id": region_q.get_json()["id"],
        "plain_question_id": plain.get_json()["id"],
        "page_id": page_id,
        "code": code.get_json(),
    }


def coach_quiz(client, headers, quiz_id):
    got = client.get(f"/api/quizzes/{quiz_id}", headers=headers)
    assert got.status_code == 200, got.get_json()
    return got.get_json()


def question_in(payload, question_id):
    return next(q for q in payload["questions"] if q["id"] == question_id)


class TestPreviewSeesThePicture:
    def test_the_coach_payload_carries_the_masked_url(
        self, client, coach_headers, playbook_quiz
    ):
        """THE FIX. Preview builds its screen from this payload, so a missing
        URL here is a blank card there."""
        payload = coach_quiz(client, coach_headers, playbook_quiz["quiz_id"])
        question = question_in(payload, playbook_quiz["region_question_id"])

        # PRECONDITION: this really is a region question with no image of its
        # own, which is what makes the masked URL the only picture it has.
        assert question["image"] is None
        assert question["region"] is not None

        assert question["masked_image_url"].startswith("/api/media/")

    def test_it_is_there_on_the_FIRST_read(self, client, coach_headers, playbook_quiz):
        """No warm-up request, no second render, no navigation cycle - the
        very first payload a freshly-opened Preview receives has it."""
        payload = coach_quiz(client, coach_headers, playbook_quiz["quiz_id"])

        assert "masked_image_url" in question_in(
            payload, playbook_quiz["region_question_id"]
        )

    def test_the_url_actually_serves_an_image(self, client, coach_headers, playbook_quiz):
        """A URL that 404s would leave the card just as empty. Follows it."""
        payload = coach_quiz(client, coach_headers, playbook_quiz["quiz_id"])
        url = question_in(payload, playbook_quiz["region_question_id"])["masked_image_url"]

        served = client.get(url)

        assert served.status_code == 200, served.get_data()[:200]
        assert served.mimetype.startswith("image/")

    def test_an_ordinary_question_gains_nothing(self, client, coach_headers, playbook_quiz):
        """Only region questions are touched. An uploaded-image or optionless
        question keeps rendering exactly as it did."""
        payload = coach_quiz(client, coach_headers, playbook_quiz["quiz_id"])

        assert "masked_image_url" not in question_in(
            payload, playbook_quiz["plain_question_id"]
        )


class TestPlayerIsUnchanged:
    def test_the_player_still_receives_the_masked_url(self, client, playbook_quiz):
        started = client.post(
            "/api/play/start",
            json={"access_code_id": playbook_quiz["code"]["id"], "player_name": PLAYER},
        )

        assert started.status_code in (200, 201), started.get_json()
        question = next(
            q
            for q in started.get_json()["questions"]
            if q["id"] == playbook_quiz["region_question_id"]
        )
        assert question["masked_image_url"].startswith("/api/media/")

    def test_validate_code_still_carries_it(self, client, playbook_quiz):
        got = client.post(
            "/api/play/validate-code", json={"code": playbook_quiz["code"]["code"]}
        )

        assert got.status_code == 200, got.get_json()
        question = next(
            q
            for q in got.get_json()["quiz"]["questions"]
            if q["id"] == playbook_quiz["region_question_id"]
        )
        assert question["masked_image_url"].startswith("/api/media/")

    def test_both_audiences_reach_the_SAME_masked_pixels(
        self, client, coach_headers, playbook_quiz
    ):
        """The invariant stated as a test: what the coach previews and what the
        player answers are the same image, not two renders that happen to look
        alike."""
        coach_url = question_in(
            coach_quiz(client, coach_headers, playbook_quiz["quiz_id"]),
            playbook_quiz["region_question_id"],
        )["masked_image_url"]
        started = client.post(
            "/api/play/start",
            json={"access_code_id": playbook_quiz["code"]["id"], "player_name": PLAYER},
        ).get_json()
        player_url = next(
            q
            for q in started["questions"]
            if q["id"] == playbook_quiz["region_question_id"]
        )["masked_image_url"]

        assert client.get(coach_url).get_data() == client.get(player_url).get_data()


class TestNoUnmaskedLeak:
    def test_the_coach_payload_exposes_no_unmasked_page_or_storage_key(
        self, client, coach_headers, playbook_quiz
    ):
        """The rule this fix must not weaken. Greps the RAW body rather than
        inspecting fields, so a leak introduced anywhere in the shape is caught
        rather than only one that lands where a test happens to look."""
        blob = client.get(
            f"/api/quizzes/{playbook_quiz['quiz_id']}", headers=coach_headers
        ).get_data(as_text=True)

        assert "storage_key" not in blob
        assert "image_key" not in blob
        assert "thumbnail_key" not in blob
        assert "private/" not in blob

    def test_the_masked_token_cannot_be_repointed_at_the_raw_page(
        self, client, coach_headers, playbook_quiz
    ):
        """The masked URL is safe because no token kind resolves to an unmasked
        page for a QUESTION. Proven by decoding the issued token rather than
        assuming: it names the question and the mask kind."""
        import base64

        url = question_in(
            coach_quiz(client, coach_headers, playbook_quiz["quiz_id"]),
            playbook_quiz["region_question_id"],
        )["masked_image_url"]
        encoded = url.rsplit("/", 1)[1].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

        assert payload["k"] == "qmask"
        assert payload["i"] == playbook_quiz["region_question_id"]

    def test_the_coach_payload_leaks_no_answer_key_it_did_not_already_carry(
        self, client, coach_headers, playbook_quiz
    ):
        """A coach payload legitimately carries the key - it is the authoring
        surface. What this pins is that the PLAYER payload still does not, so
        the new attach could not have been wired into the wrong one."""
        started = client.post(
            "/api/play/start",
            json={"access_code_id": playbook_quiz["code"]["id"], "player_name": PLAYER},
        )

        blob = json.dumps(started.get_json())
        assert "is_correct_answer" not in blob
        assert "expected_answers" not in blob
        assert "answer_matching" not in blob


class TestDeliveredBehaviourUnchanged:
    def test_the_snapshot_still_records_no_region_geometry(
        self, app, client, playbook_quiz
    ):
        """THE REGION EXCEPTION IS UNCHANGED BY THIS FIX, deliberately. Closing
        it is the Option C work and is not what a Preview bug fix should
        smuggle in. Pinned so that remains a decision rather than a drift."""
        client.post(
            "/api/play/start",
            json={"access_code_id": playbook_quiz["code"]["id"], "player_name": PLAYER},
        )

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            rows = AttemptQuestionSnapshot.query.all()
            assert rows, "the attempt really did record a delivery"
            for row in rows:
                assert "region" not in (row.snapshot or {})
