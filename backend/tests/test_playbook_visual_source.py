"""Q2 - A PLAYBOOK PAGE IS A PICTURE, NOT A QUESTION TYPE.

    A coach chooses HOW THE PLAYER ANSWERS (multiple choice, select all,
    fill in the blank, written, draw) and, separately, WHAT THEY SEE.
    A playbook page is one option for the second. It implies nothing
    about the first.

THE ONE THING THE COACH DECIDES, EXPRESSED AS PRESENCE
------------------------------------------------------
No "role" crosses the API. A coach who picked a page and hid nothing sends a
page; a coach who hid something sends the rectangle they drew. The presence of
that rectangle IS the difference, so the words mask, region, crop and role stay
on our side of the boundary.

WHY A WHOLE PAGE IS NOT A WHOLE-PAGE MASK
-----------------------------------------
The region machinery was built for hiding things, and `_apply_region` used to
hardcode MASK. A whole-page MASK blacks out the entire picture - so a page used
as a picture is stored as a CROP covering the page, which renders it untouched.
`TestTheWholePageIsNotBlackedOut` is that guarantee, asserted on PIXELS rather
than on a role string, because the role is an implementation detail and the
pixels are what a player actually receives.
"""

import io

import pytest

from app.extensions import db
from app.models import DocumentPage, SourceDocument

PLAYER = "Jordan Smith"

#: Where the fixture paints a bright marker on the page. A question that hides
#: something covers this; a question that does not must leave it visible.
MARKER = (0.20, 0.15)
MARKER_COLOUR = (250, 60, 40)
HIDE_RECT = {"x": 0.10, "y": 0.08, "width": 0.25, "height": 0.16}


@pytest.fixture
def page_id(app, client, coach_headers):
    from PIL import Image

    from app.models import Coach
    from app.services.private_storage import get_private_storage

    with app.app_context():
        image = Image.new("RGB", (600, 800), "white")
        # A solid block, so a single sampled pixel is not a lucky hit.
        for x in range(int(0.16 * 600), int(0.28 * 600)):
            for y in range(int(0.11 * 800), int(0.20 * 800)):
                image.putpixel((x, y), MARKER_COLOUR)
        buffer = io.BytesIO()
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
        return page.id


@pytest.fixture
def quiz_id(client, coach_headers):
    return client.post(
        "/api/quizzes", json={"title": "Install"}, headers=coach_headers
    ).get_json()["id"]


def make(client, headers, quiz_id, question_type, page_id=None, hide=None, **extra):
    """Create a question of `question_type`, optionally using a playbook page,
    optionally hiding one rectangle on it."""
    body = {
        "question_text": "WHAT COVERAGE IS THIS?",
        "question_type": question_type,
        "options": extra.pop("options", []),
        **extra,
    }
    if page_id is not None:
        body["document_page_id"] = page_id
    if hide is not None:
        body["region"] = hide
    return client.post(
        f"/api/quizzes/{quiz_id}/questions", json=body, headers=headers
    )


def picture_of(client, headers, quiz_id, question_id) -> bytes:
    """The bytes a coach's Preview is served for this question."""
    payload = client.get(f"/api/quizzes/{quiz_id}", headers=headers).get_json()
    question = next(q for q in payload["questions"] if q["id"] == question_id)
    assert question["masked_image_url"], "a playbook question must carry a picture"
    served = client.get(question["masked_image_url"])
    assert served.status_code == 200
    return served.get_data()


def colour_at(image_bytes: bytes, spot) -> tuple:
    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    fx, fy = spot
    return image.getpixel((int(fx * image.width), int(fy * image.height)))


def looks_hidden(colour) -> bool:
    """Dark and desaturated - the mask fill, not the bright marker under it."""
    return sum(colour) < 200


# ---------------------------------------------------------------------------
# The picture is independent of how the player answers
# ---------------------------------------------------------------------------


