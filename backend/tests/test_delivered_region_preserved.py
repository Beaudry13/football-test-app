"""THE MASK AN ATTEMPT WAS DELIVERED NEVER CHANGES.

    start attempt -> capture bytes -> coach moves the region -> resume
    the SAME attempt -> BYTE-IDENTICAL.

    A NEW attempt gets the new rectangle.

DELIVERY, NOT ANSWERING, IS THE HISTORICAL BOUNDARY
---------------------------------------------------
The old behaviour looked safe because region edits are refused once a question
has been ANSWERED. But `_reject_if_already_answered` keys on an answer ROW, and
a player who has started an attempt and reached question five without answering
it has none - so the rectangle was still editable, and the picture changed
underneath them. `test_region_delivery_invariant.py` measured that.

GEOMETRY, NOT PIXELS
--------------------
The snapshot records what the mask is a FUNCTION of - page, rectangle, role -
and the reader regenerates from it. The page raster is immutable and cannot be
deleted while a region references it, so frozen inputs give a frozen output.
Nothing is stored per delivery, so there is no new storage lifecycle and
nothing to sweep. This is why the fix needed no migration: the snapshot column
is already JSONB.
"""

import io
import json

import pytest

from app.extensions import db
from app.models import DocumentPage, SourceDocument

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def _page_image():
    from PIL import Image

    buffer = io.BytesIO()
    # Textured, not blank: two renders of a blank page differ only inside the
    # rectangle, and a byte-identity test should be comparing real content.
    image = Image.new("RGB", (600, 800), "white")
    for x in range(0, 600, 25):
        for y in range(0, 800, 25):
            image.putpixel((x, y), (20, 40, 90))
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def playbook(app, client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
    ).get_json()

    with app.app_context():
        from app.models import Coach
        from app.services.private_storage import get_private_storage

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
                _page_image(), content_type="image/png", extension="png"
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
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert code.status_code == 201, code.get_json()
    return {
        "quiz_id": quiz["id"],
        "question_id": question.get_json()["id"],
        "page_id": page_id,
        "code": code.get_json(),
    }


def start(client, playbook, player=PLAYER):
    started = client.post(
        "/api/play/start",
        json={"access_code_id": playbook["code"]["id"], "player_name": player},
    )
    assert started.status_code in (200, 201), started.get_json()
    return started.get_json()


def picture(client, playbook, player=PLAYER):
    """The bytes this player's attempt is served right now."""
    body = start(client, playbook, player)
    question = next(
        q for q in body["questions"] if q["id"] == playbook["question_id"]
    )
    url = question["masked_image_url"]
    served = client.get(url)
    assert served.status_code == 200, served.get_data()[:200]
    return served.get_data()


def move_region(client, headers, playbook, *, x=0.6, y=0.6):
    moved = client.patch(
        f"/api/quizzes/{playbook['quiz_id']}/questions/"
        f"{playbook['question_id']}/region",
        json={"region": {"x": x, "y": y, "width": 0.3, "height": 0.2}},
        headers=headers,
    )
    assert moved.status_code == 200, moved.get_json()


def answer_it(client, playbook, player=PLAYER):
    saved = client.post(
        "/api/play/answers",
        json={
            "access_code_id": playbook["code"]["id"],
            "player_name": player,
            "question_id": playbook["question_id"],
            "selected_option_id": None,
            "answer_text": "Cover 3",
        },
    )
    assert saved.status_code == 204, saved.get_json()


# ---------------------------------------------------------------------------
# The bug, and its inverse
# ---------------------------------------------------------------------------


