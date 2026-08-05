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
"""

import csv
import io
import re
from datetime import datetime, timezone

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

CSV_HEADER = ["Player", "Submitted At", "Question #", "Question", "Type", "Answer", "Correct", "Coach Feedback"]

_CORRECT_LABELS = {True: "Yes", False: "No", None: "Ungraded"}

RESULT_CORRECT = "Correct"
RESULT_INCORRECT = "Incorrect"
RESULT_NOT_GRADED = "Not Graded"
RESULT_UNANSWERED = "Unanswered"

_MAX_IMAGE_WIDTH = 4.5 * inch
_MAX_IMAGE_HEIGHT = 3.5 * inch

# --- PDF theme -------------------------------------------------------------
#
# Every color either PDF builder below uses comes from this one dict, so a
# future organization-branding feature (school primary/secondary/accent
# colors + logo - not built yet, see the PR description) can swap these
# values without touching the builders themselves. For this release every
# value is Peira's own print-friendly palette:
#
# - White/warm-white PAGE_BACKGROUND (reportlab's page canvas is already
#   white by default - nothing here paints a full-page fill, which is the
#   point: a coach printing a 20-40 page report should never be laying
#   down a full black or full gold page of ink).
# - Charcoal PRIMARY_TEXT for all body copy, headings, and table text -
#   never pure black, but reads as black on ordinary paper.
# - A restrained gold/bronze ACCENT reserved for small elements only: the
#   "Peira" wordmark, thin section dividers, and table header text -
#   never a large filled panel.
# - Pale cream LIGHT_FILL / slightly deeper HEADER_FILL for the one place
#   this module fills any area at all (table header rows) - both light
#   enough to print on plain paper without noticeable ink coverage.
# - A soft muted-gold BORDER color for table grid lines and the divider
#   rule, instead of a heavier pure grey or black.
PDF_THEME = {
    "background": colors.HexColor("#FFFFFF"),
    "primary_text": colors.HexColor("#2A2416"),
    "accent": colors.HexColor("#A6822F"),
    "secondary_accent": colors.HexColor("#6E6858"),
    "light_fill": colors.HexColor("#F7F4EC"),
    "border": colors.HexColor("#D9CFA8"),
    "header_fill": colors.HexColor("#EFE8D6"),
}


def _pdf_styles() -> dict[str, ParagraphStyle]:
    """One place every ParagraphStyle used by the PDF builders below is
    defined, all themed from PDF_THEME - see that dict's docstring. Headings
    and body text use PRIMARY_TEXT (charcoal, not pure black); only the
    "Peira" wordmark and small secondary labels ("Player Answer:", "Submitted:",
    etc.) use the gold ACCENT / muted SECONDARY_ACCENT, matching the "gold
    reserved for small elements only" requirement."""
    base = getSampleStyleSheet()
    normal = ParagraphStyle("PeiraNormal", parent=base["Normal"], textColor=PDF_THEME["primary_text"])
    return {
        "title": ParagraphStyle("PeiraTitle", parent=base["Title"], textColor=PDF_THEME["primary_text"]),
        "heading2": ParagraphStyle("PeiraHeading2", parent=base["Heading2"], textColor=PDF_THEME["primary_text"]),
        "heading4": ParagraphStyle("PeiraHeading4", parent=base["Heading4"], textColor=PDF_THEME["primary_text"]),
        "normal": normal,
        "wordmark": ParagraphStyle("PeiraWordmark", parent=base["Heading2"], textColor=PDF_THEME["accent"]),
        "label": ParagraphStyle(
            "PeiraLabel", parent=normal, fontSize=9, textColor=PDF_THEME["secondary_accent"]
        ),
        "wrap": ParagraphStyle("PeiraWrap", parent=normal, fontSize=9, leading=12),
    }


def _divider() -> HRFlowable:
    """A single thin rule in the muted accent border color - the only
    "dividers" element the branding brief allows, and it costs a fraction
    of a point of ink, not a filled bar."""
    return HRFlowable(width="100%", thickness=0.75, color=PDF_THEME["border"], spaceBefore=4, spaceAfter=10)


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


