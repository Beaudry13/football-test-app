"""Draw Response Phase D - EXPORTING A DRAWING.

CSV
---
A spreadsheet cell cannot hold a drawing, so it says what happened instead.
The blank cell this replaces was ambiguous in the worst way: "drew something"
and "skipped it" looked identical to a coach scanning a column.

The wording matches the player's own results page on purpose - a coach and a
player discussing one answer should be reading the same phrase.

DETAILED PDF
------------
The drawing is rendered as VECTOR STROKES over the DELIVERED image, at export
time, from the canonical JSON. There is no flattened image stored anywhere,
because a second representation is a second thing that can disagree.

The failure rules matter more than the happy path here: an export is how a
coach gets the whole squad's results, so one bad drawing must never cost them
the other nineteen.
"""

import csv
import io
import json

import pytest

from app.extensions import db
from app.models import AnswerDrawing, QuestionExclusion
from app.services.export import build_results_csv, build_detailed_results_pdf
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def document_for(image_id, *, strokes=2, points=6):
    return {
        "format": "peira.drawing",
        "version": 1,
        "coordinate_width": 1200,
        "coordinate_height": 800,
        "source": {"image_id": str(image_id)},
        "strokes": [
            {
                "id": f"s{i}",
                "tool": "pen",
                "color": "#00E5FF",
                "width": 6,
                "points": [(j * 11) % 1000 for j in range(points * 2)],
            }
            for i in range(strokes)
        ],
    }


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def csv_rows(text):
    return list(csv.DictReader(io.StringIO(text)))


