"""Builds a coach-facing results export for a quiz, as CSV or PDF.

Expects `responses` to already be loaded with `answers` (and
`answers.selected_option`) eagerly - these functions don't query the
database themselves, to keep them easy to test and to let route handlers
control exactly what's eager-loaded.
"""

import csv
import io
import re
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

CSV_HEADER = ["Player", "Submitted At", "Question #", "Question", "Type", "Answer", "Correct", "Coach Feedback"]

_CORRECT_LABELS = {True: "Yes", False: "No", None: "Ungraded"}


def export_filename_slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "quiz"


def _answer_text(question, answer) -> str:
    if answer is None:
        return ""
    if question.question_type.value == "written":
        return answer.answer_text or ""
    return answer.selected_option.option_text if answer.selected_option else ""


def build_results_csv(quiz, responses: list) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_HEADER)

    questions = sorted(quiz.questions, key=lambda q: q.position)
    for response in sorted(responses, key=lambda r: r.player_name.lower()):
        answers_by_question = {a.question_id: a for a in response.answers}
        for i, question in enumerate(questions, start=1):
            answer = answers_by_question.get(question.id)
            writer.writerow(
                [
                    response.player_name,
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
    styles = getSampleStyleSheet()
    elements = [
        Paragraph(f"{quiz.title} — Results", styles["Title"]),
        Paragraph(f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", styles["Normal"]),
        Spacer(1, 12),
        Paragraph(
            f"{dashboard_data['response_count']} of {dashboard_data['roster_size']} players responded "
            f"({round(dashboard_data['response_rate'] * 100)}%)",
            styles["Normal"],
        ),
        Spacer(1, 16),
    ]

    if dashboard_data["question_breakdown"]:
        elements.append(Paragraph("Per-question breakdown", styles["Heading2"]))
        breakdown_rows = [["Question", "Correct", "Incorrect", "Ungraded"]]
        for q in dashboard_data["question_breakdown"]:
            breakdown_rows.append(
                [q["question_text"], str(q["correct_count"]), str(q["incorrect_count"]), str(q["ungraded_count"])]
            )
        elements.append(_styled_table(breakdown_rows, first_col_width=300))
        elements.append(Spacer(1, 16))

    elements.append(Paragraph("Player scores", styles["Heading2"]))
    if responses:
        score_rows = [["Player", "Submitted At", "Score", "Ungraded"]]
        for response in sorted(responses, key=lambda r: r.player_name.lower()):
            graded = [a for a in response.answers if a.is_correct is not None]
            correct = sum(1 for a in graded if a.is_correct)
            ungraded = len(response.answers) - len(graded)
            score_rows.append(
                [
                    response.player_name,
                    response.submitted_at.strftime("%Y-%m-%d %H:%M"),
                    f"{correct}/{len(graded)}",
                    str(ungraded),
                ]
            )
        elements.append(_styled_table(score_rows, first_col_width=200))
    else:
        elements.append(Paragraph("No responses yet.", styles["Normal"]))

    doc.build(elements)
    return buffer.getvalue()


def _styled_table(rows: list[list[str]], first_col_width: int) -> Table:
    table = Table(rows, colWidths=[first_col_width] + [None] * (len(rows[0]) - 1))
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]
        )
    )
    return table
