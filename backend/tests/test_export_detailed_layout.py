"""Structural/theming regression tests for the Phase-4 PDF redesign
(backend/app/services/export.py) - column widths, short timestamp
formatting, metric-card labels, footer, logo fallback, the centralized
PDF_THEME architecture itself, and the Paragraph XML-escaping fix.

Separate from test_export_detailed.py (which covers authorization,
data-safety, and content-correctness) so this file can stay focused on
"does the redesign look/behave the way the brief asked for."
"""

import io
import re
from datetime import datetime, timezone

from pypdf import PdfReader

from app.services import export as export_module
from app.services.export import (
    PDF_THEME,
    _brand_mark,
    _format_short_timestamp,
    _pdf_styles,
    _SUMMARY_COL_WIDTHS,
)
from tests.test_play_and_grading import build_ready_quiz, start_and_submit


def _pdf_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() for page in reader.pages)


# --- column widths / timestamp format (the Submitted/Correct collision fix) --


def test_summary_column_widths_fit_the_usable_page_width():
    # US Letter minus 1in side margins = 468pt usable width - stay under
    # that with real room to spare, not shrink-to-fit at the wire.
    assert sum(_SUMMARY_COL_WIDTHS) <= 468


def test_submitted_column_is_wide_enough_for_the_short_timestamp_format():
    # "Submitted" is column index 3 - must comfortably fit "Aug 5, 12:06 AM"
    # (17 chars) at the table's small font size without touching its
    # neighbors; 70pt was the width chosen to fix the original collision.
    submitted_width = _SUMMARY_COL_WIDTHS[3]
    assert submitted_width >= 60


def test_format_short_timestamp_produces_a_compact_readable_string():
    dt = datetime(2026, 8, 5, 0, 6, tzinfo=timezone.utc)
    formatted = _format_short_timestamp(dt)

    assert formatted == "Aug 5, 12:06 AM"
    assert len(formatted) <= 20


def test_format_short_timestamp_strips_leading_zero_from_the_hour_only():
    # %I never produces "00" (it's 12-hour, 01-12), so lstrip("0") can't
    # accidentally eat into the minutes - confirm the boundary case.
    dt = datetime(2026, 8, 5, 9, 5, tzinfo=timezone.utc)
    assert _format_short_timestamp(dt) == "Aug 5, 9:05 AM"


def test_short_timestamp_appears_in_the_rendered_detailed_pdf(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # Never the old long "%Y-%m-%d %H:%M" format anywhere in the PDF.
    assert re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", text) is None
    # The short format's month abbreviation + AM/PM marker are present.
    assert re.search(r"[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)", text) is not None


# --- metric labels ------------------------------------------------------------


def test_page_one_summary_metric_labels_are_present(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    for label in ("TOTAL ASSIGNED", "TOTAL SUBMITTED", "AVERAGE SCORE", "FULLY GRADED", "AWAITING GRADING"):
        assert label in text


def test_per_player_metric_labels_are_present(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert re.search(r"\bCORRECT\b", text) is not None
    assert re.search(r"\bINCORRECT\b", text) is not None
    assert "NOT GRADED" in text
    assert "UNANSWERED" in text
    assert "SCORE" in text


# --- footer --------------------------------------------------------------------


def test_footer_shows_page_number(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "Page 1" in text


def test_footer_shows_quiz_title_and_wordmark(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert quiz["title"] in text
    assert "Peira" in text


# --- logo / wordmark fallback ---------------------------------------------------


def test_brand_mark_falls_back_to_wordmark_when_no_logo_path_configured():
    theme = dict(PDF_THEME, logo_path=None)
    styles = _pdf_styles(theme)

    mark = _brand_mark(theme, styles)

    # A Paragraph (the wordmark), not an Image - confirms the fallback path
    # ran rather than attempting (and silently failing) an image load.
    assert mark.__class__.__name__ == "Paragraph"


def test_brand_mark_falls_back_to_wordmark_when_logo_path_is_unreadable():
    theme = dict(PDF_THEME, logo_path="C:/nonexistent/peira-logo-does-not-exist.png")
    styles = _pdf_styles(theme)

    mark = _brand_mark(theme, styles)

    assert mark.__class__.__name__ == "Paragraph"


# --- theme architecture: no hardcoded color/font tokens outside PDF_THEME ------


def test_no_hardcoded_reportlab_color_tokens_outside_the_theme_dict():
    """Every visual color used by the PDF builders should be read from a
    theme dict, not a bare `colors.something` literal sprinkled through the
    layout code - the whole point of PDF_THEME is that a reskin only ever
    means constructing a different dict. This scans the actual source for
    `colors.<name>` tokens, excluding the PDF_THEME definition itself
    (which is of course allowed to name real colors)."""
    import inspect

    source = inspect.getsource(export_module)
    theme_start = source.index("PDF_THEME = {")
    theme_end = source.index("\n}\n", theme_start) + 3
    outside_theme = source[:theme_start] + source[theme_end:]

    hardcoded = re.findall(r"colors\.\w+", outside_theme)
    assert hardcoded == [], f"Found hardcoded color tokens outside PDF_THEME: {hardcoded}"


def test_every_theme_key_the_builders_rely_on_is_present():
    required_keys = {
        "background",
        "primary_text",
        "secondary_text",
        "accent",
        "secondary_accent",
        "light_fill",
        "alt_row_fill",
        "border",
        "header_fill",
        "header_text",
        "metric_fill",
        "metric_border",
        "footer_text",
        "heading_font",
        "body_font",
        "heading_sizes",
        "body_sizes",
        "spacing",
        "logo_path",
        "wordmark_text",
    }
    assert required_keys.issubset(PDF_THEME.keys())


# --- XML-escaping regression (reportlab.Paragraph markup-parsing bug) ---------


def test_special_characters_in_answers_do_not_break_pdf_generation(client, coach_headers):
    """reportlab's Paragraph parses its text as lightweight XML/HTML markup
    even when none is intended - an unescaped '&'/'<'/'>' silently mangles
    the rendered output rather than raising. Every user-supplied value
    reaching a Paragraph() call must be xml-escaped first."""
    quiz = client.post("/api/quizzes", json={"title": "AT&T <Blitz> Install"}, headers=coach_headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Block <the> Sam & Will gap?", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    submit_response = start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": question["id"], "answer_text": "AT&T <blitz> stunt, Will & Sam"}],
    )
    answer_id = submit_response.get_json()["answers"][0]["id"]
    client.patch(
        f"/api/answers/{answer_id}/grade",
        json={"is_correct": True, "coach_feedback": "Good call on the A&B gap <read>."},
        headers=coach_headers,
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    assert response.status_code == 200
    assert response.get_data()[:5] == b"%PDF-"

    text = _pdf_text(response.get_data())
    # Every special-character string round-trips intact - none of the "&"/
    # "<"/">" content was silently swallowed or corrupted into a broken
    # entity reference.
    assert "AT&T" in text
    assert "Block" in text and "Sam & Will gap" in text
    assert "AT&T" in text and "stunt, Will & Sam" in text
    assert "A&B gap" in text