@pytest.fixture
def exported(client, coach_headers, app):
    """One Draw Response answered with strokes, one written answer."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Exports"}, headers=coach_headers
    ).get_json()
    draw = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Draw the rotation", "question_type": "draw_response", "options": []},
        headers=coach_headers,
    ).get_json()
    buffer, filename = make_image_file("film.png", (60, 40))
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
                    "drawing": document_for(image_id),
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
    }


def load_quiz_and_responses(app, quiz_id):
    from app.models import Quiz
    from app.routes.grading import _load_responses_for_export

    quiz = db.session.get(Quiz, quiz_id)
    return quiz, _load_responses_for_export(quiz)


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------


class TestCsv:
    def test_a_drawing_with_strokes_says_so(self, app, exported):
        with app.app_context():
            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            rows = csv_rows(build_results_csv(quiz, responses))

        row = next(r for r in rows if r["Question"] == "Draw the rotation")
        assert row["Answer"] == "Drawing submitted"

    def test_a_missing_drawing_says_no_drawing(self, app, client, coach_headers, exported):
        """A Draw Response the player skipped. The blank cell this replaces
        was indistinguishable from a drawing that did save."""
        start(client, exported["code"], player=OTHER)
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": exported["code"]["id"],
                "player_name": OTHER,
                "answers": [
                    {
                        "question_id": exported["draw"]["id"],
                        "selected_option_id": None,
                        "answer_text": None,
                    }
                ],
            },
        )

        with app.app_context():
            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            rows = csv_rows(build_results_csv(quiz, responses))

        row = next(
            r
            for r in rows
            if r["Player"] == OTHER and r["Question"] == "Draw the rotation"
        )
        assert row["Answer"] == "No drawing"

    def test_an_empty_document_says_no_drawing(self, app, exported):
        """Strokes make a drawing. An empty envelope is just the image."""
        with app.app_context():
            stored = AnswerDrawing.query.first()
            stored.document = {**stored.document, "strokes": []}
            db.session.commit()

            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            rows = csv_rows(build_results_csv(quiz, responses))

        row = next(r for r in rows if r["Question"] == "Draw the rotation")
        assert row["Answer"] == "No drawing"

    def test_an_excluded_drawing_keeps_its_answer_and_changes_only_the_verdict(
        self, app, exported
    ):
        """BOTH FACTS SURVIVE: what the player did, and how the question was
        treated for scoring. Overloading the Answer cell would hide the first
        to report the second."""
        with app.app_context():
            db.session.add(
                QuestionExclusion(
                    question_id=exported["draw"]["id"],
                    access_code_id=None,
                    coach_id=None,
                    reason="Bad film",
                )
            )
            db.session.commit()

            from app.services.question_exclusions import load_for_quizzes

            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            exclusions = load_for_quizzes([quiz.id])
            rows = csv_rows(build_results_csv(quiz, responses, exclusions))

        row = next(r for r in rows if r["Question"] == "Draw the rotation")
        assert row["Answer"] == "Drawing submitted"
        assert row["Correct"] == "Excluded"

    def test_the_cell_carries_no_drawing_metadata(self, app, exported):
        with app.app_context():
            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            text = build_results_csv(quiz, responses)

        for leaked in ("peira.drawing", "strokes", "revision", "image_id", "uploads/"):
            assert leaked not in text

    def test_a_written_answer_is_untouched(self, app, exported):
        with app.app_context():
            quiz, responses = load_quiz_and_responses(app, exported["quiz_id"])
            rows = csv_rows(build_results_csv(quiz, responses))

        row = next(r for r in rows if r["Question"] == "Explain it")
        assert row["Answer"] == "Because of the leverage"
        assert row["Correct"] == "Ungraded"


# ---------------------------------------------------------------------------
# The renderer, in isolation
# ---------------------------------------------------------------------------


class FakeCanvas:
    """Records what would have been painted, so geometry can be asserted
    exactly rather than inferred from PDF bytes."""

    def __init__(self):
        self.paths = []
        self.widths = []
        self.colours = []
        self._current = None

    def beginPath(self):
        self._current = []
        return self

    def moveTo(self, x, y):
        self._current.append((x, y))

    def lineTo(self, x, y):
        self._current.append((x, y))

    def setStrokeColorRGB(self, r, g, b):
        self.colours.append((r, g, b))

    def setLineWidth(self, width):
        self.widths.append(width)

    def setLineCap(self, _):
        pass

    def setLineJoin(self, _):
        pass

    def drawPath(self, path):
        self.paths.append(list(self._current))


def render(document, width=600, height=400):
    """Renders with the REAL theme fallback, the way the exporter does."""
    from app.services.export import PDF_THEME, _draw_strokes

    canvas = FakeCanvas()
    drawn = _draw_strokes(
        canvas, document, width, height, PDF_THEME["drawing_stroke_fallback"]
    )
    return canvas, drawn


def one_stroke(points, *, width=10, coordinate_width=1200):
    return {
        "format": "peira.drawing",
        "version": 1,
        "coordinate_width": coordinate_width,
        "coordinate_height": 800,
        "source": {"image_id": "1"},
        "strokes": [{"id": "s0", "tool": "pen", "color": "#00E5FF", "width": width, "points": points}],
    }


class TestGeometry:
    def test_x_is_scaled_by_the_coordinate_ratio(self):
        # 600 / 1200 = 0.5
        canvas, drawn = render(one_stroke([100, 0, 200, 0]))

        assert drawn == 1
        assert canvas.paths[0][0][0] == pytest.approx(50)
        assert canvas.paths[0][1][0] == pytest.approx(100)

    def test_the_Y_AXIS_IS_FLIPPED(self):
        """THE EASIEST THING HERE TO GET WRONG. Browser canvas measures y
        DOWNWARD from the top-left; PDF user space measures it UPWARD from the
        bottom-left. Drawing the raw values mirrors every stroke vertically -
        which still looks like a plausible drawing, so only a test catches it.

        A point at the TOP of the canvas (y=0) must land at the TOP of the
        flowable (y=height)."""
        canvas, _ = render(one_stroke([0, 0, 0, 800]), height=400)

        top, bottom = canvas.paths[0]
        assert top[1] == pytest.approx(400), "canvas y=0 is the TOP"
        assert bottom[1] == pytest.approx(0), "canvas y=max is the BOTTOM"

    def test_stroke_width_scales_with_the_geometry(self):
        """Scaling the path but not the pen renders a hairline on a shrunk
        image and a slab on a large one."""
        canvas, _ = render(one_stroke([0, 0, 100, 100], width=10))

        assert canvas.widths[0] == pytest.approx(5)

    def test_a_stroke_never_disappears_to_a_zero_width_line(self):
        canvas, _ = render(one_stroke([0, 0, 10, 10], width=0), width=60)

        assert canvas.widths[0] > 0

    def test_every_point_is_drawn(self):
        canvas, _ = render(one_stroke([0, 0, 10, 10, 20, 20, 30, 30]))

        assert len(canvas.paths[0]) == 4


class TestDegradation:
    def test_a_malformed_document_draws_nothing_and_does_not_raise(self):
        for bad in (None, "nonsense", {}, {"strokes": "no"}, {"coordinate_width": 0}):
            canvas, drawn = render(bad)
            assert drawn == 0
            assert canvas.paths == []

    def test_an_odd_point_count_skips_only_that_stroke(self):
        """A lost coordinate would shift every later point in the stroke, so it
        is skipped rather than drawn subtly wrong - and its neighbours survive."""
        document = one_stroke([0, 0, 10, 10])
        document["strokes"].append(
            {"id": "bad", "tool": "pen", "color": "#fff", "width": 4, "points": [1, 2, 3]}
        )
        document["strokes"].append(
            {"id": "good", "tool": "pen", "color": "#fff", "width": 4, "points": [5, 5, 6, 6]}
        )

        canvas, drawn = render(document)

        assert drawn == 2, "the two valid strokes still render"

    def test_a_single_point_stroke_is_skipped(self):
        canvas, drawn = render(one_stroke([5, 5]))

        assert drawn == 0

    def test_an_unparseable_colour_falls_back_rather_than_raising(self):
        """A stroke must never be LOST over its colour. This caught exactly
        that: the fallback raised, the per-stroke guard swallowed it, and the
        stroke silently vanished from the export."""
        document = one_stroke([0, 0, 10, 10])
        document["strokes"][0]["color"] = "not-a-colour"

        canvas, drawn = render(document)

        assert drawn == 1
        assert canvas.colours

    def test_a_stroke_survives_even_with_no_fallback_supplied(self):
        from app.services.export import _draw_strokes

        document = one_stroke([0, 0, 10, 10])
        document["strokes"][0]["color"] = "#fff"
        canvas = FakeCanvas()

        drawn = _draw_strokes(canvas, document, 600, 400)

        assert drawn == 1


class TestNoMutation:
    def test_rendering_never_changes_the_stored_document(self):
        document = one_stroke([0, 0, 10, 10])
        before = json.dumps(document, sort_keys=True)

        render(document)

        assert json.dumps(document, sort_keys=True) == before


# ---------------------------------------------------------------------------
# The detailed PDF, end to end
# ---------------------------------------------------------------------------


def build_pdf(app, quiz_id, exclusions=None, loader=None):
    from app.services.question_exclusions import NO_EXCLUSIONS
    from app.services.file_storage import get_file_storage
    from app.routes.grading import _build_dashboard_data

    quiz, responses = load_quiz_and_responses(app, quiz_id)
    storage = get_file_storage()
    if loader is None:
        loader = storage.load_image_bytes

    # The real shape the route passes - building a hand-made dict here would
    # only prove the export works against a fixture nobody ships.
    dashboard = _build_dashboard_data(quiz, responses)
    return build_detailed_results_pdf(
        quiz,
        dashboard,
        responses,
        "Wildcats",
        load_image_bytes=loader,
        exclusions=exclusions if exclusions is not None else NO_EXCLUSIONS,
    ), quiz, responses


class TestDetailedPdf:
    def test_it_still_produces_a_readable_pdf(self, app, exported):
        with app.app_context():
            pdf, _, _ = build_pdf(app, exported["quiz_id"])

        assert pdf.startswith(b"%PDF")
        assert len(pdf) > 1000

    def test_a_drawing_question_renders_an_overlay(self, app, exported, monkeypatch):
        """Proven by instrumenting the renderer rather than reading PDF bytes:
        the question is WHETHER the strokes were drawn, and how many."""
        from app.services import export as export_module

        calls = []
        original = export_module._draw_strokes

        def spy(canvas, document, width, height, stroke_fallback=None):
            drawn = original(canvas, document, width, height, stroke_fallback)
            calls.append(drawn)
            return drawn

        monkeypatch.setattr(export_module, "_draw_strokes", spy)

        with app.app_context():
            build_pdf(app, exported["quiz_id"])

        assert calls, "the overlay renderer ran"
        assert sum(calls) == 2, "both strokes were drawn"

    def test_no_overlay_when_there_is_no_drawing(self, app, client, exported, monkeypatch):
        from app.services import export as export_module

        calls = []
        monkeypatch.setattr(
            export_module, "_draw_strokes", lambda *a: calls.append(1) or 0
        )

        start(client, exported["code"], player=OTHER)
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": exported["code"]["id"],
                "player_name": OTHER,
                "answers": [
                    {
                        "question_id": exported["draw"]["id"],
                        "selected_option_id": None,
                        "answer_text": None,
                    }
                ],
            },
        )

        with app.app_context():
            from app.models import Quiz
            from app.routes.grading import _load_responses_for_export
            from app.services.question_exclusions import NO_EXCLUSIONS
            from app.services.file_storage import get_file_storage

            from app.routes.grading import _build_dashboard_data

            quiz = db.session.get(Quiz, exported["quiz_id"])
            responses = [
                r for r in _load_responses_for_export(quiz) if r.display_name == OTHER
            ]
            storage = get_file_storage()
            build_detailed_results_pdf(
                quiz,
                _build_dashboard_data(quiz, responses),
                responses,
                "Wildcats",
                load_image_bytes=storage.load_image_bytes,
                exclusions=NO_EXCLUSIONS,
            )

        assert calls == [], "no strokes drawn for a player who did not draw"

    def test_the_DELIVERED_image_is_used_after_a_replacement(
        self, app, client, coach_headers, exported
    ):
        """THE PHASE A INVARIANT, CARRIED INTO THE PDF. Never image B with
        image A's strokes."""
        requested = []

        buffer, filename = make_image_file("replacement.png", (90, 60))
        client.post(
            f"/api/quizzes/{exported['quiz_id']}/questions/{exported['draw']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        live_url = client.get(
            f"/api/quizzes/{exported['quiz_id']}", headers=coach_headers
        ).get_json()["questions"][0]["image"]["image_url"]

        with app.app_context():
            from app.services.file_storage import get_file_storage

            storage = get_file_storage()

            def recording_loader(url):
                requested.append(url)
                return storage.read_image(url)

            build_pdf(app, exported["quiz_id"], loader=recording_loader)

        assert requested, "an image was loaded"
        assert live_url not in requested, "NOT the coach's replacement picture"

    def test_an_excluded_drawing_still_renders(self, app, exported, monkeypatch):
        from app.services import export as export_module
        from app.services.question_exclusions import load_for_quizzes

        calls = []
        original = export_module._draw_strokes
        monkeypatch.setattr(
            export_module,
            "_draw_strokes",
            lambda c, d, w, h, f=None: calls.append(1) or original(c, d, w, h, f),
        )

        with app.app_context():
            db.session.add(
                QuestionExclusion(
                    question_id=exported["draw"]["id"],
                    access_code_id=None,
                    coach_id=None,
                    reason="Bad film",
                )
            )
            db.session.commit()
            exclusions = load_for_quizzes([exported["quiz_id"]])
            pdf, _, _ = build_pdf(app, exported["quiz_id"], exclusions=exclusions)

        assert calls, "the drawing is still evidence, and still drawn"
        assert pdf.startswith(b"%PDF")

    def test_a_malformed_document_does_not_fail_the_export(self, app, exported):
        """ONE PLAYER'S BAD DRAWING MUST NEVER COST THE TEAM THEIR EXPORT."""
        with app.app_context():
            stored = AnswerDrawing.query.first()
            stored.document = {"format": "peira.drawing", "version": 1, "strokes": "broken"}
            db.session.commit()

            pdf, _, _ = build_pdf(app, exported["quiz_id"])

        assert pdf.startswith(b"%PDF")

    def test_an_image_that_cannot_be_loaded_skips_the_overlay(self, app, exported, monkeypatch):
        """Strokes floating on a blank surface look like an answer while
        describing nothing - worse than no overlay at all."""
        from app.services import export as export_module

        calls = []
        monkeypatch.setattr(
            export_module, "_draw_strokes", lambda *a: calls.append(1) or 0
        )

        with app.app_context():
            pdf, _, _ = build_pdf(app, exported["quiz_id"], loader=lambda url: None)

        assert calls == [], "no strokes without the picture they belong to"
        assert pdf.startswith(b"%PDF")

    def test_the_stored_document_is_not_mutated_by_exporting(self, app, exported):
        with app.app_context():
            before = json.dumps(AnswerDrawing.query.first().document, sort_keys=True)
            build_pdf(app, exported["quiz_id"])
            db.session.expire_all()
            after = json.dumps(AnswerDrawing.query.first().document, sort_keys=True)

        assert after == before
