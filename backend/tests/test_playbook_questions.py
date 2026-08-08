"""The Playbook Quiz workflow end to end: region -> question -> play -> grade.

The Phase 3 experience is the reason this file drives the real API rather than
the services: three bugs there survived a green unit suite and were only found
by actually running the flow.
"""

import io

from reportlab.pdfgen import canvas as rl_canvas

from app.extensions import db
from app.models import Answer, DocumentPage, Question, QuestionRegion, QuestionType

REGION = {"x": 0.2, "y": 0.3, "width": 0.25, "height": 0.05}


def make_pdf(pages: int = 2):
    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, pagesize=(612, 792))
    for index in range(pages):
        canvas.setFont("Helvetica", 14)
        canvas.drawString(72, 700 - index * 20, f"INSTALL {index + 1} - COVER 3 BEATER")
        canvas.showPage()
    canvas.save()
    buffer.seek(0)
    return buffer


def upload_document(client, headers, pages: int = 2) -> dict:
    response = client.post(
        "/api/documents",
        headers=headers,
        data={"file": (make_pdf(pages), "install.pdf")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def create_quiz(client, headers, title: str = "Install 1") -> dict:
    response = client.post("/api/quizzes", headers=headers, json={"title": title})
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def create_region_question(
    client, headers, quiz_id: int, page_id: int, *, answers=None, region=None, text=None
):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/from-region",
        headers=headers,
        json={
            "document_page_id": page_id,
            "question_text": text or "What coverage is hidden here?",
            "expected_answers": answers if answers is not None else ["Cover 3", "C3"],
            "region": region or REGION,
        },
    )


def playbook_quiz(client, headers, answers=None):
    """A quiz with one region-backed Fill in the Blank question, ready to send."""
    document = upload_document(client, headers)
    quiz = create_quiz(client, headers)
    page_id = document["pages"][0]["id"]
    response = create_region_question(
        client, headers, quiz["id"], page_id, answers=answers
    )
    assert response.status_code == 201, response.get_json()
    return quiz, document, response.get_json()


def activate(client, headers, quiz_id: int) -> dict:
    """Publish the quiz: a roster, then an access code."""
    client.put(
        f"/api/quizzes/{quiz_id}/roster",
        headers=headers,
        json={"players": ["Jordan Smith"]},
    )
    response = client.post(f"/api/quizzes/{quiz_id}/access-codes", headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def answer_as_player(client, app, access_code, question_id: int, text: str):
    """Type an answer as a player and read back how the server graded it.

    is_correct is read from the database rather than the response on purpose:
    the /answers endpoint deliberately never tells a player whether they were
    right, and a test that could read it there would be asserting a leak.
    """
    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Jordan Smith"},
    )
    response = client.post(
        "/api/play/answers",
        json={
            "access_code_id": access_code["id"],
            "player_name": "Jordan Smith",
            "question_id": question_id,
            "selected_option_id": None,
            "answer_text": text,
        },
    )
    # 204 No Content, deliberately: the autosave endpoint tells a player
    # nothing about their answer, so there is no body that could leak whether
    # they were right.
    assert response.status_code == 204, response.get_json()
    assert response.data == b""
    with app.app_context():
        return Answer.query.filter_by(question_id=question_id).one().is_correct


class TestAuthoring:
    def test_creates_a_fill_blank_question_from_a_rectangle(self, client, coach_headers):
        _, _, question = playbook_quiz(client, coach_headers)

        assert question["question_type"] == "fill_blank"
        assert question["expected_answers"] == ["Cover 3", "C3"]
        assert question["answer_matching"] == "normalised"
        assert question["region"]["x"] == REGION["x"]
        assert question["region"]["role"] == "mask"
        # A fill-in-the-blank has no options and needs none.
        assert question["options"] == []

    def test_region_carries_the_page_dimensions_for_layout(self, client, coach_headers):
        _, _, question = playbook_quiz(client, coach_headers)
        assert question["region"]["render_width"] == 1275
        assert question["region"]["render_height"] == 1651
        assert question["region"]["page_number"] == 1

    def test_normalises_and_dedupes_the_accepted_answers(self, client, coach_headers):
        _, _, question = playbook_quiz(
            client, coach_headers, answers=["  Cover 3 ", "cover 3", "", "C3"]
        )
        assert question["expected_answers"] == ["Cover 3", "C3"]

    def test_rejects_a_region_outside_the_page(self, client, coach_headers):
        document = upload_document(client, coach_headers)
        quiz = create_quiz(client, coach_headers)
        response = create_region_question(
            client,
            coach_headers,
            quiz["id"],
            document["pages"][0]["id"],
            region={"x": 0.9, "y": 0.1, "width": 0.5, "height": 0.1},
        )
        assert response.status_code == 422

    def test_rejects_a_zero_area_region(self, client, coach_headers):
        document = upload_document(client, coach_headers)
        quiz = create_quiz(client, coach_headers)
        response = create_region_question(
            client,
            coach_headers,
            quiz["id"],
            document["pages"][0]["id"],
            region={"x": 0.2, "y": 0.2, "width": 0.0, "height": 0.1},
        )
        assert response.status_code == 422

    def test_rejects_blank_accepted_answers(self, client, coach_headers):
        document = upload_document(client, coach_headers)
        quiz = create_quiz(client, coach_headers)
        response = create_region_question(
            client, coach_headers, quiz["id"], document["pages"][0]["id"], answers=["  ", ""]
        )
        assert response.status_code == 422

    def test_cannot_build_a_question_from_another_organizations_playbook(
        self, client, register_coach
    ):
        _, _, owner = register_coach(username="owner", email="owner@example.com")
        document = upload_document(client, owner)

        _, _, rival = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        quiz = create_quiz(client, rival)
        response = create_region_question(
            client, rival, quiz["id"], document["pages"][0]["id"]
        )
        # 404, not 403 - a page id must not be probeable across organizations.
        assert response.status_code == 404

    def test_editing_moves_the_region_and_drops_the_stale_mask(
        self, client, coach_headers, app
    ):
        quiz, _, question = playbook_quiz(client, coach_headers)

        # Force the mask to be built and cached.
        with app.app_context():
            from app.services.page_masking import masked_render_bytes

            region = db.session.get(QuestionRegion, question["region"]["id"])
            masked_render_bytes(region)
            assert region.masked_image_key is not None
            stale_key = region.masked_image_key

        response = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/region",
            headers=coach_headers,
            json={"region": {"x": 0.5, "y": 0.5, "width": 0.2, "height": 0.05}},
        )
        assert response.status_code == 200

        with app.app_context():
            region = db.session.get(QuestionRegion, question["region"]["id"])
            assert region.x == 0.5
            # A moved rectangle whose old mask survived would keep covering the
            # wrong pixels - which means showing the player the answer.
            assert region.masked_image_key != stale_key
            from app.services.private_storage import get_private_storage

            assert get_private_storage().load_private(stale_key) is None


