"""P0 - A FINISHED PEIRA SHOWS WHICH PLAY WAS ASKED ABOUT.

THE GAP
-------
A playbook question has no `question_images` row, so every surface that renders
a picture from `question.image` had nothing to render. The detailed PDF - which
DOES show an image for every ordinary question type - simply had a hole where
the play should be. A coach reviewing a completed Peira could read the question
and the answer but never see what the player was actually looking at.

SCOPE IS PARITY, DELIBERATELY
-----------------------------
Only the PDF and the CSV. Player Results and the coach's expanded row are NOT
touched, because they do not show an image for ORDINARY image questions either
- adding one only for playbook questions would make them a special case, and
adding one for everything is a Results redesign this phase refuses to become.
Recorded in the improvement bank as RESULTS IMAGE PARITY.

THE PDF USES THE DELIVERED RECTANGLE, NOT THE LIVE ONE
------------------------------------------------------
Same frozen geometry the player's own resume reads (`fd39fe2`), so a coach who
has since moved the rectangle cannot change a report that has already been
shared.

THE CSV CANNOT HOLD A PICTURE, SO IT HOLDS A REFERENCE
------------------------------------------------------
"Defensive Playbook - Page 12" - enough for a coach to open the right playbook
at the right page, and nothing else. No id, coordinate, URL or token. Both
halves are frozen at delivery: the page number could be looked up live and stay
honest, but a playbook can be RENAMED, and a rename must not rewrite the export
of a Peira that finished months ago.
"""

import csv
import io

import pytest

from app.extensions import db
from app.models import DocumentPage, SourceDocument

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"
TITLE = "Defensive Playbook"


@pytest.fixture
def playbook(app, client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Install"}, headers=coach_headers
    ).get_json()

    with app.app_context():
        from PIL import Image

        from app.models import Coach
        from app.services.private_storage import get_private_storage

        buffer = io.BytesIO()
        image = Image.new("RGB", (600, 800), "white")
        for x in range(0, 600, 40):
            for y in range(0, 800, 40):
                image.putpixel((x, y), (20, 40, 90))
        image.save(buffer, format="PNG")

        coach = Coach.query.filter_by(username="coach1").one()
        source = SourceDocument(
            organization_id=coach.organization_id,
            uploaded_by_coach_id=coach.id,
            title=TITLE,
            original_filename="d.pdf",
            storage_key="never-served",
            byte_size=10,
            page_count=12,
            content_hash="0" * 64,
        )
        db.session.add(source)
        db.session.flush()
        page = DocumentPage(
            source_document_id=source.id,
            # NOT page 1: a test whose expected page number is 1 passes against
            # code that hardcodes it, prints an index, or is simply off by one.
            page_number=12,
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
        page_id, source_id = page.id, source.id

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
        "source_id": source_id,
        "code": code.get_json(),
    }


def start(client, playbook, player=PLAYER) -> bytes:
    """Begin an attempt and return the masked bytes it was SERVED.

    Split from submitting because the only way to reach "this attempt was
    delivered rectangle A while the live one is now B" is to move the region
    BETWEEN the two - once an answer row exists the coach is refused, which is
    the product lock working and is deliberately left in place.
    """
    started = client.post(
        "/api/play/start",
        json={"access_code_id": playbook["code"]["id"], "player_name": player},
    )
    assert started.status_code in (200, 201), started.get_json()
    question = next(
        q
        for q in started.get_json()["questions"]
        if q["id"] == playbook["question_id"]
    )
    served = client.get(question["masked_image_url"])
    assert served.status_code == 200
    return served.get_data()


def submit(client, playbook, player=PLAYER, answer="Cover 3"):
    client.post(
        "/api/play/submit",
        json={
            "access_code_id": playbook["code"]["id"],
            "player_name": player,
            "answers": [
                {
                    "question_id": playbook["question_id"],
                    "selected_option_id": None,
                    "answer_text": answer,
                }
            ],
        },
    )


def take_it(client, playbook, player=PLAYER, answer="Cover 3") -> bytes:
    served = start(client, playbook, player)
    submit(client, playbook, player, answer)
    return served


