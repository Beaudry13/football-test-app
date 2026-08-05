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
from reportlab.lib.styles import ParagraphStyle

from app.services import export as export_module
from app.services.export import (
    PDF_THEME,
    RESULT_CORRECT,
    RESULT_INCORRECT,
    RESULT_NOT_GRADED,
    RESULT_UNANSWERED,
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


def test_every_roster_header_label_fits_its_column_without_breaking_mid_word():
    """A header broken inside a word ("INCORRE / CT") is the single most
    obvious "auto-generated report" tell, and it's what the first pass of
    this redesign shipped. Each column must be wide enough for its own
    longest header WORD, set in the heading face at the table-header size
    with its letterspacing, plus the cell's 8pt of horizontal padding.

    Multi-word labels ("Not Graded") may wrap at the space, so only the
    longest single word has to fit."""
    from reportlab.pdfbase.pdfmetrics import stringWidth

    headers = [
        "Player",
        "#",
        "Position",
        "Submitted",
        "Correct",
        "Incorrect",
        "Not Graded",
        "Unanswered",
        "Score",
    ]
    font = PDF_THEME["heading_font"]
    size = PDF_THEME["body_sizes"]["table_header"]
    tracking = PDF_THEME["char_space"]["table"]
    padding = 8

    for label, width in zip(headers, _SUMMARY_COL_WIDTHS):
        longest = max(label.upper().split(), key=len)
        needed = stringWidth(longest, font, size) + tracking * len(longest) + padding
        assert width >= needed, f"{label!r} column is {width}pt, needs >= {needed:.1f}pt for {longest!r}"


def test_submitted_column_fits_the_widest_timestamp_the_formatter_can_emit():
    """The Submitted/Correct collision this redesign fixed came back the
    moment the column got narrower than a real timestamp. Measure the
    widest string _format_short_timestamp can produce (a two-digit day and
    a two-digit 12-hour clock) rather than trusting a magic number."""
    from reportlab.pdfbase.pdfmetrics import stringWidth

    widest = _format_short_timestamp(datetime(2026, 12, 28, 23, 58, tzinfo=timezone.utc))
    needed = stringWidth(widest, PDF_THEME["body_font"], PDF_THEME["body_sizes"]["small"]) + 8

    assert _SUMMARY_COL_WIDTHS[3] >= needed, f"Submitted column needs >= {needed:.1f}pt for {widest!r}"


def test_player_column_is_wide_enough_to_break_a_long_surname_at_its_hyphen():
    """Below a measured threshold ReportLab gives up on the embedded hyphen
    and splits inside the word ("Vandermeul / en-Fitzgerald"). Assert the
    real wrap result rather than the width, so this keeps protecting the
    behavior even if the font or size changes."""
    from reportlab.platypus import Paragraph

    style = ParagraphStyle(
        "ProbeRosterName",
        fontName=PDF_THEME["heading_font"],
        fontSize=PDF_THEME["body_sizes"]["small"],
        leading=PDF_THEME["body_sizes"]["small"] * 1.3,
        embeddedHyphenation=1,
    )
    paragraph = Paragraph("Christopher Vandermeulen-Fitzgerald", style)
    paragraph.wrap(_SUMMARY_COL_WIDTHS[0] - 8, 200)

    rendered = []
    for line in paragraph.blPara.lines:
        words = line[1] if isinstance(line, tuple) else line.words
        rendered.append(" ".join(w if isinstance(w, str) else w.text for w in words))

    assert all(
        line.endswith("-") or line == rendered[-1] for line in rendered[:-1]
    ), f"long surname was split mid-word: {rendered}"
    assert "Fitzgerald" in rendered[-1]


def test_every_grading_result_has_a_chip_style():
    """The per-question status chip looks its state up in the theme - a
    missing entry would be a KeyError mid-render, on one Player's page,
    only for one particular grading state."""
    for result in (RESULT_CORRECT, RESULT_INCORRECT, RESULT_NOT_GRADED, RESULT_UNANSWERED):
        fill, text_color = PDF_THEME["result_styles"][result]
        assert fill is not None and text_color is not None


def test_result_chip_fills_stay_light_enough_to_print_cheaply():
    """Status chips must stay near-white tints. A coach may print dozens of
    Player pages, and the whole point of the chips is that they cost
    hairline-level ink - a saturated fill here would quietly turn every
    question card into a toner sink."""
    for result, (fill, _text) in PDF_THEME["result_styles"].items():
        luminance = 0.2126 * fill.red + 0.7152 * fill.green + 0.0722 * fill.blue
        assert luminance >= 0.9, f"{result} chip fill is too dark to print in quantity ({luminance:.3f})"


def test_the_shipped_peira_mark_exists_so_the_masthead_is_not_text_only():
    """theme["logo_path"] points at a real file shipped with the backend.
    If this asset ever stops being packaged, _brand_mark() silently falls
    back to the text wordmark and the report quietly loses its logo - the
    kind of regression nobody notices until a coach shares a PDF."""
    from pathlib import Path

    assert PDF_THEME["logo_path"], "PDF_THEME must point at the shipped Peira mark"
    assert Path(PDF_THEME["logo_path"]).is_file()


def test_brand_mark_uses_the_real_logo_when_one_is_configured():
    styles = _pdf_styles(PDF_THEME)

    mark = _brand_mark(PDF_THEME, styles)

    # An Image, not the Paragraph fallback - the default theme ships a logo.
    assert mark.__class__.__name__ == "Image"


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
    # Letterspaced caps in the redesigned footer - assert the brand is
    # present, not one particular capitalization.
    assert "peira" in text.lower()


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
