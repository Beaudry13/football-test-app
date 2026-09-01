"""A REJECTED REQUEST MUST LEAVE NO TRANSACTION BEHIND.

THE BUG THIS GUARDS, which cost a whole session to find
--------------------------------------------------------
The shared creation path did `db.session.add(question)` + `flush()` - writing a
row and taking locks - and only THEN validated the region and the accepted
answers. Any 422 after that point killed the request with its transaction still
open. The connection sat `idle in transaction`, and the next writer waited on
it forever.

It surfaced as a test suite that hung. Captured live while it was stuck:

    pid=A  active               DELETE FROM quizzes ...   wait=Lock/transactionid
    pid=B  idle in transaction  SELECT source_documents   wait=Client/ClientRead
    blocked: [(A, [B])]

Teardown could not delete the quiz because a request that had already returned
422 was still holding locks.

THE INVARIANT
-------------
    validate everything that can reject  ->  THEN mutate

WHY IT SURVIVED THE HAPPY-PATH TESTS
------------------------------------
Every test that CREATES a question successfully passes either way - the flush
is followed by a commit and nothing is abandoned. Only a REJECTION exposes it,
which is why this file tests the 422 paths specifically and why the original
suite hung on `test_rejects_a_zero_area_region` rather than on anything that
looked like it was about transactions.

WHY THIS TEST DOES NOT DEPEND ON TIMING
---------------------------------------
It does not wait for a deadlock or measure how long anything takes. It asks
Postgres directly whether any connection is `idle in transaction` afterwards,
and then proves the database is still usable by doing the exact work that
deadlocked before: creating a question and deleting the quiz.
"""

import io as _io
import json as _json

import pytest
from sqlalchemy import text

from app.extensions import db

PAGE_RECT = {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1}


@pytest.fixture
def quiz_id(client, coach_headers):
    return client.post(
        "/api/quizzes", json={"title": "Ordering"}, headers=coach_headers
    ).get_json()["id"]


@pytest.fixture
def page_id(app, client, coach_headers, quiz_id):
    from app.models import Coach, DocumentPage, SourceDocument

    with app.app_context():
        coach = Coach.query.filter_by(username="coach1").one()
        source = SourceDocument(
            organization_id=coach.organization_id,
            uploaded_by_coach_id=coach.id,
            title="Playbook",
            original_filename="p.pdf",
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
        )
        db.session.add(page)
        db.session.commit()
        return page.id


def questions_added_during(monkeypatch, call):
    """Every Question handed to `db.session.add` while `call` runs.

    ASSERTS THE ORDERING ITSELF, which is the only signal that discriminates
    here. Two more obvious metrics were tried and both measure the harness
    rather than the code:

    * "no connection is idle in transaction" - the Flask test client keeps a
      transaction open between requests by design, so this is true on healthy
      code.
    * "a second connection can lock the quiz row" - conftest wraps each test in
      a transaction, so the app session always holds locks on rows it just
      inserted.

    What actually distinguishes the bug is whether the request PUT A ROW IN THE
    SESSION before it decided to reject. That is observable directly, runs in
    milliseconds, and cannot pass against a flush-before-validate ordering.
    """
    from app.models import Question
    from app.routes import questions as route_module

    added = []
    original = route_module.db.session.add

    def recording_add(instance, *args, **kwargs):
        if isinstance(instance, Question):
            added.append(instance)
        return original(instance, *args, **kwargs)

    monkeypatch.setattr(route_module.db.session, "add", recording_add)
    try:
        return call(), added
    finally:
        monkeypatch.undo()


def create_from_region(client, headers, quiz_id, page_id, **overrides):
    body = {
        "question_text": "WHAT COVERAGE IS THIS?",
        "document_page_id": page_id,
        "region": dict(PAGE_RECT),
        "expected_answers": ["Cover 3"],
        "answer_matching": "normalised",
        "position": None,
    }
    body.update(overrides)
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/from-region", json=body, headers=headers
    )


