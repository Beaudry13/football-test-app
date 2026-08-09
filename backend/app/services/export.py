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
dict (PDF_THEME is the default) - see that dict's docstring. Per-
organization branding, when it lands, means constructing a different
theme dict and passing it in, never rewriting build_results_pdf/
build_detailed_results_pdf or the helpers they call.

Visual design intent (the brief this layout answers): a coaching report
that reads as *deliberately designed* the moment a coach opens or shares
it, while staying cheap to print in quantity. The character comes from
structure and restraint, not decoration - a real Peira mark in the
masthead, a gold double rule, letterspaced small-caps eyebrows and
section headers, separated metric cards with a gold top edge, a
horizontal-rules-only roster table, question cards with a gold left edge,
and status chips on near-white fills. Everything that carries ink is a
hairline or a ~95%-luminance tint; there is no full-bleed dark panel, no
large gold block, and no watermark anywhere in this module. A coach
printing 25 Player pages on a department laser printer is the design
constraint. Status is always carried by a *word* ("Correct", "Not
Graded"), never by color alone, so the report survives grayscale printing
and colorblind readers intact.
"""

import csv
import io
import re
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    HRFlowable,
    Image as RLImage,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models.question import TEXT_ANSWER_TYPES, QuestionType

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

# The real Peira mark, shipped with the backend so the PDF never depends on
# the frontend build or a network fetch. Kept small in the masthead (see
# _LOGO_MAX_HEIGHT): it's a thin gold serif monogram on transparency, so at
# report scale it costs essentially no ink. _brand_mark() still degrades to
# the text wordmark if this file is ever missing from a deploy.
_PEIRA_MARK_PATH = Path(__file__).resolve().parent.parent / "assets" / "peira-mark.png"

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
# The palette is print-first by construction:
# - White BACKGROUND, charcoal PRIMARY_TEXT / muted SECONDARY_TEXT for body
#   copy - never pure black.
# - A restrained gold/bronze ACCENT + softer SECONDARY_ACCENT, used only
#   for hairlines, small-caps labels, the card edge, and the wordmark -
#   never a large filled panel.
# - Pale cream LIGHT_FILL / METRIC_FILL, a slightly deeper HEADER_FILL, and
#   a barely-there ALT_ROW_FILL: every fill in this module sits at ~95%+
#   luminance, so a full page of them costs a fraction of the toner a
#   single dark header bar would.
# - Muted-gold BORDER / METRIC_BORDER for rules and card outlines, plus a
#   lighter HAIRLINE for in-table row separators, instead of pure grey.
# - RESULT_STYLES: per-status (fill, text) pairs for the per-question
#   chips. Deliberately near-white tints, and always paired with the status
#   WORD, so the report is unambiguous in grayscale.
# - HEADING_FONT / BODY_FONT + HEADING_SIZES / BODY_SIZES / SPACING /
#   CHAR_SPACE so typography and layout rhythm are as swappable as color.
#   CHAR_SPACE drives the letterspaced small-caps used for eyebrows,
#   section headers, table headers and metric labels - the single biggest
#   reason this reads as designed rather than as default ReportLab.
# - LOGO_PATH: the real shipped Peira mark. See _brand_mark(), which still
#   degrades to WORDMARK_TEXT styled with ACCENT if it's unset/unreadable.
PDF_THEME = {
    "background": colors.HexColor("#FFFFFF"),
    "primary_text": colors.HexColor("#2A2416"),
    "secondary_text": colors.HexColor("#6E6858"),
    "accent": colors.HexColor("#A6822F"),
    "secondary_accent": colors.HexColor("#8A6D1F"),
    "light_fill": colors.HexColor("#F7F4EC"),
    "alt_row_fill": colors.HexColor("#FBFAF6"),
    "border": colors.HexColor("#D9CFA8"),
    "hairline": colors.HexColor("#E7E1CE"),
    "header_fill": colors.HexColor("#F7F4EC"),
    "header_text": colors.HexColor("#5C4A1A"),
    "metric_fill": colors.HexColor("#FBF9F3"),
    "metric_border": colors.HexColor("#E2D9BC"),
    "footer_text": colors.HexColor("#8C8578"),
    "result_styles": {
        RESULT_CORRECT: (colors.HexColor("#EDF3EE"), colors.HexColor("#2F5D3F")),
        RESULT_INCORRECT: (colors.HexColor("#FBF0EE"), colors.HexColor("#8C2F26")),
        RESULT_NOT_GRADED: (colors.HexColor("#FBF5E8"), colors.HexColor("#7A5A12")),
        RESULT_UNANSWERED: (colors.HexColor("#F4F3F0"), colors.HexColor("#5E5A50")),
    },
    "heading_font": "Helvetica-Bold",
    "body_font": "Helvetica",
    "heading_sizes": {"display": 21, "title": 18, "h2": 13, "h3": 11, "h4": 9.5, "metric": 16, "jersey": 15},
    "body_sizes": {
        "normal": 10,
        "label": 8.5,
        "small": 7.5,
        "footer": 7.5,
        "eyebrow": 7,
        "chip": 7.5,
        # Table headers run narrower than any other letterspaced label, so
        # they get their own slightly smaller size/tracking pair - see
        # _SUMMARY_COL_WIDTHS, whose widths are measured against these.
        "table_header": 6.5,
    },
    "spacing": {"xs": 2, "sm": 4, "md": 8, "lg": 12, "xl": 16},
    "char_space": {"eyebrow": 1.5, "label": 0.7, "table": 0.5},
    "rule": {"strong": 1.8, "thin": 0.5, "hair": 0.4, "edge": 2.5},
    "logo_path": str(_PEIRA_MARK_PATH),
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
        # The quiz title on page 1 - the largest thing in the report.
        "display": ParagraphStyle(
            "PeiraDisplay",
            parent=base["Title"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["display"],
            leading=theme["heading_sizes"]["display"] * 1.12,
            textColor=theme["primary_text"],
            alignment=0,
            spaceAfter=0,
        ),
        "title": ParagraphStyle(
            "PeiraTitle",
            parent=base["Title"],
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["title"],
            textColor=theme["primary_text"],
            alignment=0,
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
            charSpace=theme["char_space"]["eyebrow"],
            spaceAfter=0,
        ),
        # Letterspaced small-caps. Used for the report kicker, section
        # headers, table headers and metric labels - one typographic device,
        # applied consistently, is what separates this from a default
        # ReportLab export while costing no extra ink.
        "eyebrow": ParagraphStyle(
            "PeiraEyebrow",
            parent=normal,
            fontName=theme["heading_font"],
            fontSize=theme["body_sizes"]["eyebrow"],
            leading=theme["body_sizes"]["eyebrow"] * 1.4,
            textColor=theme["accent"],
            charSpace=theme["char_space"]["eyebrow"],
            spaceAfter=0,
        ),
        # Same device in a muted tone, for the "PLAYER ANSWER" /
        # "CORRECT ANSWER" / "COACH FEEDBACK" field labels inside a card.
        "fieldLabel": ParagraphStyle(
            "PeiraFieldLabel",
            parent=normal,
            fontName=theme["heading_font"],
            fontSize=theme["body_sizes"]["eyebrow"],
            leading=theme["body_sizes"]["eyebrow"] * 1.4,
            textColor=theme["secondary_text"],
            charSpace=theme["char_space"]["label"],
            spaceBefore=theme["spacing"]["sm"],
            spaceAfter=1,
        ),
        "metaRight": ParagraphStyle(
            "PeiraMetaRight",
            parent=normal,
            fontSize=theme["body_sizes"]["small"],
            leading=theme["body_sizes"]["small"] * 1.5,
            textColor=theme["secondary_text"],
            alignment=2,
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


def _masthead(theme: dict, styles: dict[str, ParagraphStyle], right_lines: list[str]) -> list:
    """The report's letterhead: the Peira mark + wordmark on the left, small
    right-aligned context (organization, export timestamp) on the right,
    closed by a gold double rule.

    The double rule - one heavy-ish line with a hairline just beneath - is
    the single most recognizable "this was designed" cue available at
    almost zero ink cost, and it's the same device the section headers and
    footer echo further down the page."""
    mark = _brand_mark(theme, styles)
    wordmark = Paragraph(_xml_escape(theme.get("wordmark_text", "Peira")).upper(), styles["eyebrow"])
    # Mark and wordmark stacked, so the lockup stays intact whether the
    # mark resolved to the real image or fell back to a text wordmark.
    left = Table([[mark], [wordmark]], colWidths=[2.4 * inch])
    left.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (0, 0), theme["spacing"]["xs"]),
                ("BOTTOMPADDING", (0, 1), (0, 1), 0),
                ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
            ]
        )
    )

    right = Paragraph("<br/>".join(_xml_escape(line) for line in right_lines), styles["metaRight"])
    row = Table([[left, right]], colWidths=[2.6 * inch, _CONTENT_WIDTH - 2.6 * inch])
    row.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ("VALIGN", (0, 0), (0, 0), "BOTTOM"),
                ("VALIGN", (1, 0), (1, 0), "BOTTOM"),
            ]
        )
    )
    return [row, Spacer(1, theme["spacing"]["sm"]), *_double_rule(theme)]


def _double_rule(theme: dict) -> list:
    """Gold rule + hairline beneath it. Two thin strokes, no fill - the
    report's signature divider."""
    return [
        HRFlowable(width="100%", thickness=theme["rule"]["strong"], color=theme["accent"], spaceBefore=0, spaceAfter=1.6),
        HRFlowable(width="100%", thickness=theme["rule"]["hair"], color=theme["accent"], spaceBefore=0, spaceAfter=0),
    ]


def _section_header(theme: dict, styles: dict[str, ParagraphStyle], text: str) -> Table:
    """A letterspaced small-caps section title sitting on a gold rule, with
    a short heavier tick under the label itself. Reads as a designed header
    band without filling any area."""
    label = Paragraph(_xml_escape(text).upper(), styles["eyebrow"])
    table = Table([[label]], colWidths=[_CONTENT_WIDTH])
    table.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
                ("LINEBELOW", (0, 0), (0, 0), theme["rule"]["thin"], theme["accent"]),
            ]
        )
    )
    return table