def build_results_pdf(quiz, dashboard_data: dict, responses: list) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, title=f"{quiz.title} - Results")
    styles = _pdf_styles()
    elements = [
        Paragraph("Peira", styles["wordmark"]),
        Paragraph(f"{quiz.title} — Results", styles["title"]),
        Paragraph(f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", styles["normal"]),
        Spacer(1, 8),
        _divider(),
        Paragraph(
            f"{dashboard_data['response_count']} of {dashboard_data['roster_size']} players responded "
            f"({round(dashboard_data['response_rate'] * 100)}%)",
            styles["normal"],
        ),
        Spacer(1, 16),
    ]

    if dashboard_data["question_breakdown"]:
        elements.append(Paragraph("Per-question breakdown", styles["heading2"]))
        breakdown_rows = [["Question", "Correct", "Incorrect", "Ungraded"]]
        for q in dashboard_data["question_breakdown"]:
            breakdown_rows.append(
                [q["question_text"], str(q["correct_count"]), str(q["incorrect_count"]), str(q["ungraded_count"])]
            )
        elements.append(_styled_table(breakdown_rows, first_col_width=300))
        elements.append(Spacer(1, 16))

    elements.append(Paragraph("Player scores", styles["heading2"]))
    if responses:
        score_rows = [["Player", "Submitted At", "Score", "Ungraded"]]
        for response in sorted(responses, key=lambda r: r.display_name.lower()):
            graded = [a for a in response.answers if a.is_correct is not None]
            correct = sum(1 for a in graded if a.is_correct)
            ungraded = len(response.answers) - len(graded)
            score_rows.append(
                [
                    response.display_name,
                    response.submitted_at.strftime("%Y-%m-%d %H:%M"),
                    f"{correct}/{len(graded)}",
                    str(ungraded),
                ]
            )
        elements.append(_styled_table(score_rows, first_col_width=200))
    else:
        elements.append(Paragraph("No responses yet.", styles["normal"]))

    doc.build(elements)
    return buffer.getvalue()


def _styled_table(rows: list[list[str]], first_col_width: int) -> Table:
    table = Table(rows, colWidths=[first_col_width] + [None] * (len(rows[0]) - 1))
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PDF_THEME["header_fill"]),
                ("TEXTCOLOR", (0, 0), (-1, -1), PDF_THEME["primary_text"]),
                ("TEXTCOLOR", (0, 0), (-1, 0), PDF_THEME["accent"]),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.5, PDF_THEME["border"]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]
        )
    )
    return table


# Explicit widths (points) for the 9-column page-1 summary table - sums to
# under the ~468pt usable width on a US Letter page with 1in side margins,
# with Player/Position wrapped as Paragraphs so a long name/position never
# overflows its column instead of being clipped.
_SUMMARY_COL_WIDTHS = [85, 28, 48, 62, 40, 45, 55, 55, 40]