ANSWER_TYPES = [
    ("multiple_choice", {"options": [
        {"option_text": "Cover 2", "is_correct_answer": True},
        {"option_text": "Cover 3", "is_correct_answer": False},
    ]}),
    ("multiple_choice_multi", {"options": [
        {"option_text": "Mike", "is_correct_answer": True},
        {"option_text": "Will", "is_correct_answer": True},
        {"option_text": "Nickel", "is_correct_answer": False},
    ], "allows_multiple_answers": True}),
    ("fill_blank", {"expected_answers": ["Cover 3"], "answer_matching": "normalised"}),
    ("written", {}),
    ("draw_response", {}),
]


class TestEveryAnswerTypeCanUseAPlaybookPage:
    @pytest.mark.parametrize("kind,extra", ANSWER_TYPES)
    def test_it_is_created_with_the_type_the_coach_chose(
        self, client, coach_headers, quiz_id, page_id, kind, extra
    ):
        """THE POINT OF THE WHOLE PHASE. Choosing a playbook picture must not
        silently turn the question into Fill in the Blank, which is what the
        old dedicated route did to every question it made."""
        question_type = "multiple_choice" if kind == "multiple_choice_multi" else kind

        made = make(
            client, coach_headers, quiz_id, question_type, page_id=page_id, **extra
        )

        assert made.status_code == 201, made.get_json()
        body = made.get_json()
        assert body["question_type"] == question_type
        assert body["region"] is not None, "it really did attach the page"

    @pytest.mark.parametrize("kind,extra", ANSWER_TYPES)
    def test_the_player_receives_the_picture(
        self, client, coach_headers, quiz_id, page_id, kind, extra
    ):
        question_type = "multiple_choice" if kind == "multiple_choice_multi" else kind
        made = make(
            client, coach_headers, quiz_id, question_type, page_id=page_id, **extra
        ).get_json()

        assert picture_of(client, coach_headers, quiz_id, made["id"])[:4] in (
            b"RIFF",
            b"\x89PNG",
        )

    def test_multi_select_keeps_its_setting(
        self, client, coach_headers, quiz_id, page_id
    ):
        made = make(
            client, coach_headers, quiz_id, "multiple_choice", page_id=page_id,
            options=[
                {"option_text": "Mike", "is_correct_answer": True},
                {"option_text": "Will", "is_correct_answer": True},
            ],
            allows_multiple_answers=True,
        )

        assert made.get_json()["allows_multiple_answers"] is True


# ---------------------------------------------------------------------------
# Whole page vs hiding something
# ---------------------------------------------------------------------------


class TestTheWholePageIsNotBlackedOut:
    def test_a_page_used_as_a_picture_renders_untouched(
        self, client, coach_headers, quiz_id, page_id
    ):
        """THE BUG THIS PHASE HAD TO FIX. The region machinery was built for
        hiding things and defaulted to MASK, so a whole-page picture would have
        arrived as a solid black rectangle.

        Asserted on PIXELS, not on a role string: the role is ours, the pixels
        are what a player actually gets.
        """
        made = make(
            client, coach_headers, quiz_id, "written", page_id=page_id
        ).get_json()

        picture = picture_of(client, coach_headers, quiz_id, made["id"])

        assert colour_at(picture, MARKER) == MARKER_COLOUR, "the page is intact"

    def test_hiding_something_covers_exactly_that(
        self, client, coach_headers, quiz_id, page_id
    ):
        made = make(
            client, coach_headers, quiz_id, "written", page_id=page_id, hide=HIDE_RECT
        ).get_json()

        picture = picture_of(client, coach_headers, quiz_id, made["id"])

        assert looks_hidden(colour_at(picture, MARKER)), "the marker is covered"
        assert not looks_hidden(colour_at(picture, (0.8, 0.8))), "the rest is not"

    def test_the_two_differ(self, client, coach_headers, quiz_id, page_id):
        """Guards against both paths accidentally producing the same render -
        which would make either of the tests above pass for the wrong reason."""
        plain = make(
            client, coach_headers, quiz_id, "written", page_id=page_id
        ).get_json()
        hidden = make(
            client, coach_headers, quiz_id, "written", page_id=page_id, hide=HIDE_RECT
        ).get_json()

        assert picture_of(client, coach_headers, quiz_id, plain["id"]) != picture_of(
            client, coach_headers, quiz_id, hidden["id"]
        )