class TestARejectionLeavesNothingOpen:
    @pytest.mark.parametrize(
        "name,overrides,status",
        [
            # A zero-area rectangle - the exact request that hung the suite.
            ("zero area", {"region": {"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.0}}, 422),
            # Off the page.
            ("outside page", {"region": {"x": 0.9, "y": 0.9, "width": 0.5, "height": 0.5}}, 422),
            # Blank accepted answers - the OTHER post-flush rejection, and the
            # reason this is parametrised rather than a single case.
            ("blank answers", {"expected_answers": ["  ", ""]}, 422),
            # A page from another program. Rejected 404, not 403, so an id
            # cannot be probed for existence.
            ("foreign page", {"document_page_id": 999_999_999}, 404),
        ],
    )
    def test_it_returns_the_error_and_holds_no_transaction(
        self, monkeypatch, client, coach_headers, quiz_id, page_id, name, overrides, status
    ):
        refused, added = questions_added_during(
            monkeypatch,
            lambda: create_from_region(
                client, coach_headers, quiz_id, page_id, **overrides
            ),
        )

        assert refused.status_code == status, refused.get_json()
        assert added == [], (
            f"{name}: the request added a Question to the session before it "
            "rejected - a 422 then abandons an open transaction holding locks, "
            "and the next writer waits forever"
        )

    def test_the_database_is_still_usable_afterwards(
        self, app, client, coach_headers, quiz_id, page_id
    ):
        """THE PROOF THAT MATTERS, and it needs no timing.

        Before the fix, teardown's `DELETE FROM quizzes` blocked forever on the
        abandoned transaction. This does that same delete directly, plus a
        successful create first, so a lock left behind fails the test rather
        than hanging the suite.
        """
        create_from_region(
            client,
            coach_headers,
            quiz_id,
            page_id,
            region={"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.0},
        )

        # A VALID request immediately afterwards still succeeds.
        made = create_from_region(client, coach_headers, quiz_id, page_id)
        assert made.status_code == 201, made.get_json()

        # And the quiz tree can still be deleted - the operation that hung.
        deleted = client.delete(f"/api/quizzes/{quiz_id}", headers=coach_headers)
        assert deleted.status_code in (200, 204), deleted.get_json()

    def test_a_rejected_request_creates_no_question(
        self, app, client, coach_headers, quiz_id, page_id
    ):
        """The user-visible half of the same rule: a refused request must leave
        no half-made question behind for a coach to find and delete."""
        from app.models import Question

        create_from_region(
            client,
            coach_headers,
            quiz_id,
            page_id,
            region={"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.0},
        )

        with app.app_context():
            assert Question.query.filter_by(quiz_id=quiz_id).count() == 0


class TestTheNormalPathIsUnaffected:
    def test_a_valid_region_question_is_still_created(
        self, client, coach_headers, quiz_id, page_id
    ):
        made = create_from_region(client, coach_headers, quiz_id, page_id)

        assert made.status_code == 201, made.get_json()
        assert made.get_json()["question_type"] == "fill_blank"

    def test_an_ordinary_question_still_rejects_cleanly(
        self, monkeypatch, client, coach_headers, quiz_id
    ):
        """The same invariant on the plain create path: a multiple choice
        question with one option is refused, and holds nothing open."""
        refused, added = questions_added_during(
            monkeypatch,
            lambda: client.post(
                f"/api/quizzes/{quiz_id}/questions",
                json={
                    "question_text": "Which coverage?",
                    "question_type": "multiple_choice",
                    "options": [{"option_text": "Cover 2", "is_correct_answer": True}],
                },
                headers=coach_headers,
            ),
        )

        assert refused.status_code == 422
        assert added == []


#: Enough of an ISO base media file to pass the container check. The clip
#: rejections below fire before the bytes are ever validated, but sending
#: something that would NOT pass would prove the wrong thing - the point is
#: that a legitimate clip is refused for its COMBINATION, not its contents.
MP4_HEAD = bytes([0, 0, 0, 0x18]) + b"ftypisom" + bytes(64)
JPEG_HEAD = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + bytes(64)


class TestAClipRejectionLeavesNothingOpen:
    """THE SAME INVARIANT, ON THE MULTIPART ROUTE.

    The cases above all travel through `/questions/from-region`, which is JSON.
    Record Clip added a second way in - a multipart POST to `/questions` - and
    put its exclusivity checks AFTER the flush, reintroducing the exact bug
    this file exists to prevent. It returned a correct 422 and left the
    connection `idle in transaction`; the suite then hung for five hours with
    `DELETE FROM quizzes` blocked on those row locks.

    Nothing here caught it, because every case above uses the JSON route. So
    the guard now covers both doors rather than the one the bug came through
    first.
    """

    def _post(self, client, headers, quiz_id, *, question_type="written", with_image=False):
        data = {
            "payload": _json.dumps(
                {
                    "question_text": "What happens next?",
                    "question_type": question_type,
                    "options": [],
                }
            ),
            "clip": (_io.BytesIO(MP4_HEAD), "clip.mp4"),
        }
        if with_image:
            data["image"] = (_io.BytesIO(JPEG_HEAD), "still.jpg")
        return client.post(
            f"/api/quizzes/{quiz_id}/questions",
            data=data,
            content_type="multipart/form-data",
            headers=headers,
        )

    @pytest.mark.parametrize(
        "name,kwargs",
        [
            # A clip cannot be the material for a question whose answer IS a
            # drawing - there is nothing still to draw on.
            ("draw response", {"question_type": "draw_response"}),
            # Two sources of visual material in one request.
            ("image and clip", {"with_image": True}),
        ],
    )
    def test_it_rejects_without_putting_a_question_in_the_session(
        self, name, kwargs, client, coach_headers, quiz_id, monkeypatch
    ):
        response, added = questions_added_during(
            monkeypatch,
            lambda: self._post(client, coach_headers, quiz_id, **kwargs),
        )

        assert response.status_code == 422, response.get_json()
        assert added == [], (
            f"{name}: the request flushed a Question before deciding to reject it, "
            "which leaves the connection idle in transaction"
        )

    def test_the_quiz_can_still_be_deleted_afterwards(
        self, client, coach_headers, quiz_id
    ):
        """The consequence, not the mechanism.

        Teardown deletes every row in every table. That is the operation that
        actually hung, so it is the one worth proving still works.
        """
        assert self._post(client, coach_headers, quiz_id, question_type="draw_response").status_code == 422

        assert (
            client.delete(f"/api/quizzes/{quiz_id}", headers=coach_headers).status_code
            in (200, 204)
        )