def csv_rows(client, headers, quiz_id):
    got = client.get(f"/api/quizzes/{quiz_id}/export.csv", headers=headers)
    assert got.status_code == 200
    return list(csv.reader(io.StringIO(got.get_data(as_text=True))))


def pdf_bytes(client, headers, quiz_id):
    got = client.get(f"/api/quizzes/{quiz_id}/export-detailed.pdf", headers=headers)
    assert got.status_code == 200, got.get_data()[:200]
    return got.get_data()


def pdf_images(pdf: bytes) -> list[bytes]:
    """Every embedded image's bytes, so a picture can be compared rather than
    merely counted. Counting would pass against a report that embedded the
    WRONG play."""
    from pypdf import PdfReader

    found = []
    for page in PdfReader(io.BytesIO(pdf)).pages:
        for image in page.images:
            found.append(image.data)
    return found


#: The rectangle the fixture delivers, and the one the coach moves it to.
DELIVERED_RECT = (0.1, 0.1, 0.2, 0.1)
MOVED_RECT = (0.6, 0.6, 0.3, 0.2)


def _centre(rect):
    x, y, w, h = rect
    return x + w / 2, y + h / 2


def is_masked_at(image_bytes: bytes, rect) -> bool:
    """Is the centre of `rect` covered by a mask in this picture?

    COMPARED BY WHERE THE MASK IS, not by bytes. ReportLab re-encodes and
    resamples whatever it embeds, so the PDF's copy is never byte-identical to
    the WEBP the player was served - a byte comparison fails for a reason that
    has nothing to do with which rectangle was used. The rectangle's POSITION
    is the thing under test, and it survives re-encoding.
    """
    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    fx, fy = _centre(rect)
    pixel = image.getpixel(
        (min(int(fx * image.width), image.width - 1),
         min(int(fy * image.height), image.height - 1))
    )
    # The mask is near-black; the page under it is white with sparse dark dots,
    # so "dark" is decisive here without depending on exact re-encoded values.
    return sum(pixel) < 200


def play_picture(pdf: bytes) -> bytes:
    """The playbook page from a report, as the LARGEST embedded image.

    Unambiguous, unlike "the dark one": the report also embeds the Peira mark,
    and the mark is small but happens to be dark at both rectangles'
    coordinates - so identifying the page by brightness finds the logo. The
    page render dwarfs it.
    """
    from PIL import Image

    images = pdf_images(pdf)
    assert images, "the report embedded no images at all"
    return max(images, key=lambda raw: (lambda i: i.width * i.height)(Image.open(io.BytesIO(raw))))


def move_region(client, headers, playbook):
    return client.patch(
        f"/api/quizzes/{playbook['quiz_id']}/questions/"
        f"{playbook['question_id']}/region",
        json={"region": {"x": 0.6, "y": 0.6, "width": 0.3, "height": 0.2}},
        headers=headers,
    )


def rename_playbook(client, headers, playbook, title):
    renamed = client.patch(
        f"/api/documents/{playbook['source_id']}",
        json={"title": title},
        headers=headers,
    )
    assert renamed.status_code == 200, renamed.get_json()


# ---------------------------------------------------------------------------
# The snapshot
# ---------------------------------------------------------------------------


class TestTheSnapshotRecordsWhatACoachReads:
    def test_it_captures_the_title_and_the_page_number(self, app, client, playbook):
        take_it(client, playbook)

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            region = AttemptQuestionSnapshot.query.filter_by(
                question_id=playbook["question_id"]
            ).one().snapshot["region"]

        assert region["document_title"] == TITLE
        assert region["page_number"] == 12

    def test_the_page_number_is_the_one_the_coach_sees(self, app, client, playbook):
        """1-based, matching the PDF and the page strip - not an array index."""
        take_it(client, playbook)

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            row = AttemptQuestionSnapshot.query.filter_by(
                question_id=playbook["question_id"]
            ).one()
            page = db.session.get(DocumentPage, playbook["page_id"])

        assert row.snapshot["region"]["page_number"] == page.page_number == 12


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------


