"""Builds a coach-facing results export for a quiz, as CSV or PDF.

Expects `responses` to already be loaded with `answers` (and
`answers.selected_option`) eagerly - these functions don't query the
database themselves, to keep them easy to test and to let route handlers
control exactly what's eager-loaded. None of the functions in this module
ever write to the database - every one is a pure read/render step over
data the caller already loaded (see backend/app/routes/grading.py's
export routes, which are GET-only and issue no db.session.add/commit).

Player identity rule (applies to every name shown below, and matches the
coach Results tab): use PlayerAttempt.display_name, not the raw
player_name snapshot - i.e. a canonical attempt's *current* Player name,
falling back to the historical snapshot only for a legacy attempt (or a
since-deleted Player). An export is a point-in-time report, not an
archival record, so it should read the same as the live Results tab it
was generated from.

Grading-result vocabulary (the detailed PDF's per-question labels) matches
services/player_analytics.py exactly, so this export can never disagree
with the Results tab, quiz-card analytics, the grading dashboard, or
Player Progress Analytics about what "correct," "graded," or "score" mean:
- CORRECT / INCORRECT only apply to a graded Answer row (is_correct is not
  None) - a pending (ungraded) written answer is never counted as either.
- NOT_GRADED: an Answer row exists but is_correct is still None (pending
  manual grading). Never scored as 0%.
- UNANSWERED: no Answer row exists for that question at all - distinct
  from Not Graded, which means the player *did* answer and it's awaiting a
  coach's grade.
- Score = correct / (correct + incorrect) - "% of graded questions,"
  never including Not Graded/Unanswered in the denominator and never
  fabricating a score when nothing is graded yet (None, not 0).

PDF theming (read this before touching layout code below): every color,
font, size, and spacing value the PDF builders use comes from a `theme`
dict (PDF_THEME is the default) - see that dict's docstring. The current
values are a deliberately restrained, print-friendly Peira placeholder
palette, not a finished brand design - a broader Peira visual redesign is
planned, and this module is structured so that redesign (and, later,
per-organization branding) only ever means constructing a different theme
dict and passing it in, never rewriting build_results_pdf/
build_detailed_results_pdf or the helpers they call.
"""

import csv
import io
import re
from datetime import datetime, timezone
from xml.sax.saxutils import escape as _xml_escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    HRFlowable,
    Image as RLImage,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

CSV_HEADER = ["Player", "Submitted At", "Question #", "Question", "Type", "Answer", "Correct", "Coach Feedback"]

_CORRECT_LABELS = {True: "Yes", False: "No", None: "Ungraded"}

RESULT_CORRECT = "Correct"
RESULT_INCORRECT = "Incorrect"
RESULT_NOT_GRADED = "Not Graded"
RESULT_UNANSWERED = "Unanswered"

_MAX_IMAGE_WIDTH = 4.5 * inch
_MAX_IMAGE_HEIGHT = 3.5 * inch
_LOGO_MAX_WIDTH = 1.4 * inch
_LOGO_MAX_HEIGHT = 0.5 * inch

# US Letter, 1in side margins (the SimpleDocTemplate default, which every
# builder below keeps) - every table/card width is computed from this one
# constant so they always line up with each other and with the page.
_CONTENT_WIDTH = 6.5 * inch