def _result_chip(theme: dict, result: str) -> Table:
    """The per-question status, as a small tinted chip rather than a run of
    body text. The status WORD is always present - the tint is a secondary
    cue only, so nothing is lost in grayscale or to a colorblind reader,
    and every fill here is near-white so a 25-page print stays cheap."""
    fill, text_color = theme["result_styles"][result]
    style = ParagraphStyle(
        "PeiraChip",
        fontName=theme["heading_font"],
        fontSize=theme["body_sizes"]["chip"],
        leading=theme["body_sizes"]["chip"] * 1.25,
        textColor=text_color,
        alignment=1,
        charSpace=theme["char_space"]["label"],
    )
    table = Table([[Paragraph(_xml_escape(result).upper(), style)]], colWidths=[1.15 * inch])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), fill),
                ("BOX", (0, 0), (-1, -1), theme["rule"]["hair"], text_color),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 1),
                ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"]),
                ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"]),
            ]
        )
    )
    return table


# Width of the white gutter between metric cards. Real separation (rather
# than dividing lines inside one continuous strip) is what makes the metric
# row read as a designed panel set instead of a bordered table.
_METRIC_GUTTER = 6


def _metric_block(theme: dict, items: list[tuple[str, str]]) -> Table:
    """A row of separated metric cards - a big value over a letterspaced
    small-caps label ("22" over "TOTAL SUBMITTED"), each on a pale cream
    fill with a gold top edge and a hairline outline, divided by real white
    gutters.

    The gold edge is a 1.8pt line, not a filled band: it gives each card a
    clear identity for a few hundredths of a milliliter of toner. Entirely
    themed, so a reskin only ever touches the theme dict."""
    label_style = ParagraphStyle(
        "MetricLabel",
        fontName=theme["heading_font"],
        fontSize=theme["body_sizes"]["eyebrow"],
        leading=theme["body_sizes"]["eyebrow"] * 1.3,
        textColor=theme["secondary_accent"],
        alignment=1,
        charSpace=theme["char_space"]["label"],
        spaceBefore=theme["spacing"]["xs"] + 1,
    )
    value_style = ParagraphStyle(
        "MetricValue",
        fontName=theme["heading_font"],
        fontSize=theme["heading_sizes"]["metric"],
        leading=theme["heading_sizes"]["metric"] * 1.1,
        textColor=theme["primary_text"],
        alignment=1,
    )

    # Interleave zero-width-content gutter columns between the real cards.
    count = len(items)
    total_gutter = _METRIC_GUTTER * (count - 1)
    card_width = (_CONTENT_WIDTH - total_gutter) / count
    col_widths: list[float] = []
    row: list = []
    card_columns: list[int] = []
    for index, (label, value) in enumerate(items):
        if index:
            row.append("")
            col_widths.append(_METRIC_GUTTER)
        card_columns.append(len(row))
        col_widths.append(card_width)
        row.append(
            [
                Paragraph(_xml_escape(value), value_style),
                Paragraph(_xml_escape(label.upper()), label_style),
            ]
        )

    table = Table([row], colWidths=col_widths)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"] + 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"] + 3),
        ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"]),
        ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"]),
    ]
    for column in card_columns:
        style.extend(
            [
                ("BACKGROUND", (column, 0), (column, 0), theme["metric_fill"]),
                ("BOX", (column, 0), (column, 0), theme["rule"]["hair"], theme["metric_border"]),
                ("LINEABOVE", (column, 0), (column, 0), theme["rule"]["strong"], theme["accent"]),
            ]
        )
    table.setStyle(TableStyle(style))
    return table