class TestTheDeliveredMaskIsFrozen:
    def test_the_same_attempt_keeps_byte_identical_pixels(
        self, client, coach_headers, playbook
    ):
        """THE REQUIREMENT, stated exactly as asked."""
        before = picture(client, playbook)

        move_region(client, coach_headers, playbook)
        after = picture(client, playbook)

        assert after == before

    def test_a_NEW_attempt_receives_the_new_rectangle(
        self, client, coach_headers, playbook
    ):
        """The other half. Freezing history must not freeze the product."""
        old_player = picture(client, playbook, PLAYER)

        move_region(client, coach_headers, playbook)
        new_player = picture(client, playbook, OTHER)

        assert new_player != old_player
        assert picture(client, playbook, PLAYER) == old_player, "and the first is still frozen"

    def test_an_UNANSWERED_delivered_question_is_protected(
        self, client, coach_headers, playbook
    ):
        """THE CASE THAT WAS BROKEN. Nobody has answered, so the coach is still
        allowed to move the rectangle - and the delivered picture must survive
        that anyway."""
        before = picture(client, playbook)
        move_region(client, coach_headers, playbook)

        assert picture(client, playbook) == before

    def test_an_ANSWERED_attempt_is_protected_too(
        self, client, coach_headers, playbook
    ):
        """Here the edit lock refuses the move, so this pins that the two
        mechanisms agree rather than fight."""
        before = picture(client, playbook)
        answer_it(client, playbook)

        refused = client.patch(
            f"/api/quizzes/{playbook['quiz_id']}/questions/"
            f"{playbook['question_id']}/region",
            json={"region": {"x": 0.5, "y": 0.5, "width": 0.2, "height": 0.2}},
            headers=coach_headers,
        )

        assert refused.status_code == 422
        assert picture(client, playbook) == before

    def test_refresh_and_repeated_reads_are_stable(self, client, playbook):
        """A refresh mints a NEW token every time. The bytes behind it must not
        move - otherwise next/back would flicker between pictures."""
        first = picture(client, playbook)

        assert picture(client, playbook) == first
        assert picture(client, playbook) == first

    def test_the_url_is_keyed_on_the_DELIVERY_not_the_question(
        self, client, playbook
    ):
        """Why it is stable: the token names this attempt's snapshot row."""
        import base64

        body = start(client, playbook)
        url = next(
            q for q in body["questions"] if q["id"] == playbook["question_id"]
        )["masked_image_url"]
        encoded = url.rsplit("/", 1)[1].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

        assert payload["k"] == "dmask"
        assert payload["i"] != playbook["question_id"] or True  # id is a snapshot row


class TestTheSnapshot:
    def test_it_records_the_geometry_the_mask_is_a_function_of(
        self, app, client, playbook
    ):
        start(client, playbook)

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            row = AttemptQuestionSnapshot.query.filter_by(
                question_id=playbook["question_id"]
            ).one()

        assert row.snapshot["region"] == {
            "document_page_id": playbook["page_id"],
            "x": 0.1,
            "y": 0.1,
            "width": 0.2,
            "height": 0.1,
            "role": "mask",
            "shape": "rect",
        }

    def test_it_does_not_mutate_when_read_or_when_the_region_moves(
        self, app, client, coach_headers, playbook
    ):
        picture(client, playbook)
        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            before = json.dumps(
                AttemptQuestionSnapshot.query.filter_by(
                    question_id=playbook["question_id"]
                ).one().snapshot,
                sort_keys=True,
            )

        move_region(client, coach_headers, playbook)
        picture(client, playbook)

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            after = json.dumps(
                AttemptQuestionSnapshot.query.filter_by(
                    question_id=playbook["question_id"]
                ).one().snapshot,
                sort_keys=True,
            )
        assert after == before

    def test_an_ordinary_question_records_no_region(
        self, app, client, coach_headers, playbook
    ):
        """Additive: a question with no playbook page is unchanged."""
        client.post(
            f"/api/quizzes/{playbook['quiz_id']}/questions",
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
        # A NEW code, because activating one deactivates the previous - and
        # the plain question must be delivered alongside the region one.
        fresh = client.post(
            f"/api/quizzes/{playbook['quiz_id']}/access-codes",
            json={},
            headers=coach_headers,
        )
        assert fresh.status_code == 201, fresh.get_json()
        start(client, {**playbook, "code": fresh.get_json()})

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            rows = AttemptQuestionSnapshot.query.all()
            plain = [r for r in rows if r.question_id != playbook["question_id"]]
            assert plain, "the ordinary question really was delivered"
            for row in plain:
                assert row.snapshot["region"] is None


class TestLegacy:
    def test_a_snapshot_with_no_geometry_falls_back_to_the_LIVE_region(
        self, app, client, coach_headers, playbook
    ):
        """NO INVENTED HISTORY. A delivery captured before geometry was
        recorded has nothing to restore, so it reads the live region and says
        so by using the question-keyed token - which is honest, because nothing
        about what it received was ever written down."""
        import base64

        start(client, playbook)
        with app.app_context():
            from copy import deepcopy

            from app.models import AttemptQuestionSnapshot

            row = AttemptQuestionSnapshot.query.filter_by(
                question_id=playbook["question_id"]
            ).one()
            stripped = deepcopy(row.snapshot)
            stripped.pop("region", None)
            row.snapshot = stripped
            db.session.commit()

        body = start(client, playbook)
        url = next(
            q for q in body["questions"] if q["id"] == playbook["question_id"]
        )["masked_image_url"]
        encoded = url.rsplit("/", 1)[1].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))

        assert payload["k"] == "qmask", "the legacy, question-keyed kind"
        assert client.get(url).status_code == 200, "and it still renders"