# --- PDF theme ---------------------------------------------------------
#
# Every visual value either PDF builder (and every helper they call) uses
# comes from a theme dict shaped like this one. Nothing below reads
# PDF_THEME directly by name - every function takes `theme` as a plain
# parameter and build_results_pdf/build_detailed_results_pdf both accept
# an optional `theme` argument (defaulting to PDF_THEME) - so a future
# redesign, or a future per-organization theme (primary/secondary/accent
# hex + logo), is a matter of constructing a different dict and passing
# it in, never editing the layout code itself.
#
# Current values are an intentionally restrained, print-friendly Peira
# placeholder - NOT a finished brand design (a broader Peira visual
# redesign is planned separately):
# - White BACKGROUND, charcoal PRIMARY_TEXT/muted SECONDARY_TEXT for body
#   copy - never pure black.
# - A restrained gold/bronze ACCENT + a slightly softer SECONDARY_ACCENT,
#   used only for small elements: the wordmark, table header text, metric
#   labels - never a large filled panel.
# - Pale cream LIGHT_FILL / METRIC_FILL and a slightly deeper HEADER_FILL
#   for the few places this module fills any area at all (table headers,
#   metric cards, alternating table rows) - all light enough to print on
#   plain paper without meaningful ink coverage.
# - Soft muted-gold BORDER/METRIC_BORDER for grid lines, dividers, and
#   card outlines, instead of a heavier pure grey or black.
# - FOOTER_TEXT for the small running footer on every page.
# - HEADING_FONT/BODY_FONT + HEADING_SIZES/BODY_SIZES/SPACING so
#   typography and layout rhythm are just as swappable as color.
# - LOGO_PATH: None today (no finished logo asset exists yet) - see
#   _brand_mark(), which degrades to WORDMARK_TEXT styled with ACCENT
#   whenever this is unset or unreadable.
PDF_THEME = {
    "background": colors.HexColor("#FFFFFF"),
    "primary_text": colors.HexColor("#2A2416"),
    "secondary_text": colors.HexColor("#6E6858"),
    "accent": colors.HexColor("#A6822F"),
    "secondary_accent": colors.HexColor("#8A6D1F"),
    "light_fill": colors.HexColor("#F7F4EC"),
    "alt_row_fill": colors.HexColor("#FBF9F3"),
    "border": colors.HexColor("#D9CFA8"),
    "header_fill": colors.HexColor("#EFE8D6"),
    "header_text": colors.HexColor("#5C4A1A"),
    "metric_fill": colors.HexColor("#F7F4EC"),
    "metric_border": colors.HexColor("#D9CFA8"),
    "footer_text": colors.HexColor("#8C8578"),
    "heading_font": "Helvetica-Bold",
    "body_font": "Helvetica",
    "heading_sizes": {"title": 18, "h2": 14, "h3": 11, "h4": 10.5},
    "body_sizes": {"normal": 10, "label": 8.5, "small": 7.5, "footer": 7.5},
    "spacing": {"xs": 2, "sm": 4, "md": 8, "lg": 12, "xl": 16},
    "logo_path": None,
    "wordmark_text": "Peira",
}