def _question_card(theme: dict, rows: list[list]) -> Table:
    """Wraps one question in a padded, hairline-outlined block with a solid
    gold left edge - the device that makes each question read as its own
    card at a glance without a fill or a heavy border.

    `rows` is a list of flowable-groups, one per table row, rather than a
    single cell: a one-row table cannot be split, so a question with a long
    written answer plus an image could exceed a page and overflow. Splitting
    between rows lets ReportLab break a very tall question across a page
    boundary at a sensible seam instead. Both the outline and the gold edge
    are drawn per-row, so a split card still looks intentional on both
    halves."""
    table = Table([[group] for group in rows], colWidths=[_CONTENT_WIDTH])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), theme["background"]),
                ("LINEBEFORE", (0, 0), (0, -1), theme["rule"]["edge"], theme["accent"]),
                ("LINEABOVE", (0, 0), (0, 0), theme["rule"]["hair"], theme["border"]),
                ("LINEBELOW", (0, -1), (0, -1), theme["rule"]["hair"], theme["border"]),
                ("LINEAFTER", (0, 0), (0, -1), theme["rule"]["hair"], theme["border"]),
                ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["md"] + 3),
                ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["md"] + 2),
                ("TOPPADDING", (0, 0), (0, 0), theme["spacing"]["md"]),
                # Real separation between the prompt block and the answer
                # fields beneath it - without this the question text and the
                # "PLAYER ANSWER" label sit on top of each other and the card
                # reads as one undifferentiated run of text.
                ("TOPPADDING", (0, 1), (0, -1), theme["spacing"]["sm"] + 1),
                ("BOTTOMPADDING", (0, 0), (0, -2), theme["spacing"]["xs"]),
                ("BOTTOMPADDING", (0, -1), (0, -1), theme["spacing"]["md"]),
            ]
        )
    )
    return table