def _detailed_summary_table(rows: list[list], wrap_style: ParagraphStyle) -> Table:
    header = rows[0]
    body = [
        [
            Paragraph(str(cell), wrap_style) if i in (0, 2) else cell
            for i, cell in enumerate(row)
        ]
        for row in rows[1:]
    ]
    table = Table([header, *body], colWidths=_SUMMARY_COL_WIDTHS, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PDF_THEME["header_fill"]),
                ("TEXTCOLOR", (0, 0), (-1, -1), PDF_THEME["primary_text"]),
                ("TEXTCOLOR", (0, 0), (-1, 0), PDF_THEME["accent"]),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.5, PDF_THEME["border"]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
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
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        title=f"{quiz.title} - Detailed Results",
        topMargin=0.6 * inch,
        bottomMargin=0.6 * inch,
    )
    styles = _pdf_styles()
    wrap_style = styles["wrap"]
    label_style = styles["label"]

    questions = sorted(quiz.questions, key=lambda q: q.position)
    ordered_responses = sorted(responses, key=_player_sort_key)

    # One pass to compute every Player's counts/answers-by-question up
    # front - page 1's summary table and each Player's own detail section
    # both read from this, so the two can never disagree.
    per_response = {r.id: _player_result_counts(questions, r) for r in ordered_responses}

    elements: list = [
        Paragraph("Peira", styles["wordmark"]),
        Paragraph(organization_name, styles["normal"]),
        Paragraph(f"{quiz.title} — Detailed Results", styles["title"]),
        Paragraph(
            f"Exported {datetime.now(timezone.utc).strftime('%B %d, %Y at %I:%M %p UTC')}", styles["normal"]
        ),
        Spacer(1, 8),
        _divider(),
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
                response.submitted_at.strftime("%Y-%m-%d %H:%M"),
                str(counts[RESULT_CORRECT]),
                str(counts[RESULT_INCORRECT]),
                str(counts[RESULT_NOT_GRADED]),
                str(counts[RESULT_UNANSWERED]),
                f"{score_percent}%" if score_percent is not None else "—",
            ]
        )

    org_average = _score_percent(total_correct, total_graded)
    elements.append(
        Paragraph(
            f"Total assigned: {dashboard_data['roster_size']} &nbsp;&nbsp;&nbsp; "
            f"Total submitted: {dashboard_data['response_count']} &nbsp;&nbsp;&nbsp; "
            f"Average score: {f'{org_average}%' if org_average is not None else '—'}",
            styles["normal"],
        )
    )
    elements.append(
        Paragraph(
            f"Fully graded: {fully_graded_count} &nbsp;&nbsp;&nbsp; "
            f"Awaiting manual grading: {awaiting_grading_count}",
            styles["normal"],
        )
    )
    elements.append(Spacer(1, 16))

    if ordered_responses:
        elements.append(_detailed_summary_table(summary_rows, wrap_style))
    else:
        elements.append(
            Paragraph("No submitted Player responses are available to export yet.", styles["normal"])
        )

    for response in ordered_responses:
        elements.append(PageBreak())
        counts, answers_by_question = per_response[response.id]
        score_percent = _score_percent(counts[RESULT_CORRECT], counts[RESULT_CORRECT] + counts[RESULT_INCORRECT])
        player = response.player

        header_bits = [response.display_name]
        if player and player.position:
            header_bits.append(player.position)
        header = f"{header_bits[0]} — {header_bits[1]}" if len(header_bits) > 1 else header_bits[0]
        if player and player.jersey_number:
            header = f"#{player.jersey_number} {header}"
        elements.append(Paragraph(header, styles["heading2"]))
        elements.append(
            Paragraph(f"Submitted: {response.submitted_at.strftime('%B %d, %Y at %I:%M %p')}", label_style)
        )
        elements.append(Spacer(1, 4))
        elements.append(_divider())

        if score_percent is not None:
            elements.append(Paragraph(f"Current Score: {score_percent}% of graded questions", styles["normal"]))
        else:
            elements.append(Paragraph("Current Score: not available (nothing graded yet)", styles["normal"]))
        if counts[RESULT_NOT_GRADED] > 0:
            plural = "s" if counts[RESULT_NOT_GRADED] != 1 else ""
            elements.append(Paragraph(f"{counts[RESULT_NOT_GRADED]} response{plural} awaiting grading", label_style))
        elements.append(
            Paragraph(
                f"Correct: {counts[RESULT_CORRECT]} &nbsp;&nbsp; Incorrect: {counts[RESULT_INCORRECT]} &nbsp;&nbsp; "
                f"Not Graded: {counts[RESULT_NOT_GRADED]} &nbsp;&nbsp; Unanswered: {counts[RESULT_UNANSWERED]}",
                styles["normal"],
            )
        )
        elements.append(Spacer(1, 12))

        for i, question in enumerate(questions, start=1):
            answer = answers_by_question.get(question.id)
            result = _grading_result(answer)

            block: list = [
                Paragraph(f"Question {i}", styles["heading4"]),
                Paragraph(question.question_text, wrap_style),
            ]

            image_flowable = None
            if question.image is not None:
                image_flowable = _load_image_flowable(load_image_bytes, question.image.image_url)
            if question.image is not None and image_flowable is None:
                block.append(Spacer(1, 2))
                block.append(Paragraph("[Image unavailable]", label_style))
            elif image_flowable is not None:
                block.append(Spacer(1, 4))
                block.append(image_flowable)

            block.append(Spacer(1, 4))
            block.append(Paragraph("Player Answer:", label_style))
            block.append(Paragraph(_answer_text(question, answer) or "No answer submitted.", wrap_style))

            if question.question_type.value != "written":
                correct_option = next((o for o in question.options if o.is_correct_answer), None)
                if correct_option is not None:
                    block.append(Paragraph("Correct Answer:", label_style))
                    block.append(Paragraph(correct_option.option_text, wrap_style))

            if answer is not None and answer.coach_feedback:
                block.append(Paragraph("Coach Feedback:", label_style))
                block.append(Paragraph(answer.coach_feedback, wrap_style))

            block.append(Paragraph(f"Result: {result}", styles["normal"]))
            block.append(Spacer(1, 10))

            elements.append(KeepTogether(block))

    doc.build(elements)
    return buffer.getvalue()
