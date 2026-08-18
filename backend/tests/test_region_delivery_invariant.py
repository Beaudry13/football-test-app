"""CHARACTERISATION: what a player was shown IS currently rewritable.

THE DOCUMENTED ASSUMPTION, AND WHY IT IS WRONG
-----------------------------------------------
CLAUDE.md records THE REGION EXCEPTION like this: a region question's masked
URL comes from the LIVE region, and that "is only truthful while region editing
stays blocked after delivery."

Region editing is NOT blocked after delivery. `_reject_if_already_answered`
fires when an ANSWER ROW EXISTS - not when the question has been delivered. A
player who has started an attempt and reached question five without answering
it has a snapshot recording the delivery, and the coach can still move that
question's rectangle.

So the gap is reachable with no unusual sequence at all:

    player starts   ->  coach fixes a mask  ->  player continues

and the picture under the player changes mid-attempt.

WHAT THESE TESTS ARE
--------------------
They assert TODAY'S behaviour, including the part that is wrong. They exist to
make the gap a measured fact rather than an inference, and to fail loudly when
Option C fixes it - at which point the assertions marked THE BUG get inverted
rather than deleted.
"""

import io

import pytest

from app.extensions import db
from app.models import DocumentPage, SourceDocument

PLAYER = "Jordan Smith"


@pytest.fixture
def region_quiz(app, client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
    ).get_json()

    with app.app_context():
        from PIL import Image

        from app.models import Coach
        from app.services.private_storage import get_private_storage

        buffer = io.BytesIO()
        # Deliberately NOT flat white: a mask drawn on a blank page produces
        # bytes that differ only inside the rectangle, and a test comparing
        # whole renders should be comparing real content.
        image = Image.new("RGB", (600, 800), "white")
        for x in range(0, 600, 40):
            for y in range(0, 800, 40):
                image.putpixel((x, y), (20, 40, 90))
        image.save(buffer, format="PNG")

        coach = Coach.query.filter_by(username="coach1").one()
        source = SourceDocument(
            organization_id=coach.organization_id,
            uploaded_by_coach_id=coach.id,
            title="Defensive Playbook",
            original_filename="d.pdf",
            storage_key="never-served",
            byte_size=10,
            page_count=1,
            content_hash="0" * 64,
        )
        db.session.add(source)
        db.session.flush()
        page = DocumentPage(
            source_document_id=source.id,
            page_number=1,
            width_pt=612.0,
            height_pt=792.0,
            render_width=600,
            render_height=800,
            render_dpi=150,
            renderer_version="test/1.0",
            image_key=get_private_storage().save_private(
                buffer.getvalue(), content_type="image/png", extension="png"
            ),
        )
        db.session.add(page)
        db.session.commit()
        page_id = page.id

    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions/from-region",
        json={
            "question_text": "WHAT COVERAGE IS THIS?",
            "document_page_id": page_id,
            "region": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1},
            "expected_answers": ["Cover 3"],
            "answer_matching": "normalised",
            "position": None,
        },
        headers=coach_headers,
    )
    assert question.status_code == 201, question.get_json()

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
        "question_id": question.get_json()["id"],
        "code": code.get_json(),
    }


def delivered_picture(client, region_quiz):
    """The bytes this attempt is served for its region question, right now."""
    started = client.post(
        "/api/play/start",
        json={"access_code_id": region_quiz["code"]["id"], "player_name": PLAYER},
    )
    assert started.status_code in (200, 201), started.get_json()
    question = next(
        q
        for q in started.get_json()["questions"]
        if q["id"] == region_quiz["question_id"]
    )
    served = client.get(question["masked_image_url"])
    assert served.status_code == 200
    return served.get_data()


def move_the_mask(client, headers, region_quiz):
    moved = client.patch(
        f"/api/quizzes/{region_quiz['quiz_id']}/questions/"
        f"{region_quiz['question_id']}/region",
        json={"region": {"x": 0.6, "y": 0.6, "width": 0.3, "height": 0.2}},
        headers=headers,
    )
    return moved


class TestTheLockIsAboutAnswering:
    def test_a_delivered_but_unanswered_question_can_still_be_moved(
        self, client, coach_headers, region_quiz
    ):
        """THE PREMISE THAT FAILS. Delivery does not lock a region; only an
        answer row does."""
        delivered_picture(client, region_quiz)  # snapshot written

        moved = move_the_mask(client, coach_headers, region_quiz)

        assert moved.status_code == 200, moved.get_json()

    def test_once_answered_it_IS_locked(self, client, coach_headers, region_quiz):
        """The guard that does exist, so the distinction is not guesswork."""
        delivered_picture(client, region_quiz)
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": region_quiz["code"]["id"],
                "player_name": PLAYER,
                "question_id": region_quiz["question_id"],
                "selected_option_id": None,
                "answer_text": "Cover 3",
            },
        )

        moved = move_the_mask(client, coach_headers, region_quiz)

        assert moved.status_code == 422
        assert "already answered" in moved.get_json()["error"]


class TestTheDeliveredPictureIsRewritable:
    def test_THE_BUG_an_in_progress_attempt_sees_the_new_mask(
        self, client, coach_headers, region_quiz
    ):
        """A PLAYER'S PICTURE CHANGES UNDERNEATH THEM.

        This asserts the CURRENT, WRONG behaviour. When Option C lands, this
        assertion inverts to `==` - it is written this way so the fix cannot
        land without something failing here and forcing the record to be
        updated deliberately.
        """
        before = delivered_picture(client, region_quiz)

        assert move_the_mask(client, coach_headers, region_quiz).status_code == 200
        after = delivered_picture(client, region_quiz)

        assert before != after, (
            "if this now passes as equal, the delivered picture has become "
            "immutable - invert this assertion and update the region exception"
        )

    def test_the_snapshot_records_nothing_that_could_restore_it(
        self, app, client, region_quiz
    ):
        """WHY it is rewritable: the delivery record has no picture in it. The
        reader has nothing to fall back on but the live region."""
        delivered_picture(client, region_quiz)

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            row = AttemptQuestionSnapshot.query.filter_by(
                question_id=region_quiz["question_id"]
            ).one()

            assert row.snapshot.get("image") is None
            assert "region" not in row.snapshot
            assert "masked" not in str(row.snapshot)


class TestWhatIsAlreadySafe:
    def test_the_playbook_cannot_be_deleted_while_a_question_uses_it(
        self, client, coach_headers, region_quiz, app
    ):
        """The protection that DOES hold today, and the reason the gap has not
        already destroyed evidence: RESTRICT on the page FK."""
        with app.app_context():
            source_id = SourceDocument.query.one().id

        deleted = client.delete(f"/api/documents/{source_id}", headers=coach_headers)

        assert deleted.status_code == 409, deleted.get_json()

    def test_the_mask_still_hides_the_answer(self, client, region_quiz):
        """Whatever else is unstable, the security property is not: the player
        receives pixels with the rectangle already filled in."""
        picture = delivered_picture(client, region_quiz)

        from PIL import Image

        from app.services.page_masking import MASK_FILL

        image = Image.open(io.BytesIO(picture)).convert("RGB")
        # Inside the region the fixture drew at (0.1, 0.1)-(0.3, 0.2).
        assert image.getpixel((int(0.2 * 600), int(0.15 * 800))) == MASK_FILL