def _question_card_header(theme: dict, styles: dict[str, ParagraphStyle], number: int, result: str) -> Table:
    """A question card's top line: "QUESTION 3" in letterspaced gold caps on
    the left, the status chip hard right. Putting the status here rather
    than in a trailing line of body text is what lets a coach scan a Player
    page for the misses without reading it."""
    label = Paragraph(f"QUESTION {number}", styles["eyebrow"])
    chip = _result_chip(theme, result)
    inner_width = _CONTENT_WIDTH - (theme["spacing"]["md"] + 3) - (theme["spacing"]["md"] + 2)
    table = Table([[label, chip]], colWidths=[inner_width - 1.15 * inch, 1.15 * inch])
    table.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
                ("VALIGN", (0, 0), (0, 0), "MIDDLE"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
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
    # Both typed types. This used to ask for "written" specifically, which
    # would have sent every Fill in the Blank answer down the option branch
    # below and printed a blank cell for a player who answered correctly.
    if question.question_type in TEXT_ANSWER_TYPES:
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
        left = doc.leftMargin
        right = page_width - doc.rightMargin

        # The masthead's double rule, echoed at the foot of every page - a
        # gold hairline over a lighter one. Two strokes, no fill.
        canvas.setStrokeColor(theme["accent"])
        canvas.setLineWidth(theme["rule"]["hair"])
        canvas.line(left, footer_y + 13, right, footer_y + 13)
        canvas.setStrokeColor(theme["hairline"])
        canvas.setLineWidth(theme["rule"]["hair"])
        canvas.line(left, footer_y + 11.4, right, footer_y + 11.4)

        # "PEIRA" in letterspaced gold caps, then a small diamond, then the
        # quiz title in muted grey - the wordmark stays the strongest thing
        # in the footer without being large.
        wordmark = theme.get("wordmark_text", "Peira").upper()
        char_space = theme["char_space"]["eyebrow"]
        # Letterspacing on the canvas has to go through a text object -
        # Canvas itself has no setCharSpace, only TextObject does.
        text_object = canvas.beginText(left, footer_y)
        text_object.setFont(theme["heading_font"], theme["body_sizes"]["footer"])
        text_object.setFillColor(theme["accent"])
        text_object.setCharSpace(char_space)
        text_object.textOut(wordmark)
        canvas.drawText(text_object)
        wordmark_width = canvas.stringWidth(
            wordmark, theme["heading_font"], theme["body_sizes"]["footer"]
        ) + (char_space * len(wordmark))

        diamond_x = left + wordmark_width + 6
        diamond_y = footer_y + 2.4
        canvas.setFillColor(theme["accent"])
        path = canvas.beginPath()
        path.moveTo(diamond_x, diamond_y + 2.2)
        path.lineTo(diamond_x + 2.2, diamond_y)
        path.lineTo(diamond_x, diamond_y - 2.2)
        path.lineTo(diamond_x - 2.2, diamond_y)
        path.close()
        canvas.drawPath(path, stroke=0, fill=1)

        canvas.setFont(theme["body_font"], theme["body_sizes"]["footer"])
        canvas.setFillColor(theme["footer_text"])
        canvas.drawString(diamond_x + 6, footer_y, quiz_title[:90])
        canvas.drawRightString(right, footer_y, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    return _draw


def build_results_pdf(quiz, dashboard_data: dict, responses: list, theme: dict | None = None) -> bytes:
    theme = theme or PDF_THEME
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, title=f"{quiz.title} - Results")
    styles = _pdf_styles(theme)
    elements = [
        *_masthead(
            theme,
            styles,
            [f"Generated {datetime.now(timezone.utc).strftime('%b %d, %Y at %I:%M %p UTC')}"],
        ),
        Spacer(1, theme["spacing"]["lg"]),
        Paragraph("RESULTS", styles["eyebrow"]),
        Spacer(1, theme["spacing"]["xs"]),
        Paragraph(_xml_escape(quiz.title), styles["display"]),
        Spacer(1, theme["spacing"]["lg"]),
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
        elements.append(_section_header(theme, styles, "Per-question breakdown"))
        breakdown_rows = [["Question", "Correct", "Incorrect", "Ungraded"]]
        for q in dashboard_data["question_breakdown"]:
            breakdown_rows.append(
                [q["question_text"], str(q["correct_count"]), str(q["incorrect_count"]), str(q["ungraded_count"])]
            )
        elements.append(_styled_table(theme, breakdown_rows, first_col_width=300))
        elements.append(Spacer(1, theme["spacing"]["xl"]))

    elements.append(_section_header(theme, styles, "Player scores"))
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


def _table_base_style(theme: dict) -> list:
    """The shared look for every data table in this module: no vertical
    rules and no outer box, a letterspaced small-caps header row on a pale
    cream fill closed by a gold rule, hairline separators between body
    rows, barely-there alternating row tint, and a gold rule under the last
    row to close the block.

    Dropping the full GRID is the single biggest visual upgrade here - a
    boxed grid is what makes a table look like default ReportLab output,
    and horizontal-only rules both read as more considered and use
    meaningfully less ink on a 25-row roster."""
    return [
        ("BACKGROUND", (0, 0), (-1, 0), theme["header_fill"]),
        ("TEXTCOLOR", (0, 0), (-1, -1), theme["primary_text"]),
        ("TEXTCOLOR", (0, 0), (-1, 0), theme["header_text"]),
        ("FONTNAME", (0, 0), (-1, 0), theme["heading_font"]),
        ("FONTNAME", (0, 1), (-1, -1), theme["body_font"]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEABOVE", (0, 0), (-1, 0), theme["rule"]["thin"], theme["accent"]),
        ("LINEBELOW", (0, 0), (-1, 0), theme["rule"]["strong"], theme["accent"]),
        ("LINEBELOW", (0, 1), (-1, -2), theme["rule"]["hair"], theme["hairline"]),
        ("LINEBELOW", (0, -1), (-1, -1), theme["rule"]["thin"], theme["accent"]),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [theme["background"], theme["alt_row_fill"]]),
    ]


def _header_cells(theme: dict, header: list[str]) -> list:
    """Table header labels as letterspaced small caps - the same device as
    the section headers and metric labels, so the whole report speaks one
    typographic language."""
    style = ParagraphStyle(
        "PeiraTableHeader",
        fontName=theme["heading_font"],
        fontSize=theme["body_sizes"]["table_header"],
        leading=theme["body_sizes"]["table_header"] * 1.35,
        textColor=theme["header_text"],
        charSpace=theme["char_space"]["table"],
        # A header label must never be broken inside a word - "INCORRE /
        # CT" is exactly the kind of unfinished detail that makes a report
        # look auto-generated. Column widths are sized so this never has to
        # overflow (see _SUMMARY_COL_WIDTHS); multi-word labels like
        # "Not Graded" still wrap normally at the space.
        splitLongWords=0,
    )
    centered = ParagraphStyle("PeiraTableHeaderCenter", parent=style, alignment=1)
    return [
        Paragraph(_xml_escape(str(label)).upper(), style if i == 0 else centered)
        for i, label in enumerate(header)
    ]


def _styled_table(theme: dict, rows: list[list[str]], first_col_width: int) -> Table:
    """A two-part table: a wrapping text column on the left, numeric columns
    on the right.

    The first column's cells are Paragraphs, not raw strings: a raw string
    cell cannot wrap, so a long question prompt used to run straight across
    the numeric columns and collide with the counts. Remaining width is
    divided evenly across the numeric columns rather than left to
    ReportLab's `None` auto-sizing, so the layout is deterministic
    regardless of content."""
    body_style = ParagraphStyle(
        "PeiraTableCell",
        fontName=theme["body_font"],
        fontSize=theme["body_sizes"]["normal"] - 1,
        leading=(theme["body_sizes"]["normal"] - 1) * 1.3,
        textColor=theme["primary_text"],
    )
    column_count = len(rows[0])
    numeric_width = (_CONTENT_WIDTH - first_col_width) / (column_count - 1)

    header = _header_cells(theme, rows[0])
    body = [
        [Paragraph(_xml_escape(str(row[0])), body_style), *row[1:]]
        for row in rows[1:]
    ]
    table = Table(
        [header, *body],
        colWidths=[first_col_width] + [numeric_width] * (column_count - 1),
        repeatRows=1,
    )
    style = _table_base_style(theme) + [
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
        ("FONTSIZE", (0, 1), (-1, -1), theme["body_sizes"]["normal"] - 1),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
    ]
    table.setStyle(TableStyle(style))
    return table


# Explicit widths (points) for the 9-column page-1 roster table. Sums to
# exactly the 468pt (6.5in) usable width - every column here is at its
# measured minimum or above, and the leftovers all went to Player.
#
# Every width here is measured, not guessed: each column is at least wide
# enough for its own letterspaced header word plus 8pt of cell padding, so
# no header can break mid-word ("INCORRE / CT"), and the Submitted column
# still clears the widest "Aug 4, 11:34 PM"-style timestamp (55.9pt) that
# _format_short_timestamp can produce, which is what fixed the original
# Submitted/Correct collision. Player is deliberately the widest column:
# it carries real names, wraps as a Paragraph, and its 100pt of usable
# space is the measured minimum at which a long double-barrelled surname
# breaks at its own hyphen ("Christopher Vandermeulen- / Fitzgerald")
# rather than mid-word ("Vandermeul / en-Fitzgerald"). Any narrower and
# ReportLab splits inside the word regardless of embeddedHyphenation.
_SUMMARY_COL_WIDTHS = [108, 16, 44, 69, 44, 52, 40, 61, 34]


def _detailed_summary_table(theme: dict, rows: list[list], wrap_style: ParagraphStyle) -> Table:
    """The page-1 roster table. Same horizontal-rules-only treatment as
    every other table here, plus two roster-specific touches: the Player
    name is set in the heading face so a coach can find a name by shape,
    and the Score column is emphasized as the column the eye goes to."""
    header = _header_cells(theme, rows[0])
    name_style = ParagraphStyle(
        "PeiraRosterName",
        parent=wrap_style,
        fontName=theme["heading_font"],
        fontSize=theme["body_sizes"]["small"],
        leading=theme["body_sizes"]["small"] * 1.3,
        # A double-barrelled surname should break at its own hyphen
        # ("Vandermeulen- / Fitzgerald"), not at an arbitrary letter
        # ("Vande / rmeulen-Fitzgerald"). embeddedHyphenation makes
        # ReportLab treat an existing hyphen as a legal break point, which
        # it otherwise ignores.
        embeddedHyphenation=1,
    )
    cell_style = ParagraphStyle(
        "PeiraRosterCell",
        parent=wrap_style,
        fontSize=theme["body_sizes"]["small"],
        leading=theme["body_sizes"]["small"] * 1.3,
        textColor=theme["secondary_text"],
    )
    body = []
    for row in rows[1:]:
        cells = []
        for i, cell in enumerate(row):
            if i == 0:
                cells.append(Paragraph(_xml_escape(str(cell)), name_style))
            elif i == 2:
                cells.append(Paragraph(_xml_escape(str(cell)), cell_style))
            else:
                cells.append(cell)
        body.append(cells)

    table = Table([header, *body], colWidths=_SUMMARY_COL_WIDTHS, repeatRows=1)
    style = _table_base_style(theme) + [
        # Player/Position/Submitted stay left-aligned (text); jersey # and
        # every numeric count/score column are centered for scannability.
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("ALIGN", (4, 0), (8, -1), "CENTER"),
        ("FONTSIZE", (0, 1), (-1, -1), theme["body_sizes"]["small"]),
        # Score is the column a coach scans first - give it the heading face.
        ("FONTNAME", (8, 1), (8, -1), theme["heading_font"]),
        ("TEXTCOLOR", (8, 1), (8, -1), theme["primary_text"]),
        ("TOPPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("BOTTOMPADDING", (0, 0), (-1, -1), theme["spacing"]["sm"]),
        ("LEFTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), theme["spacing"]["xs"] + 2),
    ]
    table.setStyle(TableStyle(style))
    return table


def _player_page_header(theme: dict, styles: dict[str, ParagraphStyle], response, player) -> Table:
    """A Player detail page's masthead: the jersey number in a bordered
    cream square, the Player's name set large beside it, position and
    submission time beneath. Gives every Player page a clear identity
    instead of opening on an undifferentiated bold line of text."""
    # Keep the "#" prefix: in the box it reads unambiguously as a jersey
    # number rather than a bare figure, and it survives text extraction
    # (screen readers, copy-paste, search) where the visual box is lost.
    jersey_text = f"#{player.jersey_number}" if player and player.jersey_number else "—"
    jersey_style = ParagraphStyle(
        "PeiraJersey",
        fontName=theme["heading_font"],
        fontSize=theme["heading_sizes"]["jersey"],
        leading=theme["heading_sizes"]["jersey"] * 1.1,
        textColor=theme["accent"],
        alignment=1,
    )
    jersey = Table([[Paragraph(_xml_escape(jersey_text), jersey_style)]], colWidths=[0.5 * inch], rowHeights=[0.5 * inch])
    jersey.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), theme["metric_fill"]),
                ("BOX", (0, 0), (-1, -1), theme["rule"]["thin"], theme["accent"]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )

    meta_bits = []
    if player and player.position:
        meta_bits.append(player.position)
    meta_bits.append(f"Submitted {_format_short_timestamp(response.submitted_at)}")
    identity = [
        Paragraph(_xml_escape(response.display_name), styles["title"]),
        Paragraph(_xml_escape("  ·  ".join(meta_bits)), styles["label"]),
    ]

    table = Table([[jersey, identity]], colWidths=[0.5 * inch + 10, _CONTENT_WIDTH - 0.5 * inch - 10])
    table.setStyle(
        TableStyle(
            [
                ("LEFTPADDING", (0, 0), (0, 0), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 10),
                ("LEFTPADDING", (1, 0), (1, 0), 0),
                ("RIGHTPADDING", (1, 0), (1, 0), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
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
        *_masthead(
            theme,
            styles,
            [
                organization_name,
                f"Exported {datetime.now(timezone.utc).strftime('%b %d, %Y at %I:%M %p UTC')}",
            ],
        ),
        Spacer(1, theme["spacing"]["lg"]),
        Paragraph("DETAILED RESULTS", styles["eyebrow"]),
        Spacer(1, theme["spacing"]["xs"]),
        Paragraph(_xml_escape(quiz.title), styles["display"]),
        Spacer(1, theme["spacing"]["lg"]),
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
        elements.append(_section_header(theme, styles, "Player Summary"))
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

        elements.append(Paragraph("PLAYER REPORT", styles["eyebrow"]))
        elements.append(Spacer(1, theme["spacing"]["xs"]))
        elements.append(_player_page_header(theme, styles, response, player))
        elements.append(Spacer(1, theme["spacing"]["sm"]))
        elements.extend(_double_rule(theme))
        elements.append(Spacer(1, theme["spacing"]["md"]))

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

        # Each question renders as a card built from row-groups (see
        # _question_card): the header row carries "QUESTION n" + the status
        # chip, then the prompt, then any image, then the answer fields.
        # Every field the old layout printed is still here - the status just
        # moved from a trailing "Result:" line up into the header chip.
        for i, question in enumerate(questions, start=1):
            answer = answers_by_question.get(question.id)
            result = _grading_result(answer)

            prompt_group: list = [
                _question_card_header(theme, styles, i, result),
                Paragraph(_xml_escape(question.question_text), wrap_style),
            ]

            image_flowable = None
            if question.image is not None:
                image_flowable = _load_image_flowable(load_image_bytes, question.image.image_url)
            if question.image is not None and image_flowable is None:
                prompt_group.append(Spacer(1, theme["spacing"]["xs"]))
                prompt_group.append(Paragraph("[Image unavailable]", label_style))
            elif image_flowable is not None:
                prompt_group.append(Spacer(1, theme["spacing"]["sm"]))
                prompt_group.append(image_flowable)

            answer_group: list = [
                Paragraph("PLAYER ANSWER", styles["fieldLabel"]),
                Paragraph(_xml_escape(_answer_text(question, answer)) or "No answer submitted.", wrap_style),
            ]

            if question.question_type is QuestionType.FILL_BLANK:
                # Auto-graded, so there IS a right answer to show - it just
                # lives in expected_answers rather than on an option row.
                accepted = question.expected_answers or []
                if accepted:
                    answer_group.append(Paragraph("ACCEPTED ANSWERS", styles["fieldLabel"]))
                    answer_group.append(Paragraph(_xml_escape(", ".join(accepted)), wrap_style))
            elif question.question_type not in TEXT_ANSWER_TYPES:
                correct_option = next((o for o in question.options if o.is_correct_answer), None)
                if correct_option is not None:
                    answer_group.append(Paragraph("CORRECT ANSWER", styles["fieldLabel"]))
                    answer_group.append(Paragraph(_xml_escape(correct_option.option_text), wrap_style))

            rows = [prompt_group, answer_group]

            if answer is not None and answer.coach_feedback:
                rows.append(
                    [
                        Paragraph("COACH FEEDBACK", styles["fieldLabel"]),
                        Paragraph(_xml_escape(answer.coach_feedback), wrap_style),
                    ]
                )

            elements.append(_question_card(theme, rows))
            elements.append(Spacer(1, theme["spacing"]["md"]))

    footer = _make_footer(theme, quiz.title)
    doc.build(elements, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()


# --- Cumulative performance report ---------------------------------------
#
# A coach's packet, not a business report. The design goal is that twenty
# players can be printed, carried and flipped through - so density beats
# elegance everywhere the two disagree, and the only page breaks are the
# ones ReportLab is forced into.

# Narrower than the quiz exports': this report is scanned, not filed, and
# every point of margin is a row of quiz history that did not fit.
_REPORT_MARGIN = 0.5 * inch

# Quiz / Date / Score, plus Awaiting only when some row actually has
# ungraded work. Each set sums to the printable width at the margin above.
_REPORT_COLS_WITH_PENDING = (300, 70, 60, 110)
_REPORT_COLS = (380, 90, 70)


def _format_report_date(dt: datetime | None) -> str:
    """Compact m/d - no year.

    This report summarises the CURRENT season, so the year is the same on
    every row and repeating it is three characters of clutter in a column
    built for scanning. A report spanning two seasons would be ambiguous,
    which is the known trade being made here deliberately.

    Built by hand because strftime's %-m/%-d is not portable.
    """
    if dt is None:
        return "-"
    return f"{dt.month}/{dt.day}"


def _format_report_percent(value: float | None) -> str:
    """"92%", not "92.0%".

    A trailing ".0" on nearly every score is three characters of noise per
    row that a coach scanning a column never needs; the tenth is kept only
    when it actually says something (86.7%)."""
    if value is None:
        return "-"
    return f"{value:g}%"


def _compact_footer(theme: dict, title: str):
    """A hairline and one line of text.

    The Peira wordmark appears once, in the masthead on page one. Repeating
    it on every page of a twenty-player packet is branding nobody reads,
    printed on space a coach could have used for another two quizzes."""

    def _draw(canvas, doc):
        canvas.saveState()
        page_width, page_height = letter
        canvas.setFillColor(theme["background"])
        canvas.rect(0, 0, page_width, page_height, stroke=0, fill=1)

        footer_y = 0.3 * inch
        left = doc.leftMargin
        right = page_width - doc.rightMargin

        canvas.setStrokeColor(theme["hairline"])
        canvas.setLineWidth(theme["rule"]["hair"])
        canvas.line(left, footer_y + 10, right, footer_y + 10)

        canvas.setFont(theme["body_font"], theme["body_sizes"]["footer"])
        canvas.setFillColor(theme["footer_text"])
        canvas.drawString(left, footer_y, title[:90])
        canvas.drawRightString(right, footer_y, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    return _draw


def _report_styles(theme: dict) -> dict[str, ParagraphStyle]:
    """Type scale for the packet: smaller than the quiz exports throughout,
    with every leading set explicitly - ReportLab's default 1.2x leading is
    what quietly turns a "compact" table back into a loose one."""
    return {
        "player": ParagraphStyle(
            "ReportPlayer",
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h3"],
            leading=13,
            textColor=theme["primary_text"],
        ),
        "stats": ParagraphStyle(
            "ReportStats",
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["label"],
            leading=11,
            textColor=theme["secondary_text"],
        ),
        "cell": ParagraphStyle(
            "ReportCell",
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["small"],
            leading=9,
            textColor=theme["primary_text"],
        ),
        "note": ParagraphStyle(
            "ReportNote",
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["small"],
            leading=10,
            textColor=theme["secondary_text"],
        ),
        "title": ParagraphStyle(
            "ReportTitle",
            fontName=theme["heading_font"],
            fontSize=theme["heading_sizes"]["h2"],
            leading=15,
            textColor=theme["primary_text"],
        ),
        "meta": ParagraphStyle(
            "ReportMeta",
            fontName=theme["body_font"],
            fontSize=theme["body_sizes"]["small"],
            leading=10,
            textColor=theme["secondary_text"],
        ),
        "header_cell": ParagraphStyle(
            "ReportHeaderCell",
            fontName=theme["heading_font"],
            fontSize=theme["body_sizes"]["table_header"],
            leading=8,
            textColor=theme["header_text"],
        ),
    }


def _dense_quiz_table(theme: dict, styles: dict, rows: list[list], show_pending: bool) -> Table:
    """The per-player quiz list, as tight as it can be while staying legible:
    2pt of vertical padding, hairline separators, no outer box, no zebra.

    Every cell is a Paragraph so a long quiz name wraps inside its own column
    instead of running under the date - the widths are chosen so an ordinary
    name still takes exactly one line. `repeatRows` keeps the header on a
    player whose history is long enough to split across a page."""
    widths = _REPORT_COLS_WITH_PENDING if show_pending else _REPORT_COLS
    header = ["Quiz", "Date", "Score"] + (["Awaiting"] if show_pending else [])

    body = [[Paragraph(_xml_escape(str(c)), styles["header_cell"]) for c in header]]
    for row in rows:
        body.append([Paragraph(_xml_escape(str(cell)), styles["cell"]) for cell in row])

    table = Table(body, colWidths=list(widths), hAlign="LEFT", repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), theme["header_fill"]),
                ("LINEBELOW", (0, 0), (-1, 0), theme["rule"]["hair"], theme["border"]),
                ("LINEBELOW", (0, 1), (-1, -2), theme["rule"]["hair"], theme["hairline"]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _player_block(theme: dict, styles: dict, history: dict) -> list:
    """One player, as a list of flowables."""
    player = history["player"]
    name = f"{player['first_name']} {player['last_name']}".strip()
    jersey = (player.get("jersey_number") or "").strip()
    heading = f"#{jersey} {name}" if jersey else name

    overall = history["average_score_percent"]
    pending = history["total_pending_grading_count"]

    # Five metric cards became one line of five words. The labels stay -
    # "87 - 14 - 182" means nothing at a glance - but nothing is repeated
    # per row below, and "Awaiting Grading" is omitted when there is none.
    stats = [
        f"Overall: {_format_report_percent(overall)}",
        f"Completed: {history['completed_count']}",
        f"Correct: {history['total_correct_count']}",
        f"Incorrect: {history['total_incorrect_count']}",
    ]
    if pending:
        stats.append(f"Awaiting Grading: {pending}")

    block = [
        HRFlowable(
            width="100%",
            thickness=theme["rule"]["thin"],
            color=theme["border"],
            spaceBefore=0,
            spaceAfter=4,
        ),
        Paragraph(_xml_escape(heading), styles["player"]),
        Paragraph(
            " &#183; ".join(_xml_escape(item) for item in stats),
            styles["stats"],
        ),
        Spacer(1, 4),
    ]

    results = history["recent_results"]
    if results:
        # The column earns its width only if some row has ungraded work.
        show_pending = any(r["pending_grading_count"] for r in results)
        rows = []
        for result in sorted(results, key=lambda r: (r["submitted_at"] or "", r["quiz_id"])):
            score = result["score_percent"]
            row = [
                result["quiz_title"],
                _format_report_date(
                    datetime.fromisoformat(result["submitted_at"])
                    if result["submitted_at"]
                    else None
                ),
                _format_report_percent(score),
            ]
            if show_pending:
                row.append(str(result["pending_grading_count"]))
            rows.append(row)
        block.append(_dense_quiz_table(theme, styles, rows, show_pending))
    else:
        block.append(Paragraph("No completed quizzes yet.", styles["note"]))

    block.append(Spacer(1, 10))
    return block


def _block_height(block: list, width: float, height: float) -> float | None:
    """Total laid-out height of a player block, or None if it cannot be
    measured. Only ever used to decide whether KeepTogether would help, so a
    failure here degrades to "keep it together" rather than breaking."""
    try:
        return sum(flowable.wrap(width, height)[1] for flowable in block)
    except Exception:
        return None


def build_cumulative_performance_pdf(histories: list[dict], theme: dict | None = None) -> bytes:
    """One PDF covering several players' cumulative performance.

    `histories` are payloads from routes/players.build_player_history with
    `result_limit=None`. THIS FUNCTION COMPUTES NO SCORES. Every number it
    prints is read straight from that payload, which is the same builder the
    player-profile page and the org-wide admin history use - so this report
    cannot disagree with the rest of the app about what a player scored, and
    there is no second cumulative calculation to keep in sync.

    Scope is the caller's problem too: `build_player_history` applies the
    Coach View ownership rule (own quizzes only), so a coach's report can
    never contain a teammate's quiz titles or scores.

    Ungraded work is reported, never scored. A written answer still awaiting
    a coach's grade appears in an "Awaiting" column - shown only when some
    row actually has one - and is absent from correct, incorrect and the
    percentage. A player is not marked wrong because their coach has not read
    their answer yet.

    LAYOUT: players flow one after another down the page, with NO forced page
    breaks. Each player is wrapped in KeepTogether, which asks ReportLab to
    move a whole block to the next page rather than split it - so a break
    happens only when the next player genuinely will not fit. A player whose
    own history is taller than a page still splits rather than looping, and
    the table header repeats on the continuation.
    """
    theme = theme or PDF_THEME
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        title="Cumulative Performance Report",
        leftMargin=_REPORT_MARGIN,
        rightMargin=_REPORT_MARGIN,
        topMargin=_REPORT_MARGIN,
        # Room for the hairline footer, and no more.
        bottomMargin=0.55 * inch,
    )
    styles = _report_styles(theme)
    generated = datetime.now(timezone.utc)

    player_word = "player" if len(histories) == 1 else "players"
    elements = [
        # Page one only. Later pages start straight into the next player - a
        # repeated masthead in a twenty-player packet is nineteen wasted
        # bands of paper.
        _brand_mark(theme, _pdf_styles(theme)),
        Spacer(1, 4),
        Paragraph("Cumulative Performance Report", styles["title"]),
        Paragraph(
            f"{len(histories)} {player_word} &#183; generated "
            f"{generated.strftime('%b %d, %Y')}",
            styles["meta"],
        ),
        Spacer(1, 8),
    ]

    frame_width = letter[0] - (2 * _REPORT_MARGIN)
    frame_height = letter[1] - _REPORT_MARGIN - (0.55 * inch)

    for history in histories:
        block = _player_block(theme, styles, history)

        # KeepTogether only helps when the block CAN fit a page. Applied to a
        # player with more history than a page holds, it pushes the whole
        # thing forward and leaves the previous page blank - which is how a
        # single long player used to waste page one entirely. Measured on a
        # throwaway copy, because Table.wrap caches its column widths and the
        # flowables that get rendered should be untouched.
        measured = _block_height(_player_block(theme, styles, history), frame_width, frame_height)
        if measured is not None and measured > frame_height:
            elements.extend(block)
        else:
            elements.append(KeepTogether(block))

    footer = _compact_footer(theme, "Cumulative Performance Report")
    doc.build(elements, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