def _pdf_styles(theme: dict) -> dict[str, ParagraphStyle]:
    """Every ParagraphStyle the PDF builders below use, all derived from
    `theme` - see PDF_THEME's docstring. Headings and body text use
    PRIMARY_TEXT (charcoal, never pure black); only the wordmark and small
    secondary labels ("Player Answer:", "Submitted:", metric labels, the
    footer) use ACCENT/SECONDARY_ACCENT/SECONDARY_TEXT/FOOTER_TEXT."""
    base = getSampleStyleSheet()
    normal = ParagraphStyle(
        "PeiraNormal",
        parent=base["Normal"],
        fontName=theme["body_font"],
        fontSize=theme["body_sizes"]["normal"],
        textColor=theme["primary_text"],
    )
    return {
        "title": ParagraphStyle(
            "PeiraTitle",
            parent=base["Title"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["title"],
            textColor=theme["primary_text"],
        ),
        "heading2": ParagraphStyle(
            "PeiraHeading2",
            parent=base["Heading2"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h2"],
            textColor=theme["primary_text"],
        ),
        "heading3": ParagraphStyle(
            "PeiraHeading3",
            parent=base["Heading2"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h3"],
            textColor=theme["secondary_text"],
        ),
        "heading4": ParagraphStyle(
            "PeiraHeading4",
            parent=base["Heading4"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h4"],
            textColor=theme["primary_text"],
        ),
        "normal": normal,
        "wordmark": ParagraphStyle(
            "PeiraWordmark",
            parent=base["Heading2"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h2"],
            textColor=theme["accent"],
        ),
        "label": ParagraphStyle(
            "PeiraLabel",
            parent=normal,
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["label"],
            textColor=theme["secondary_text"],
        ),
        "wrap": ParagraphStyle(
            "PeiraWrap",
            parent=normal,
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["normal"] - 1,
            leading=(theme["body_sizes"]["normal"] - 1) * 1.35,
        ),
    }


def _divider(theme: dict) -> HRFlowable:
    """A single thin rule in the theme's border color - a low-ink way to
    separate sections without a filled bar."""
    return HRFlowable(
        width="100%",
        thickness=0.75,
        color=theme["border"],
        spaceBefore=theme["spacing"]["xs"],
        spaceAfter=theme["spacing"]["md"],
    )


def _brand_mark(theme: dict, styles: dict[str, ParagraphStyle]):
    """The report's masthead mark. Reads theme["logo_path"] - unset today,
    since no finished Peira logo asset exists yet - and always falls back
    to a styled text wordmark when it's unset or the file can't be read.
    Wiring a real image later (Peira's finished logo, or an organization's
    uploaded one) means setting that one theme value; nothing in the
    builders below, or in this function's callers, needs to change."""
    logo_path = theme.get("logo_path")
    if logo_path:
        try:
            reader = ImageReader(logo_path)
            width, height = reader.getSize()
            if width and height:
                scale = min(_LOGO_MAX_WIDTH / width, _LOGO_MAX_HEIGHT / height, 1.0)
                return RLImage(logo_path, width=width * scale, height=height * scale)
        except Exception:
            pass
    return Paragraph(_xml_escape(theme.get("wordmark_text", "Peira")), styles["wordmark"])


def _metric_block(theme: dict, items: list[tuple[str, str]]) -> Table:
    """Compact metric cards in a single row (e.g. "22" over "TOTAL
    SUBMITTED") - replaces a plain run-on sentence of numbers with
    something scannable at a glance. Entirely themed, so a future reskin
    only ever touches the theme dict."""
    label_style = ParagraphStyle(
        "MetricLabel",
        fontName=theme["body_font"],
        fontSize=theme["body_sizes"]["small"],
        textColor=theme["secondary_accent"],
        alignment=1,
        spaceBefore=theme["spacing"]["xs"],
    )
    value_style = ParagraphStyle(
        "MetricValue",
        fontName=theme["heading_font"],
        fontSize=theme["heading_sizes"]["h3"],
        textColor=theme["primary_text"],
        alignment=1,
    )
    col_width = _CONTENT_WIDTH / len(items)
    row = [
        [Paragraph(_xml_escape(value), value_style), Paragraph(_xml_escape(label.upper()), label_style)]
        for label, value in items
    ]
    table = Table([row], colWidths=[col_width] * len(items))
    style = [
        ("BACKGROUND", (0, 0), (-1, -1), theme["metric_fill"]),
        ("BOX", (0, 0), (-1, -1), 0.75, theme["metric_border"]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"] + 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"] + 3),
    ]
    for i in range(1, len(items)):
        style.append(("LINEBEFORE", (i, 0), (i, 0), 0.5, theme["metric_border"]))
    table.setStyle(TableStyle(style))
    return table


def _question_card(theme: dict, flowables: list) -> Table:
    """Wraps one question's flowables in a single thin-bordered, padded
    cell so it reads as a distinct block on the page - without a heavy
    fill or color. A one-cell Table rather than KeepTogether so the
    padding/border are real layout, not just visual grouping."""
    table = Table([[flowables]], colWidths=[_CONTENT_WIDTH])
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.75, theme["border"]),
                ("BACKGROUND", (0, 0), (-1, -1), theme["background"]),
                ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["md"] + 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["md"] + 2),
                ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["md"]),
                ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["md"]),
            ]
        )
    )
    return table


def _format_short_timestamp(dt: datetime) -> str:
    """"Aug 5, 12:06 AM" - short enough to never collide with a neighboring
    table column again. Built without the %-d/%#d strftime flags (neither
    is portable between the Linux production host and a Windows dev
    machine) - %d always has a leading zero, so the day is pulled as a
    plain int instead, and the 12-hour hour's leading zero is stripped the
    same portable way."""
    month = dt.strftime("%b")
    time_part = dt.strftime("%I:%M %p").lstrip("0") or "12:00 AM"
    return f"{month} {dt.day}, {time_part}"


def export_filename_slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "quiz"


def _answer_text(question, answer) -> str:
    if answer is None:
        return ""
    if question.question_type.value == "written":
        return answer.answer_text or ""
    return answer.selected_option.option_text if answer.selected_option else ""


def _grading_result(answer) -> str:
    """See the module docstring's CORRECT/INCORRECT/NOT_GRADED/UNANSWERED
    definitions - this is the one place that decision is made, reused by
    both the per-player counts and the per-question detail rows below."""
    if answer is None:
        return RESULT_UNANSWERED
    if answer.is_correct is None:
        return RESULT_NOT_GRADED
    return RESULT_CORRECT if answer.is_correct else RESULT_INCORRECT