# ---------------------------------------------------------------------------
# Nothing else moved
# ---------------------------------------------------------------------------


class TestUnchanged:
    def test_a_question_with_no_playbook_page_has_no_picture(
        self, client, coach_headers, quiz_id
    ):
        """The coach who never opens a playbook. Nothing is attached, nothing
        is implied, and the payload gains no picture."""
        made = make(
            client, coach_headers, quiz_id, "multiple_choice",
            options=[
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ],
        )

        assert made.status_code == 201, made.get_json()
        assert made.get_json()["region"] is None
        assert made.get_json()["image"] is None

    def test_the_bulk_route_still_hides_its_rectangle(
        self, client, coach_headers, quiz_id, page_id
    ):
        """The playbook's fast path is unchanged: there the rectangle IS the
        thing being hidden, so it must still render as a mask."""
        made = client.post(
            f"/api/quizzes/{quiz_id}/questions/from-region",
            json={
                "question_text": "WHAT COVERAGE IS THIS?",
                "document_page_id": page_id,
                "region": HIDE_RECT,
                "expected_answers": ["Cover 3"],
                "answer_matching": "normalised",
                "position": None,
            },
            headers=coach_headers,
        )
        assert made.status_code == 201, made.get_json()
        assert made.get_json()["question_type"] == "fill_blank"

        picture = picture_of(client, coach_headers, quiz_id, made.get_json()["id"])
        assert looks_hidden(colour_at(picture, MARKER))

    def test_a_foreign_page_is_refused(self, client, coach_headers, quiz_id):
        """Ids from a client are never trusted. 404 rather than 403, so an id
        cannot be probed for existence."""
        refused = make(
            client, coach_headers, quiz_id, "written", page_id=999_999_999
        )

        assert refused.status_code == 404

    def test_no_unmasked_page_or_key_reaches_the_coach_payload(
        self, client, coach_headers, quiz_id, page_id
    ):
        make(client, coach_headers, quiz_id, "written", page_id=page_id, hide=HIDE_RECT)

        blob = client.get(
            f"/api/quizzes/{quiz_id}", headers=coach_headers
        ).get_data(as_text=True)

        for forbidden in ("image_key", "thumbnail_key", "storage_key", "private/"):
            assert forbidden not in blob, forbidden


class TestHistoricalIntegrity:
    def test_the_delivered_picture_is_frozen(
        self, app, client, coach_headers, quiz_id, page_id
    ):
        """Q2 adds a way to CREATE these; it must not add a second way to
        remember them. The freezing built in fd39fe2 applies unchanged."""
        made = make(
            client, coach_headers, quiz_id, "written", page_id=page_id
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        ).get_json()

        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": PLAYER},
        ).get_json()
        question = next(q for q in started["questions"] if q["id"] == made["id"])
        before = client.get(question["masked_image_url"]).get_data()

        # The coach now hides something on the live question.
        client.patch(
            f"/api/quizzes/{quiz_id}/questions/{made['id']}/region",
            json={"region": HIDE_RECT},
            headers=coach_headers,
        )

        resumed = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": PLAYER},
        ).get_json()
        again = next(q for q in resumed["questions"] if q["id"] == made["id"])

        assert client.get(again["masked_image_url"]).get_data() == before

    def test_the_snapshot_records_the_delivered_geometry(
        self, app, client, coach_headers, quiz_id, page_id
    ):
        made = make(
            client, coach_headers, quiz_id, "written", page_id=page_id
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz_id}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        ).get_json()
        client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": PLAYER},
        )

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            region = AttemptQuestionSnapshot.query.filter_by(
                question_id=made["id"]
            ).one().snapshot["region"]

        assert region["document_page_id"] == page_id
        assert region["document_title"] == "Defensive Playbook"
        assert region["page_number"] == 1