class TestPlayerNeverSeesTheAnswer:
    def test_the_coach_payload_carries_the_accepted_answers(self, client, coach_headers):
        quiz, _, _ = playbook_quiz(client, coach_headers)
        body = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
        assert body["questions"][0]["expected_answers"] == ["Cover 3", "C3"]

    def test_the_player_payload_does_not(self, client, coach_headers):
        quiz, _, _ = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        payload = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()

        # Checked field by field rather than as a substring of the whole
        # payload. The payload carries a base64 HMAC signature, and a short
        # answer like "C3" turns up inside random base64 often enough to make
        # a substring assertion flaky - it failed in a full run and passed
        # alone, which is exactly what that looks like.
        question = payload["quiz"]["questions"][0]
        assert "expected_answers" not in question
        assert "answer_matching" not in question
        assert "Cover 3" not in question["question_text"]
        assert question["options"] == []
        # Nothing in the region payload carries the answer either.
        assert set(question["region"]) == {
            "id", "question_id", "document_page_id", "shape", "x", "y", "width",
            "height", "role", "position", "page_number", "source_document_id",
            "render_width", "render_height",
        }

    def test_the_player_gets_a_masked_url_and_no_page_url(self, client, coach_headers):
        quiz, _, _ = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        question = (
            client.post("/api/play/validate-code", json={"code": code["code"]})
            .get_json()["quiz"]["questions"][0]
        )
        assert question["masked_image_url"].startswith("/api/media/")
        # The unmasked page is never addressable from a player payload.
        assert question["image"] is None
        assert "image_url" not in str(question["region"])

    def test_the_masked_render_actually_covers_the_region(self, client, coach_headers, app):
        from PIL import Image

        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        payload = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        url = payload["quiz"]["questions"][0]["masked_image_url"]

        masked = client.get(url)
        assert masked.status_code == 200
        image = Image.open(io.BytesIO(masked.data)).convert("RGB")

        # Sample the middle of the masked rectangle: it must be the mask fill,
        # not page content.
        from app.services.page_masking import MASK_FILL

        x = int((REGION["x"] + REGION["width"] / 2) * image.width)
        y = int((REGION["y"] + REGION["height"] / 2) * image.height)
        assert image.getpixel((x, y)) == MASK_FILL

        # And a point well outside it must NOT be masked, or the whole page
        # was covered and the question is unanswerable.
        assert image.getpixel((int(image.width * 0.05), int(image.height * 0.95))) != MASK_FILL