def _score_percent(correct: int, graded: int) -> float | None:
    """correct / (correct + incorrect) - never fabricates a score (0% or
    otherwise) when nothing is graded yet; matches
    services/player_analytics.py's identical rule exactly."""
    return round(100 * correct / graded, 1) if graded else None


def _player_sort_key(response):
    """Default order: jersey number (numeric) first, then last name, then
    first name - jersey-less Players (no canonical link, or a canonical
    Player with no number set) sort after every numbered Player. A legacy,
    name-only attempt has no separate first/last name field, so its
    display_name is split on whitespace as a best-effort approximation
    (last whitespace-separated token treated as the "last name")."""
    player = response.player
    jersey = None
    if player is not None and player.jersey_number:
        try:
            jersey = int(player.jersey_number)
        except ValueError:
            jersey = None

    if player is not None:
        last_name, first_name = player.last_name, player.first_name
    else:
        parts = response.display_name.strip().split()
        last_name = parts[-1] if parts else response.display_name
        first_name = " ".join(parts[:-1])

    return (jersey is None, jersey if jersey is not None else 0, last_name.lower(), first_name.lower())


def _player_result_counts(questions: list, response) -> tuple[dict, dict]:
    """Per-question grading result for this one SUBMITTED attempt, plus the
    aggregate counts derived from it - the single pass every summary number
    (page 1's table row, and this Player's own detail-page header) reads
    from, so they can never disagree with each other."""
    answers_by_question = {a.question_id: a for a in response.answers}
    counts = {RESULT_CORRECT: 0, RESULT_INCORRECT: 0, RESULT_NOT_GRADED: 0, RESULT_UNANSWERED: 0}
    for question in questions:
        counts[_grading_result(answers_by_question.get(question.id))] += 1
    return counts, answers_by_question


def _load_image_flowable(load_image_bytes, image_url: str):
    """Best-effort: a missing file, a network failure, or an unreadable
    image all degrade to None (rendered by the caller as a documented
    placeholder) rather than failing the whole export over one image. Only
    the base image is embedded - see the module-level note on annotation
    overlays."""
    if load_image_bytes is None:
        return None
    try:
        raw = load_image_bytes(image_url)
        if not raw:
            return None
        reader = ImageReader(io.BytesIO(raw))
        width, height = reader.getSize()
        if not width or not height:
            return None
        scale = min(_MAX_IMAGE_WIDTH / width, _MAX_IMAGE_HEIGHT / height, 1.0)
        return RLImage(io.BytesIO(raw), width=width * scale, height=height * scale)
    except Exception:
        return None


def build_results_csv(quiz, responses: list) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_HEADER)

    questions = sorted(quiz.questions, key=lambda q: q.position)
    for response in sorted(responses, key=lambda r: r.display_name.lower()):
        answers_by_question = {a.question_id: a for a in response.answers}
        for i, question in enumerate(questions, start=1):
            answer = answers_by_question.get(question.id)
            writer.writerow(
                [
                    response.display_name,
                    response.submitted_at.isoformat(),
                    i,
                    question.question_text,
                    question.question_type.value,
                    _answer_text(question, answer),
                    _CORRECT_LABELS[answer.is_correct] if answer else "No answer",
                    (answer.coach_feedback or "") if answer else "",
                ]
            )

    return buffer.getvalue()


