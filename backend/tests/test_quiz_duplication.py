"""Duplicate Quiz must produce a faithful, INDEPENDENT copy.

THE BUG THESE EXIST FOR
------------------------
A coach found a mistake in a quiz that was already sent. They could not edit a
live quiz, so they duplicated it, corrected the copy, deleted the confusing
original, and sent the duplicate. Its images did not appear.

`duplicate_quiz` copied `image_url` verbatim, so two `question_images` rows
referenced ONE stored object - while every deletion path in the product
(`delete_quiz`, and both the replace and delete image routes) unlinks the file
outright because it assumes a single owner. The first destructive edit on
either quiz therefore blanked the other's pictures, silently, with no error
anywhere.

Two more fields were being dropped at the same time: `answer_explanation` (the
teaching material) and `canvas_width` (the coordinate space annotations were
authored in - without it saved shapes render against the legacy 900px canvas
and MOVE).
"""

import io

import pytest
from PIL import Image

from app.extensions import db
from app.models import AccessCode, PlayerAttempt, Question, QuestionImage, Quiz
from app.services.file_storage import StorageError, get_file_storage


def png_bytes(color=(200, 30, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (24, 24), color=color).save(buffer, format="PNG")
    return buffer.getvalue()


ANNOTATIONS = [{"type": "arrow", "x": 10, "y": 20}, {"type": "circle", "x": 5, "y": 5}]


def _upload_image(client, headers, quiz_id, question_id, color=(200, 30, 30)):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/image",
        data={"image": (io.BytesIO(png_bytes(color)), "play.png")},
        content_type="multipart/form-data",
        headers=headers,
    )