class TestAutoGrading:
    def test_a_correct_answer_is_graded_immediately(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        assert answer_as_player(client, app, code, question["id"], "cover 3") is True

    def test_an_accepted_variant_is_correct(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        assert answer_as_player(client, app, code, question["id"], "  C3 ") is True

    def test_a_wrong_answer_is_marked_incorrect(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        assert answer_as_player(client, app, code, question["id"], "Cover 2") is False

    def test_a_blank_answer_is_ungraded_not_wrong(self, client, coach_headers, app):
        # Scoring an unanswered question 0 is exactly the "fabricating 0% when
        # nothing is graded" CLAUDE.md forbids.
        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        assert answer_as_player(client, app, code, question["id"], "   ") is None

    def test_regrades_when_the_player_changes_their_answer(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        assert answer_as_player(client, app, code, question["id"], "Cover 2") is False
        assert answer_as_player(client, app, code, question["id"], "Cover 3") is True

    def test_it_is_not_in_the_manual_grading_queue(self, client, coach_headers):
        from app.models.question import MANUALLY_GRADED_TYPES

        assert QuestionType.FILL_BLANK not in MANUALLY_GRADED_TYPES


class TestActivationGuard:
    def test_blocks_a_question_whose_answers_vanished(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        with app.app_context():
            db.session.get(Question, question["id"]).expected_answers = []
            db.session.commit()

        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            headers=coach_headers,
            json={"players": ["Jordan Smith"]},
        )
        response = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers)
        assert response.status_code == 422
        assert "accepted" in response.get_json()["error"].lower()

    def test_blocks_a_question_whose_region_vanished(self, client, coach_headers, app):
        quiz, _, question = playbook_quiz(client, coach_headers)
        with app.app_context():
            region = db.session.get(QuestionRegion, question["region"]["id"])
            db.session.delete(region)
            db.session.commit()

        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            headers=coach_headers,
            json={"players": ["Jordan Smith"]},
        )
        response = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers)
        assert response.status_code == 422


class TestDocumentDeletionIsGuarded:
    def test_refuses_while_a_quiz_still_uses_the_playbook(self, client, coach_headers):
        quiz, document, _ = playbook_quiz(client, coach_headers)

        response = client.delete(f"/api/documents/{document['id']}", headers=coach_headers)
        # 409, and it names the quiz - "it's in use" without saying where is a
        # dead end for a coach.
        assert response.status_code == 409
        assert quiz["title"] in response.get_json()["error"]

    def test_allowed_once_the_quiz_is_gone(self, client, coach_headers):
        quiz, document, _ = playbook_quiz(client, coach_headers)
        assert client.delete(f"/api/quizzes/{quiz['id']}", headers=coach_headers).status_code == 204
        assert (
            client.delete(f"/api/documents/{document['id']}", headers=coach_headers).status_code
            == 204
        )


class TestDuplication:
    def test_a_duplicated_quiz_keeps_its_answers_and_region(self, client, coach_headers):
        quiz, _, _ = playbook_quiz(client, coach_headers)
        copy = client.post(
            f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers
        ).get_json()

        body = client.get(f"/api/quizzes/{copy['id']}", headers=coach_headers).get_json()
        question = body["questions"][0]
        # Without this a duplicated question would keep its type but lose its
        # answers, marking every player wrong for reasons invisible to a coach.
        assert question["expected_answers"] == ["Cover 3", "C3"]
        assert question["region"] is not None
        assert question["region"]["x"] == REGION["x"]

    def test_the_copy_does_not_share_the_originals_cached_mask(
        self, client, coach_headers, app
    ):
        quiz, _, question = playbook_quiz(client, coach_headers)
        with app.app_context():
            from app.services.page_masking import masked_render_bytes

            masked_render_bytes(db.session.get(QuestionRegion, question["region"]["id"]))

        copy = client.post(
            f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers
        ).get_json()
        with app.app_context():
            copied = (
                db.session.query(QuestionRegion)
                .join(Question, Question.id == QuestionRegion.question_id)
                .filter(Question.quiz_id == copy["id"])
                .one()
            )
            # Sharing the key would mean deleting one question's mask blanked
            # the other's.
            assert copied.masked_image_key is None


class TestOneImageSourcePerQuestion:
    """A question gets its picture from an uploaded still OR a page region,
    never both - otherwise "what image does this question show" has two
    answers and the renderer has to guess."""

    def test_uploading_an_image_to_a_region_question_is_refused(
        self, client, coach_headers
    ):
        from tests.conftest import make_image_file

        quiz, _, question = playbook_quiz(client, coach_headers)
        image, name = make_image_file()

        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            headers=coach_headers,
            data={"image": (image, name)},
            content_type="multipart/form-data",
        )
        assert response.status_code == 422
        assert "playbook" in response.get_json()["error"].lower()

    def test_the_question_still_has_only_its_region(self, client, coach_headers, app):
        from tests.conftest import make_image_file

        quiz, _, question = playbook_quiz(client, coach_headers)
        image, name = make_image_file()
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            headers=coach_headers,
            data={"image": (image, name)},
            content_type="multipart/form-data",
        )

        with app.app_context():
            stored = db.session.get(Question, question["id"])
            assert stored.image is None
            assert len(stored.regions) == 1