def _make_footer(theme: dict, quiz_title: str):
    """A reportlab onPage callback: fills the page background from the
    theme (white today - painting it explicitly, rather than relying on
    the canvas's implicit blank white, keeps BACKGROUND a real, used theme
    value) and draws a thin top rule plus a small running footer -
    "Peira · <quiz title> · Page N" - in the theme's muted footer color."""

    def _draw(canvas, doc):
        canvas.saveState()
        page_width, page_height = letter
        canvas.setFillColor(theme["background"])
        canvas.rect(0, 0, page_width, page_height, stroke=0, fill=1)

        footer_y = 0.4 * inch
        canvas.setStrokeColor(theme["border"])
        canvas.setLineWidth(0.5)
        canvas.line(doc.leftMargin, footer_y + 12, page_width - doc.rightMargin, footer_y + 12)

        canvas.setFont(theme["body_font"], theme["body_sizes"]["footer"])
        canvas.setFillColor(theme["footer_text"])
        left_text = f"{theme.get('wordmark_text', 'Peira')} · {quiz_title}"
        canvas.drawString(doc.leftMargin, footer_y, left_text[:100])
        canvas.drawRightString(page_width - doc.rightMargin, footer_y, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    return _draw


def build_results_pdf(quiz, dashboard_data: dict, responses: list, theme: dict | None = None) -> bytes:
    theme = theme or PDF_THEME
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, title=f"{quiz.title} - Results")
    styles = _pdf_styles(theme)
    elements = [
        _brand_mark(theme, styles),
        Paragraph(_xml_escape(quiz.title), styles["title"]),
        Paragraph("Results", styles["heading3"]),
        Paragraph(f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", styles["label"]),
        Spacer(1, theme["spacing"]["sm"]),
        _divider(theme),
        _metric_block(
            theme,
            [
                ("Roster Size", str(dashboard_data["roster_size"])),
                ("Responses", str(dashboard_data["response_count"])),
                ("Response Rate", f"{round(dashboard_data['response_rate'] * 100)}%"),
            ],
        ),
        Spacer(1, theme["spacing"]["xl"]),
    ]

    if dashboard_data["question_breakdown"]:
        elements.append(Paragraph("Per-question breakdown", styles["heading2"]))
        breakdown_rows = [["Question", "Correct", "Incorrect", "Ungraded"]]
        for q in dashboard_data["question_breakdown"]:
            breakdown_rows.append(
                [q["question_text"], str(q["correct_count"]), str(q["incorrect_count"]), str(q["ungraded_count"])]
            )
        elements.append(_styled_table(theme, breakdown_rows, first_col_width=300))
        elements.append(Spacer(1, theme["spacing"]["xl"]))

    elements.append(Paragraph("Player scores", styles["heading2"]))
    if responses:
        score_rows = [["Player", "Submitted", "Score", "Ungraded"]]
        for response in sorted(responses, key=lambda r: r.display_name.lower()):
            graded = [a for a in response.answers if a.is_correct is not None]
            correct = sum(1 for a in graded if a.is_correct)
            ungraded = len(response.answers) - len(graded)
            score_rows.append(
                [
                    response.display_name,
                    _format_short_timestamp(response.submitted_at),
                    f"{correct}/{len(graded)}",
                    str(ungraded),
                ]
            )
        elements.append(_styled_table(theme, score_rows, first_col_width=180))
    else:
        elements.append(Paragraph("No responses yet.", styles["normal"]))

    footer = _make_footer(theme, quiz.title)
    doc.build(elements, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()


def _styled_table(theme: dict, rows: list[list[str]], first_col_width: int) -> Table:
    table = Table(rows, colWidths=[first_col_width] + [None] * (len(rows[0]) - 1))
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), theme["header_fill"]),
        ("TEXTCOLOR", (0, 0), (-1, -1), theme["primary_text"]),
        ("TEXTCOLOR", (0, 0), (-1, 0), theme["header_text"]),
        ("FONTNAME", (0, 0), (-1, 0), theme["heading_font"]),
        ("FONTNAME", (0, 1), (-1, -1), theme["body_font"]),
        ("GRID", (0, 0), (-1, -1), 0.5, theme["border"]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 0), (-1, -1), theme["body_sizes"]["normal"] - 1),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
        ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [theme["background"], theme["alt_row_fill"]]),
    ]
    table.setStyle(TableStyle(style))
    return table


# Explicit widths (points) for the 9-column page-1 roster table - sums to
# well under the 468pt (6.5in) usable width, with generous room for the
# shortened "Aug 5, 12:06 AM"-style Submitted timestamp (see
# _format_short_timestamp) so it can never collide with the Correct column
# again. Player/Position wrap as Paragraphs so a long name/position never
# overflows its column instead of being clipped.
_SUMMARY_COL_WIDTHS = [78, 24, 38, 70, 36, 42, 48, 48, 36]