@pytest.fixture
def authored(client, coach_headers):
    """A quiz with everything Duplicate Quiz is supposed to preserve."""
    quiz = client.post(
        "/api/quizzes",
        json={
            "title": "Coverages",
            "description": "Week 3 install",
            "one_question_at_a_time": False,
            "require_all_answers": True,
        },
        headers=coach_headers,
    ).get_json()

    with_image = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Which coverage?",
            "question_type": "multiple_choice",
            "answer_explanation": "Two safeties split the deep halves.",
            "options": [
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()
    _upload_image(client, coach_headers, quiz["id"], with_image["id"])
    client.put(
        f"/api/quizzes/{quiz['id']}/questions/{with_image['id']}/image/annotations",
        json={"annotations": ANNOTATIONS, "canvas_width": 1400},
        headers=coach_headers,
    )

    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Is this an odd front?",
            "question_type": "true_false",
            "answer_explanation": "Three down linemen.",
            "options": [
                {"option_text": "Yes", "is_correct_answer": True},
                {"option_text": "No", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )
    return quiz["id"]


def _duplicate(client, headers, quiz_id):
    response = client.post(f"/api/quizzes/{quiz_id}/duplicate", headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def _quiz(client, headers, quiz_id):
    return client.get(f"/api/quizzes/{quiz_id}", headers=headers).get_json()


def _images_readable(quiz_id) -> bool:
    """Are the BYTES actually still there for every image on this quiz?

    Reads through the storage service rather than over HTTP: the row surviving
    is exactly what made this bug invisible, so the row is not the question.
    """
    storage = get_file_storage()
    rows = (
        QuestionImage.query.join(Question)
        .filter(Question.quiz_id == quiz_id)
        .all()
    )
    return bool(rows) and all(
        storage.load_image_bytes(row.image_url) is not None for row in rows
    )


# ---------------------------------------------------------------------------
# The asset
# ---------------------------------------------------------------------------


class TestImageAsset:
    def test_the_duplicate_gets_its_own_storage_object(self, client, coach_headers, authored):
        """THE REGRESSION. A shared object is what made every later delete
        destructive to a quiz nobody was editing."""
        copy_id = _duplicate(client, coach_headers, authored)

        original = _quiz(client, coach_headers, authored)["questions"][0]["image"]
        duplicate = _quiz(client, coach_headers, copy_id)["questions"][0]["image"]

        assert duplicate["image_url"] != original["image_url"]
        assert duplicate["id"] != original["id"]

    def test_the_copied_bytes_are_identical(self, client, coach_headers, authored):
        # A copy, not a re-encode: save_image compresses on the way in, so
        # re-running it here would degrade the image on every duplicate.
        copy_id = _duplicate(client, coach_headers, authored)
        storage = get_file_storage()

        original = _quiz(client, coach_headers, authored)["questions"][0]["image"]
        duplicate = _quiz(client, coach_headers, copy_id)["questions"][0]["image"]

        source = storage.load_image_bytes(original["image_url"])
        copied = storage.load_image_bytes(duplicate["image_url"])
        assert source is not None and copied is not None
        assert source == copied

    def test_a_question_without_an_image_stays_without_one(self, client, coach_headers, authored):
        copy_id = _duplicate(client, coach_headers, authored)
        assert _quiz(client, coach_headers, copy_id)["questions"][1]["image"] is None


# ---------------------------------------------------------------------------
# The two silently-dropped fields
# ---------------------------------------------------------------------------


class TestAuthoredContent:
    def test_answer_explanation_survives(self, client, coach_headers, authored):
        """REGRESSION. The teaching material vanished from every duplicate."""
        copy_id = _duplicate(client, coach_headers, authored)

        for original, duplicate in zip(
            _quiz(client, coach_headers, authored)["questions"],
            _quiz(client, coach_headers, copy_id)["questions"],
        ):
            assert duplicate["answer_explanation"] == original["answer_explanation"]
            assert duplicate["answer_explanation"] is not None

    def test_canvas_width_survives_with_its_annotations(self, client, coach_headers, authored):
        """REGRESSION, and a correctness bug rather than lost metadata.

        NULL canvas_width means "assume the legacy 900px canvas", so dropping
        it moved every saved shape on the copy. Annotations and the space they
        were authored in only mean anything together.
        """
        copy_id = _duplicate(client, coach_headers, authored)
        duplicate = _quiz(client, coach_headers, copy_id)["questions"][0]["image"]

        assert duplicate["canvas_width"] == 1400
        assert duplicate["annotations"] == ANNOTATIONS


# ---------------------------------------------------------------------------
# Independence - each case from its OWN fresh pair
# ---------------------------------------------------------------------------


class TestIndependence:
    """Editing or deleting either side must never touch the other.

    Every test duplicates its own pair. Running these against one shared pair
    is how the original investigation produced an inconclusive result: once a
    prior case had already replaced an asset, the pair no longer shared
    anything and the next test proved nothing.
    """

    def _pair(self, client, headers, authored):
        return authored, _duplicate(client, headers, authored)

    def _image_question(self, client, headers, quiz_id):
        return next(
            q["id"] for q in _quiz(client, headers, quiz_id)["questions"] if q["image"]
        )

    def test_a_replacing_on_the_duplicate_leaves_the_original(self, client, coach_headers, authored):
        original, copy_id = self._pair(client, coach_headers, authored)
        _upload_image(client, coach_headers, copy_id,
                      self._image_question(client, coach_headers, copy_id), (0, 200, 0))
        assert _images_readable(original)

    def test_b_deleting_on_the_duplicate_leaves_the_original(self, client, coach_headers, authored):
        original, copy_id = self._pair(client, coach_headers, authored)
        client.delete(
            f"/api/quizzes/{copy_id}/questions/"
            f"{self._image_question(client, coach_headers, copy_id)}/image",
            headers=coach_headers,
        )
        assert _images_readable(original)

    def test_c_replacing_on_the_original_leaves_the_duplicate(self, client, coach_headers, authored):
        original, copy_id = self._pair(client, coach_headers, authored)
        _upload_image(client, coach_headers, original,
                      self._image_question(client, coach_headers, original), (0, 0, 200))
        assert _images_readable(copy_id)

    def test_d_deleting_on_the_original_leaves_the_duplicate(self, client, coach_headers, authored):
        original, copy_id = self._pair(client, coach_headers, authored)
        client.delete(
            f"/api/quizzes/{original}/questions/"
            f"{self._image_question(client, coach_headers, original)}/image",
            headers=coach_headers,
        )
        assert _images_readable(copy_id)

    def test_e_deleting_the_duplicate_quiz_leaves_the_original(self, client, coach_headers, authored):
        original, copy_id = self._pair(client, coach_headers, authored)
        client.delete(f"/api/quizzes/{copy_id}", headers=coach_headers)
        assert _images_readable(original)

    def test_f_deleting_the_original_quiz_leaves_the_duplicate(self, client, coach_headers, authored):
        """THE REPORTED FAILURE, exactly.

        Duplicate as a workaround, fix the copy, delete the confusing original,
        send the duplicate - and its images were gone.
        """
        original, copy_id = self._pair(client, coach_headers, authored)
        client.delete(f"/api/quizzes/{original}", headers=coach_headers)
        assert _images_readable(copy_id)


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------


class TestFailureBehaviour:
    def test_a_storage_failure_fails_the_whole_duplicate(
        self, client, coach_headers, authored, monkeypatch
    ):
        """No half-copied quiz, and above all no question missing its image.

        Silently continuing without the picture IS the bug being fixed, so it
        must never be the fallback.
        """
        from app.routes import quizzes as quizzes_route

        real = get_file_storage()

        class Failing:
            def __getattr__(self, name):
                return getattr(real, name)

            def copy_image(self, image_url):
                raise StorageError("bucket unavailable")

        monkeypatch.setattr(quizzes_route, "get_file_storage", lambda: Failing())

        before = Quiz.query.count()
        response = client.post(f"/api/quizzes/{authored}/duplicate", headers=coach_headers)

        assert response.status_code == 502
        assert response.get_json()["reason"] == "image_copy_failed"
        # The DB half is all-or-nothing: no orphan quiz row survives.
        assert Quiz.query.count() == before

    def test_a_db_failure_after_copying_cleans_up_the_new_asset(
        self, client, coach_headers, authored, monkeypatch
    ):
        """A rollback that left copied objects behind would leak one file per
        attempt, invisibly, forever."""
        from app.routes import quizzes as quizzes_route

        real = get_file_storage()
        created: list[str] = []
        deleted: list[str] = []

        class Tracking:
            def __getattr__(self, name):
                return getattr(real, name)

            def copy_image(self, image_url):
                url = real.copy_image(image_url)
                created.append(url)
                return url

            def delete_image(self, image_url):
                deleted.append(image_url)
                return real.delete_image(image_url)

        def boom():
            raise RuntimeError("db died")

        monkeypatch.setattr(quizzes_route, "get_file_storage", lambda: Tracking())
        monkeypatch.setattr(quizzes_route.db.session, "commit", boom)

        # The route re-raises after cleaning up; Flask's handler turns that
        # into a 500. Either way the point is what happened to the assets.
        response = client.post(f"/api/quizzes/{authored}/duplicate", headers=coach_headers)
        assert response.status_code == 500

        monkeypatch.undo()
        db.session.rollback()

        assert created, "the test needs a copy to have happened"
        assert set(created) <= set(deleted)
        for url in created:
            assert real.load_image_bytes(url) is None
        # And no half-built quiz survived the rollback.
        assert Quiz.query.filter(Quiz.title.like("%(Copy)")).count() == 0


# ---------------------------------------------------------------------------
# What must NOT come along
# ---------------------------------------------------------------------------


class TestWhatIsNotCopied:
    def test_no_access_codes_attempts_or_responses_follow_the_copy(
        self, client, coach_headers, authored, register_coach
    ):
        """A duplicate is a fresh quiz. Carrying a code would let players join
        the copy with the original's code; carrying attempts would invent
        results nobody produced.
        """
        copy_id = _duplicate(client, coach_headers, authored)

        assert AccessCode.query.filter_by(quiz_id=copy_id).count() == 0
        assert PlayerAttempt.query.filter_by(quiz_id=copy_id).count() == 0

    def test_the_copy_belongs_to_the_duplicating_coach_and_their_org(
        self, client, coach_headers, authored
    ):
        copy_id = _duplicate(client, coach_headers, authored)
        original = db.session.get(Quiz, authored)
        duplicate = db.session.get(Quiz, copy_id)

        assert duplicate.organization_id == original.organization_id
        assert duplicate.id != original.id


# ---------------------------------------------------------------------------
# The fidelity guard
# ---------------------------------------------------------------------------


#: Everything on a duplicated question that must match, derived from the model
#: rather than hand-listed so a NEW authored column fails here instead of being
#: silently dropped the way answer_explanation was.
QUESTION_IDENTITY_COLUMNS = {"id", "quiz_id", "created_at"}


class TestDuplicateFidelityGuard:
    def test_every_authored_question_column_is_copied(self, client, coach_headers, authored):
        """Compares model columns, not a hand-written list.

        answer_explanation was added to Question and simply never added to
        duplicate_quiz, and nothing failed. This asserts over whatever columns
        the model actually has today, minus the ones that SHOULD differ - so
        the next field added is covered without anyone remembering to do so.
        """
        copy_id = _duplicate(client, coach_headers, authored)

        originals = (
            Question.query.filter_by(quiz_id=authored).order_by(Question.position).all()
        )
        copies = (
            Question.query.filter_by(quiz_id=copy_id).order_by(Question.position).all()
        )
        assert len(originals) == len(copies) > 0

        columns = [
            c.name for c in Question.__table__.columns
            if c.name not in QUESTION_IDENTITY_COLUMNS
        ]
        for original, duplicate in zip(originals, copies):
            for column in columns:
                assert getattr(duplicate, column) == getattr(original, column), (
                    f"duplicate_quiz does not copy Question.{column}"
                )

    def test_every_authored_image_column_is_copied_except_the_asset(
        self, client, coach_headers, authored
    ):
        copy_id = _duplicate(client, coach_headers, authored)
        original = (
            QuestionImage.query.join(Question).filter(Question.quiz_id == authored).one()
        )
        duplicate = (
            QuestionImage.query.join(Question).filter(Question.quiz_id == copy_id).one()
        )

        # image_url MUST differ - that is the whole fix - and the rest must not.
        assert duplicate.image_url != original.image_url
        skip = {"id", "question_id", "image_url", "created_at", "updated_at"}
        for column in (c.name for c in QuestionImage.__table__.columns if c.name not in skip):
            assert getattr(duplicate, column) == getattr(original, column), (
                f"duplicate_quiz does not copy QuestionImage.{column}"
            )

    def test_quiz_level_settings_are_copied(self, client, coach_headers, authored):
        copy_id = _duplicate(client, coach_headers, authored)
        original = _quiz(client, coach_headers, authored)
        duplicate = _quiz(client, coach_headers, copy_id)

        for field in ("description", "one_question_at_a_time", "require_all_answers"):
            assert duplicate[field] == original[field]
        assert duplicate["title"] == f"{original['title']} (Copy)"
