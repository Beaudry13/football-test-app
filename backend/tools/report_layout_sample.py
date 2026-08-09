"""Renders sample cumulative-performance PDFs and reports their density.

Dev tooling, not shipped behaviour: it builds the PDF straight from synthetic
history payloads (the same shape routes/players.build_player_history returns)
so the layout can be checked without a database, then measures pages and
scans the extracted text for clipping.

    python tools/report_layout_sample.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.export import build_cumulative_performance_pdf  # noqa: E402

QUIZ_NAMES = [
    "Install 1",
    "Cover 3",
    "Red Zone",
    "Third Down",
    "Two Minute",
    "Goal Line",
]

LONG_NAME = (
    "Bartholomew Fitzwilliam-Montgomery III",
    "Vandersteenhoven-Aleksandrovich",
)
LONG_QUIZ = (
    "Week 12 Opponent Preparation - Third Down and Long Situational Install "
    "with Red Zone Carryover"
)


def history(first, last, jersey, quiz_count, pending=0, overall=84.0):
    results = []
    for index in range(quiz_count):
        results.append(
            {
                "quiz_id": index + 1,
                "quiz_title": QUIZ_NAMES[index % len(QUIZ_NAMES)],
                "attempt_id": index + 1,
                "submitted_at": f"2026-08-{(index % 27) + 1:02d}T15:00:00+00:00",
                "score_percent": 70.0 + (index % 4) * 8,
                "graded_answer_count": 10,
                "correct_answer_count": 8,
                "pending_grading_count": 1 if (pending and index == 0) else 0,
            }
        )
    return {
        "player": {
            "first_name": first,
            "last_name": last,
            "jersey_number": jersey,
        },
        "completed_count": quiz_count,
        "average_score_percent": overall if quiz_count else None,
        "total_correct_count": quiz_count * 8,
        "total_incorrect_count": quiz_count * 2,
        "total_graded_count": quiz_count * 10,
        "total_pending_grading_count": pending,
        "recent_results": results,
    }


def measure(name: str, histories: list[dict]) -> None:
    pdf = build_cumulative_performance_pdf(histories)
    out = Path(f"/tmp/{name}.pdf")
    out.write_bytes(pdf)

    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(out))
    pages = len(doc)
    text = "".join(doc[i].get_textpage().get_text_range() for i in range(pages))

    print(f"\n=== {name} ===")
    print(f"players={len(histories)} pages={pages} bytes={len(pdf)}")
    if histories:
        print(f"players per page ~ {len(histories) / pages:.1f}")

    # Clipping check: every player's surname must survive into the text
    # layer. A name pushed outside its frame simply would not be there.
    missing = [
        h["player"]["last_name"]
        for h in histories
        if h["player"]["last_name"].split("-")[0] not in text
    ]
    print("all player names present:", not missing, missing or "")


if __name__ == "__main__":
    measure("sample_20", [history(f"Player{i}", f"Lastname{i}", str(i + 1), 6) for i in range(20)])
    measure("sample_3", [history("John", "Smith", "12", 14, pending=3), history("Mike", "Jones", "5", 10), history("Empty", "Zero", "", 0, overall=None)])
    measure(
        "sample_long",
        [
            {
                **history(LONG_NAME[0], LONG_NAME[1], "88", 3),
                "recent_results": [
                    {
                        "quiz_id": 1,
                        "quiz_title": LONG_QUIZ,
                        "attempt_id": 1,
                        "submitted_at": "2026-08-02T15:00:00+00:00",
                        "score_percent": 92.0,
                        "graded_answer_count": 10,
                        "correct_answer_count": 9,
                        "pending_grading_count": 2,
                    }
                ],
            },
            history("Al", "Bo", "1", 2),
        ],
    )
    # A single player with more history than fits on one page: proves the
    # block splits rather than looping, and that the header repeats.
    measure("sample_tall", [history("Marathon", "Player", "99", 60)])