def _detailed_summary_table(theme: dict, rows: list[list], wrap_style: ParagraphStyle) -> Table:
    header = rows[0]
    body = [
        [
            Paragraph(_xml_escape(str(cell)), wrap_style) if i in (0, 2) else cell
            for i, cell in enumerate(row)
        ]
        for row in rows[1:]
    ]
    table = Table([header, *body], colWidths=_SUMMARY_COL_WIDTHS, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), theme["header_fill"]),
        ("TEXTCOLOR", (0, 0), (-1, -1), theme["primary_text"]),
        ("TEXTCOLOR", (0, 0), (-1, 0), theme["header_text"]),
        ("FONTNAME", (0, 0), (-1, 0), theme["heading_font"]),
        ("FONTNAME", (0, 1), (-1, -1), theme["body_font"]),
        ("GRID", (0, 0), (-1, -1), 0.5, theme["border"]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        # Player/Position/Submitted stay left-aligned (text); jersey # and
        # every numeric count/score column are centered for scannability.
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("ALIGN", (4, 0), (8, -1), "CENTER"),
        ("FONTSIZE", (0, 0), (-1, -1), theme["body_sizes"]["small"]),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 1),
        ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [theme["background"], theme["alt_row_fill"]]),
    ]
    table.setStyle(TableStyle(style))
    return table