class TestCsv:
    def test_it_prints_a_human_reference(self, client, coach_headers, playbook):
        take_it(client, playbook)

        row = csv_rows(client, coach_headers, playbook["quiz_id"])[1]

        assert "Defensive Playbook - Page 12" in row

    def test_a_LATER_RENAME_does_not_rewrite_history(
        self, client, coach_headers, playbook
    ):
        """THE REASON THE TITLE IS FROZEN. A playbook is renameable, so a
        reference resolved live would silently rewrite the export of a Peira
        that finished months ago."""
        take_it(client, playbook)
        rename_playbook(client, coach_headers, playbook, "2027 Defense (rewritten)")

        row = csv_rows(client, coach_headers, playbook["quiz_id"])[1]

        assert "Defensive Playbook - Page 12" in row
        assert not any("rewritten" in cell for cell in row)

    def test_it_carries_no_ids_urls_tokens_or_coordinates(
        self, client, coach_headers, playbook
    ):
        take_it(client, playbook)

        blob = "".join(
            "".join(r) for r in csv_rows(client, coach_headers, playbook["quiz_id"])
        )

        # NOT "0.1": a submitted-at timestamp legitimately contains digits and
        # dots, and a test that trips on those is testing the clock.
        for forbidden in ("/api/media", "http", "document_page", "storage", "{"):
            assert forbidden not in blob, forbidden

    def test_an_ordinary_question_leaves_the_column_empty(
        self, client, coach_headers, playbook
    ):
        """No placeholder, no "N/A", no repeated quiz title - a question that
        did not come from a playbook simply has nothing to say here."""
        made = client.post(
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
        assert made.status_code == 201
        take_it(client, playbook)

        rows = csv_rows(client, coach_headers, playbook["quiz_id"])
        header = rows[0]
        column = header.index("Playbook")
        ordinary = next(r for r in rows[1:] if r[3] == "Is this cover 2?")

        assert ordinary[column] == ""


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------


class TestPdf:
    def test_it_now_embeds_the_playbook_picture(self, client, coach_headers, playbook):
        """A LARGE picture carrying the mask, not merely "an image".

        Asserting only that the report contains an image PASSES AGAINST THE
        UNFIXED CODE - measured, not guessed: the report always embeds the
        Peira mark, and the mark is small but happens to be dark at the
        sampled coordinate. So this pins the size too, which the mark cannot
        satisfy.
        """
        take_it(client, playbook)

        play = play_picture(pdf_bytes(client, coach_headers, playbook["quiz_id"]))

        # BOTH CONDITIONS, because neither alone discriminates. The report
        # always embeds the Peira mark; the mark is dark at the delivered
        # rectangle's coordinates AND at the moved one's, and it is 188x240 so
        # a size threshold does not separate them either - both measured after
        # this assertion passed twice against code that embedded no play at
        # all. Only a real masked page is dark in one place and not the other.
        assert is_masked_at(play, DELIVERED_RECT), "the play is in the report"
        assert not is_masked_at(play, MOVED_RECT), "and it is the play, not the logo"

    def test_THE_HISTORICAL_PROOF_the_report_shows_the_DELIVERED_rectangle(
        self, client, coach_headers, playbook
    ):
        """attempt is delivered rectangle A -> coach moves the live region to B
        -> the report still shows A.

        The move happens BETWEEN start and submit because that is the only
        window the product allows: once an answer row exists the coach is
        refused, and that lock is deliberately unchanged. It is also the exact
        sequence that made this a real bug rather than a theoretical one.
        """
        served = start(client, playbook)
        # PRECONDITION: the player really was served the ORIGINAL rectangle.
        assert is_masked_at(served, DELIVERED_RECT)
        assert not is_masked_at(served, MOVED_RECT)

        assert move_region(client, coach_headers, playbook).status_code == 200
        submit(client, playbook)

        images = pdf_images(pdf_bytes(client, coach_headers, playbook["quiz_id"]))

        # The play picture identifies ITSELF as the one carrying the delivered
        # mask, rather than being picked out by a size guess - the report also
        # embeds the Peira mark, and the mark happens to be dark at the moved
        # rectangle's coordinates, which is exactly the false positive a
        # dimension filter would have hidden.
        play = play_picture(pdf_bytes(client, coach_headers, playbook["quiz_id"]))

        assert is_masked_at(play, DELIVERED_RECT), "the report kept the delivered mask"
        assert not is_masked_at(play, MOVED_RECT), "and did not follow the live rectangle"

    def test_a_NEW_attempt_gets_the_new_rectangle(
        self, client, coach_headers, playbook
    ):
        """The other half: freezing an old report must not freeze the quiz.
        Two players, two different delivered rectangles, one report."""
        start(client, playbook)
        assert move_region(client, coach_headers, playbook).status_code == 200
        submit(client, playbook)

        second = start(client, playbook, player=OTHER)
        assert is_masked_at(second, MOVED_RECT), "the new attempt got the new rectangle"
        submit(client, playbook, player=OTHER, answer="Cover 2")

        images = pdf_images(pdf_bytes(client, coach_headers, playbook["quiz_id"]))

        assert any(is_masked_at(i, DELIVERED_RECT) for i in images), "player one's play"
        assert any(is_masked_at(i, MOVED_RECT) for i in images), "player two's play"

    def test_an_ordinary_image_question_is_unchanged(
        self, app, client, coach_headers, playbook
    ):
        """Parity, not replacement: the ordinary image path still renders from
        `question.image` and is not routed through the delivered mask."""
        from app.models import Question, QuestionImage

        made = client.post(
            f"/api/quizzes/{playbook['quiz_id']}/questions",
            json={
                "question_text": "Ordinary?",
                "question_type": "written",
                "options": [],
            },
            headers=coach_headers,
        )
        assert made.status_code == 201
        with app.app_context():
            question = db.session.get(Question, made.get_json()["id"])
            db.session.add(
                QuestionImage(
                    question_id=question.id, image_url="/uploads/none.png", annotations=[]
                )
            )
            db.session.commit()
        take_it(client, playbook)

        # A missing file degrades to no picture rather than failing the report.
        assert pdf_bytes(client, coach_headers, playbook["quiz_id"])[:5] == b"%PDF-"


# ---------------------------------------------------------------------------
# Nothing else moved
# ---------------------------------------------------------------------------


class TestNothingElseMoved:
    def test_player_results_are_untouched(self, client, playbook):
        """DELIBERATELY out of scope - ordinary image questions show no picture
        here either, and making playbook questions a special case is what this
        phase refuses to do."""
        take_it(client, playbook)

        detail = client.post(
            "/api/play/results",
            json={"code": playbook["code"]["code"], "player_name": PLAYER},
        ).get_json()["answers"][0]

        assert "masked_image_url" not in detail
        assert "playbook" not in str(detail).lower()

    def test_the_coach_expanded_row_is_untouched(self, client, coach_headers, playbook):
        take_it(client, playbook)

        responses = client.get(
            f"/api/quizzes/{playbook['quiz_id']}/responses", headers=coach_headers
        ).get_json()

        assert "masked_image_url" not in str(responses[0]["delivered_questions"][0])

    def test_no_unmasked_page_or_key_reaches_any_export(
        self, client, coach_headers, playbook
    ):
        take_it(client, playbook)

        blob = "".join(
            "".join(r) for r in csv_rows(client, coach_headers, playbook["quiz_id"])
        )

        assert "image_key" not in blob
        assert "storage" not in blob

    def test_the_answer_key_does_not_reach_the_csv(
        self, client, coach_headers, playbook
    ):
        """`expected_answers` is the key for a fill-blank question, and the CSV
        is a per-answer evidence trail, not an answer sheet."""
        take_it(client, playbook, answer="something wrong")

        blob = "".join(
            "".join(r) for r in csv_rows(client, coach_headers, playbook["quiz_id"])
        )

        assert "expected_answers" not in blob

    def test_the_snapshot_does_not_mutate_when_exported(
        self, app, client, coach_headers, playbook
    ):
        import json as _json

        take_it(client, playbook)
        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            before = _json.dumps(
                AttemptQuestionSnapshot.query.filter_by(
                    question_id=playbook["question_id"]
                ).one().snapshot,
                sort_keys=True,
            )

        csv_rows(client, coach_headers, playbook["quiz_id"])
        pdf_bytes(client, coach_headers, playbook["quiz_id"])

        with app.app_context():
            from app.models import AttemptQuestionSnapshot

            after = _json.dumps(
                AttemptQuestionSnapshot.query.filter_by(
                    question_id=playbook["question_id"]
                ).one().snapshot,
                sort_keys=True,
            )
        assert after == before