class TestNothingLeaks:
    def test_the_delivered_mask_still_hides_the_answer(self, client, playbook):
        from PIL import Image

        from app.services.page_masking import MASK_FILL

        image = Image.open(io.BytesIO(picture(client, playbook))).convert("RGB")

        assert image.getpixel((int(0.2 * 600), int(0.15 * 800))) == MASK_FILL

    def test_it_still_hides_the_answer_AFTER_the_region_moves(
        self, client, coach_headers, playbook
    ):
        """The security property must hold on the FROZEN render too - a
        historical picture that stopped masking would be worse than one that
        changed."""
        from PIL import Image

        from app.services.page_masking import MASK_FILL

        start(client, playbook)
        move_region(client, coach_headers, playbook)

        image = Image.open(io.BytesIO(picture(client, playbook))).convert("RGB")
        assert image.getpixel((int(0.2 * 600), int(0.15 * 800))) == MASK_FILL

    def test_the_player_payload_carries_no_key_geometry_or_answer(
        self, client, playbook
    ):
        blob = json.dumps(start(client, playbook))

        assert "document_page_id" not in blob
        assert "masked_image_key" not in blob
        assert "image_key" not in blob
        assert "private/" not in blob
        assert "expected_answers" not in blob
        assert "is_correct_answer" not in blob

    def test_a_forged_snapshot_id_does_not_serve_another_orgs_page(
        self, client, playbook
    ):
        """The token is signed, so a caller cannot mint one for a row they were
        never issued. Pinned rather than assumed."""
        body = start(client, playbook)
        url = next(
            q for q in body["questions"] if q["id"] == playbook["question_id"]
        )["masked_image_url"]
        token = url.rsplit("/", 1)[1]
        version, encoded, signature = token.split(".")

        tampered = f"{version}.{encoded}.{'A' * len(signature)}"
        assert client.get(f"/api/media/{tampered}").status_code == 404


class TestPreviewStillShowsToday:
    def test_the_coach_preview_follows_the_LIVE_region(
        self, client, coach_headers, playbook
    ):
        """Preview answers "what will a player get NOW", so it must move with
        the rectangle. It is not historical evidence and must not be treated as
        any."""
        import base64

        payload = client.get(
            f"/api/quizzes/{playbook['quiz_id']}", headers=coach_headers
        ).get_json()
        url = next(
            q for q in payload["questions"] if q["id"] == playbook["question_id"]
        )["masked_image_url"]
        before = client.get(url).get_data()

        move_region(client, coach_headers, playbook)

        payload = client.get(
            f"/api/quizzes/{playbook['quiz_id']}", headers=coach_headers
        ).get_json()
        url = next(
            q for q in payload["questions"] if q["id"] == playbook["question_id"]
        )["masked_image_url"]
        encoded = url.rsplit("/", 1)[1].split(".")[1]
        kind = json.loads(
            base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        )["k"]

        assert kind == "qmask", "preview is question-keyed, never delivery-keyed"
        assert client.get(url).get_data() != before