def build_detailed_results_pdf(
    quiz,
    dashboard_data: dict,
    responses: list,
    organization_name: str,
    load_image_bytes=None,
    theme: dict | None = None,
) -> bytes:
    """A full, per-Player, per-question results report for every SUBMITTED
    attempt: a page-1 quiz summary, then one page-broken section per
    Player covering every question in quiz order. Purely a read/render
    pass over already-loaded data - see the module docstring; this never
    writes to the database.

    `load_image_bytes`, when given, is `(image_url) -> bytes | None` -
    injected rather than importing app.services.file_storage directly, so
    this stays trivially unit-testable without a real storage backend. A
    missing/unreadable image renders as a documented placeholder instead
    of failing the export (see _load_image_flowable). Only the base image
    is embedded for an image question - annotation overlays are drawn
    client-side only (Fabric.js) and have no server-rendered flattened
    version to embed; this is a known, documented limitation, not an
    oversight.

    `theme`, when given, overrides PDF_THEME entirely - see that dict's
    docstring for why every layout choice below reads from this parameter
    instead of a hardcoded value.
    """
    theme = theme or PDF_THEME
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        title=f"{quiz.title} - Detailed Results",
        topMargin=0.6 * inch,
        bottomMargin=0.7 * inch,
    )
    styles = _pdf_styles(theme)
    wrap_style = styles["wrap"]
    label_style = styles["label"]

    questions = sorted(quiz.questions, key=lambda q: q.position)
    ordered_responses = sorted(responses, key=_player_sort_key)

    # One pass to compute every Player's counts/answers-by-question up
    # front - page 1's summary table and each Player's own detail section
    # both read from this, so the two can never disagree.
    per_response = {r.id: _player_result_counts(questions, r) for r in ordered_responses}

    # --- Page 1: report header + summary metrics + roster table ---
    elements: list = [
        _brand_mark(theme, styles),
        Paragraph(_xml_escape(organization_name), styles["label"]),
        Paragraph(_xml_escape(quiz.title), styles["title"]),
        Paragraph("Detailed Results", styles["heading3"]),
        Paragraph(
            f"Exported {datetime.now(timezone.utc).strftime('%B %d, %Y at %I:%M %p UTC')}", styles["label"]
        ),
        Spacer(1, theme["spacing"]["sm"]),
        _divider(theme),
    ]

    total_correct = 0
    total_graded = 0
    fully_graded_count = 0
    awaiting_grading_count = 0
    summary_rows = [
        ["Player", "#", "Position", "Submitted", "Correct", "Incorrect", "Not Graded", "Unanswered", "Score"]
    ]
    for response in ordered_responses:
        counts, _answers_by_question = per_response[response.id]
        score_percent = _score_percent(counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT])
        total_correct += counts[RESULT_CORRECT]
        total_graded += counts[RESULT_CORRECT] + counts[RESULT_INCORRECT]
        if counts[RESULT_NOT_GRADED] == 0:
            fully_graded_count += 1
        else:
            awaiting_grading_count += 1

        player = response.player
        summary_rows.append(
            [
                response.display_name,
                player.jersey_number if player and player.jersey_number else "—",
                player.position if player and player.position else "—",
                _format_short_timestamp(response.submitted_at),
                str(counts[RESULT_CORRECT]),
                str(counts[RESULT_INCORRECT]),
                str(counts[RESULT_NOT_GRADED]),
                str(counts[RESULT_UNANSWERED]),
                f"{score_percent}%" if score_percent is not None else "—",
            ]
        )

    org_average = _score_percent(total_correct, total_graded)
    elements.append(
        _metric_block(
            theme,
            [
                ("Total Assigned", str(dashboard_data["roster_size"])),
                ("Total Submitted", str(dashboard_data["response_count"])),
                ("Average Score", f"{org_average}%" if org_average is not None else "—"),
                ("Fully Graded", str(fully_graded_count)),
                ("Awaiting Grading", str(awaiting_grading_count)),
            ],
        )
    )
    elements.append(Spacer(1, theme["spacing"]["xl"]))

    if ordered_responses:
        elements.append(Paragraph("Player Summary", styles["heading2"]))
        elements.append(Spacer(1, theme["spacing"]["xs"]))
        elements.append(_detailed_summary_table(theme, summary_rows, wrap_style))
    else:
        elements.append(
            Paragraph("No submitted Player responses are available to export yet.", styles["normal"])
        )

    # --- One page-broken section per Player ---
    for response in ordered_responses:
        elements.append(PageBreak())
        counts, answers_by_question = per_response[response.id]
        score_percent = _score_percent(counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT])
        player = response.player

        header_bits = [_xml_escape(response.display_name)]
        if player and player.position:
            header_bits.append(_xml_escape(player.position))
        header = f"{header_bits[0]} — {header_bits[1]}" if len(header_bits) > 1 else header_bits[0]
        if player and player.jersey_number:
            header = f"#{_xml_escape(player.jersey_number)} {header}"
        elements.append(Paragraph(header, styles["heading2"]))
        elements.append(
            Paragraph(f"Submitted: {_format_short_timestamp(response.submitted_at)}", label_style)
        )
        elements.append(Spacer(1, theme["spacing"]["xs"]))
        elements.append(_divider(theme))

        elements.append(
            _metric_block(
                theme,
                [
                    ("Correct", str(counts[RESULT_CORRECT])),
                    ("Incorrect", str(counts[RESULT_INCORRECT])),
                    ("Not Graded", str(counts[RESULT_NOT_GRADED])),
                    ("Unanswered", str(counts[RESULT_UNANSWERED])),
                    ("Score", f"{score_percent}%" if score_percent is not None else "—"),
                ],
            )
        )
        if score_percent is None:
            elements.append(Spacer(1, theme["spacing"]["xs"]))
            elements.append(Paragraph("Score not available (nothing graded yet).", label_style))
        elif counts[RESULT_NOT_GRADED] > 0:
            plural = "s" if counts[RESULT_NOT_GRADED] != 1 else ""
            elements.append(Spacer(1, theme["spacing"]["xs"]))
            elements.append(Paragraph(f"{counts[RESULT_NOT_GRADED]} response{plural} awaiting grading", label_style))
        elements.append(Spacer(1, theme["spacing"]["lg"]))

        for i, question in enumerate(questions, start=1):
            answer = answers_by_question.get(question.id)
            result = _grading_result(answer)

            block: list = [
                Paragraph(f"Question {i}", styles["heading4"]),
                Paragraph(_xml_escape(question.question_text), wrap_style),
            ]

            image_flowable = None
            if question.image is not None:
                image_flowable = _load_image_flowable(load_image_bytes, question.image.image_url)
            if question.image is not None and image_flowable is None:
                block.append(Spacer(1, theme["spacing"]["xs"]))
                block.append(Paragraph("[Image unavailable]", label_style))
            elif image_flowable is not None:
                block.append(Spacer(1, theme["spacing"]["sm"]))
                block.append(image_flowable)

            block.append(Spacer(1, theme["spacing"]["sm"]))
            block.append(Paragraph("Player Answer:", label_style))
            block.append(
                Paragraph(_xml_escape(_answer_text(question, answer)) or "No answer submitted.", wrap_style)
            )

            if question.question_type.value != "written":
                correct_option = next((o for o in question.options if o.is_correct_answer), None)
                if correct_option is not None:
                    block.append(Paragraph("Correct Answer:", label_style))
                    block.append(Paragraph(_xml_escape(correct_option.option_text), wrap_style))

            if answer is not None and answer.coach_feedback:
                block.append(Paragraph("Coach Feedback:", label_style))
                block.append(Paragraph(_xml_escape(answer.coach_feedback), wrap_style))

            block.append(Paragraph(f"Result: {result}", styles["normal"]))

            elements.append(_question_card(theme, block))
            elements.append(Spacer(1, theme["spacing"]["sm"]))

    footer = _make_footer(theme, quiz.title)
    doc.build(elements, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
