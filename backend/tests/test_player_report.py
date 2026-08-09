"""Cumulative performance PDF for selected players.

The two things worth guarding here are the ones a reader cannot check by
looking at the PDF: that it never counts another coach's quizzes, and that
it never turns an ungraded answer into a wrong one.
"""

import io
from datetime import datetime, timezone

import pytest

from app.extensions import db
from app.models import Answer, AttemptStatus, PlayerAttempt
from app.routes.players import build_player_history
from app.services.export import build_cumulative_performance_pdf


def make_quiz(client, headers, title="Install 1"):
    response = client.post("/api/quizzes", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_question(client, headers, quiz_id, text="Name the coverage", qtype="written"):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": text, "question_type": qtype, "options": []},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def make_player(client, headers, first="Sam", last="Reed"):
    response = client.post(
        "/api/players", json={"first_name": first, "last_name": last}, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["id"]


def activate(client, headers, quiz_id, group_ids=None):
    response = client.post(
        f"/api/quizzes/{quiz_id}/access-codes",
        json={"group_ids": group_ids or []},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def set_quiz_roster(client, headers, quiz_id, names=("Sam Reed",)):
    response = client.put(
        f"/api/quizzes/{quiz_id}/roster", json={"players": list(names)}, headers=headers
    )
    assert response.status_code in (200, 201), response.get_json()


def record_attempt(app, quiz_id, code_id, player_id, name, marks):
    """A submitted attempt whose answers are graded per `marks`.

    `marks` is a list of True (correct) / False (incorrect) / None (answered
    but still awaiting a coach's grade), one per question.
    """
    from app.models import Question

    with app.app_context():
        attempt = PlayerAttempt(
            quiz_id=quiz_id,
            access_code_id=code_id,
            player_id=player_id,
            player_name=name,
            status=AttemptStatus.SUBMITTED,
            submitted_at=datetime.now(timezone.utc),
        )
        db.session.add(attempt)
        db.session.flush()

        questions = Question.query.filter_by(quiz_id=quiz_id).order_by(Question.id).all()
        for question, mark in zip(questions, marks):
            db.session.add(
                Answer(
                    attempt_id=attempt.id,
                    question_id=question.id,
                    answer_text="an answer",
                    is_correct=mark,
                )
            )
        db.session.commit()


def report(client, headers, ids):
    return client.get(
        "/api/players/report.pdf?ids=" + ",".join(str(i) for i in ids), headers=headers
    )


class TestReportBasics:
    def test_one_selected_player(self, client, coach_headers):
        player_id = make_player(client, coach_headers)

        response = report(client, coach_headers, [player_id])

        assert response.status_code == 200
        assert response.mimetype == "application/pdf"
        assert response.data.startswith(b"%PDF")
        assert "attachment" in response.headers["Content-Disposition"]
        assert "performance-report-" in response.headers["Content-Disposition"]

    def test_several_selected_players(self, client, coach_headers):
        ids = [
            make_player(client, coach_headers, "Sam", "Reed"),
            make_player(client, coach_headers, "Dre", "Vance"),
            make_player(client, coach_headers, "Marcus", "Hill"),
        ]

        response = report(client, coach_headers, ids)

        assert response.status_code == 200
        assert response.data.startswith(b"%PDF")

    def test_a_player_with_no_attempts_still_produces_a_report(self, client, coach_headers):
        # An empty section is the honest answer. Failing, or omitting them,
        # would make a coach think they mis-selected.
        player_id = make_player(client, coach_headers)

        response = report(client, coach_headers, [player_id])

        assert response.status_code == 200
        assert response.data.startswith(b"%PDF")

    def test_a_player_with_several_quizzes(self, app, client, coach_headers):
        player_id = make_player(client, coach_headers)
        for index in range(3):
            quiz_id = make_quiz(client, coach_headers, f"Install {index + 1}")
            make_question(client, coach_headers, quiz_id)
            set_quiz_roster(client, coach_headers, quiz_id)
            code = activate(client, coach_headers, quiz_id)
            record_attempt(app, quiz_id, code["id"], player_id, "Sam Reed", [index % 2 == 0])

        response = report(client, coach_headers, [player_id])
        assert response.status_code == 200

        history = None
        with app.app_context():
            from app.models import Coach, Player

            coach = Coach.query.filter_by(username="coach1").first()
            history = build_player_history(
                coach, db.session.get(Player, player_id), organization_wide=False, result_limit=None
            )
        assert history["completed_count"] == 3
        # Every quiz is in the report, not just the most recent page of them.
        assert len(history["recent_results"]) == 3

    def test_deduplicates_a_repeated_id(self, client, coach_headers):
        player_id = make_player(client, coach_headers)

        response = report(client, coach_headers, [player_id, player_id])

        assert response.status_code == 200


class TestSelectionValidation:
    def test_no_ids_is_rejected(self, client, coach_headers):
        assert client.get("/api/players/report.pdf", headers=coach_headers).status_code == 400
        assert client.get("/api/players/report.pdf?ids=", headers=coach_headers).status_code == 400

    def test_non_numeric_ids_are_rejected(self, client, coach_headers):
        response = client.get("/api/players/report.pdf?ids=1,abc", headers=coach_headers)
        assert response.status_code == 400

    def test_requires_authentication(self, client):
        assert client.get("/api/players/report.pdf?ids=1").status_code == 401


class TestScoping:
    def test_never_includes_another_coachs_quiz(
        self, app, client, coach_headers, invite_teammate
    ):
        # THE security rule. A coach reading this report must not learn the
        # titles or scores of a teammate's quizzes - the same leak Coach View
        # was closed against.
        _, _, teammate_headers = invite_teammate(coach_headers)
        player_id = make_player(client, coach_headers)

        quiz_id = make_quiz(client, teammate_headers, "TEAMMATE SECRET INSTALL")
        make_question(client, teammate_headers, quiz_id)
        set_quiz_roster(client, teammate_headers, quiz_id)
        code = activate(client, teammate_headers, quiz_id)
        record_attempt(app, quiz_id, code["id"], player_id, "Sam Reed", [True])

        response = report(client, coach_headers, [player_id])
        assert response.status_code == 200

        with app.app_context():
            from app.models import Coach, Player

            coach = Coach.query.filter_by(username="coach1").first()
            history = build_player_history(
                coach, db.session.get(Player, player_id), organization_wide=False, result_limit=None
            )
        # The attempt exists and belongs to this player, but not to a quiz
        # this coach owns, so it contributes nothing.
        assert history["completed_count"] == 0
        assert history["recent_results"] == []
        assert history["average_score_percent"] is None

    def test_a_player_from_another_organization_is_not_found(
        self, client, coach_headers, register_coach
    ):
        _, _, other_headers = register_coach(
            username="other", email="other@example.com", organization="Rivals"
        )
        outsider_id = make_player(client, other_headers, "Not", "Yours")

        response = report(client, coach_headers, [outsider_id])

        # 404, never 403: a distinct forbidden would confirm the id exists.
        assert response.status_code == 404

    def test_a_partial_selection_fails_rather_than_quietly_omitting(
        self, client, coach_headers, register_coach
    ):
        mine = make_player(client, coach_headers)
        _, _, other_headers = register_coach(
            username="other2", email="other2@example.com", organization="Rivals2"
        )
        theirs = make_player(client, other_headers, "Not", "Yours")

        response = report(client, coach_headers, [mine, theirs])

        # Silently dropping one would hand back a report missing a player the
        # coach believes they selected.
        assert response.status_code == 404


class TestGradingHonesty:
    def test_ungraded_answers_are_reported_not_counted_wrong(self, app, client, coach_headers):
        # The rule that matters most for a player: an answer their coach has
        # not read yet is not a wrong answer.
        player_id = make_player(client, coach_headers)
        quiz_id = make_quiz(client, coach_headers)
        make_question(client, coach_headers, quiz_id, "Q1")
        make_question(client, coach_headers, quiz_id, "Q2")
        make_question(client, coach_headers, quiz_id, "Q3")
        set_quiz_roster(client, coach_headers, quiz_id)
        code = activate(client, coach_headers, quiz_id)
        # One right, one wrong, one still awaiting grading.
        record_attempt(app, quiz_id, code["id"], player_id, "Sam Reed", [True, False, None])

        with app.app_context():
            from app.models import Coach, Player

            coach = Coach.query.filter_by(username="coach1").first()
            history = build_player_history(
                coach, db.session.get(Player, player_id), organization_wide=False, result_limit=None
            )

        assert history["total_correct_count"] == 1
        assert history["total_incorrect_count"] == 1
        assert history["total_graded_count"] == 2
        assert history["total_pending_grading_count"] == 1
        # 1 of 2 graded, NOT 1 of 3 - the ungraded answer is absent from the
        # denominator rather than scored as a miss.
        assert history["average_score_percent"] == 50.0

        assert report(client, coach_headers, [player_id]).status_code == 200

    def test_nothing_graded_yet_scores_nothing_rather_than_zero(
        self, app, client, coach_headers
    ):
        player_id = make_player(client, coach_headers)
        quiz_id = make_quiz(client, coach_headers)
        make_question(client, coach_headers, quiz_id)
        set_quiz_roster(client, coach_headers, quiz_id)
        code = activate(client, coach_headers, quiz_id)
        record_attempt(app, quiz_id, code["id"], player_id, "Sam Reed", [None])

        with app.app_context():
            from app.models import Coach, Player

            coach = Coach.query.filter_by(username="coach1").first()
            history = build_player_history(
                coach, db.session.get(Player, player_id), organization_wide=False, result_limit=None
            )

        # Fabricating 0% here would tell a coach their player failed a quiz
        # nobody has marked.
        assert history["average_score_percent"] is None
        assert history["total_pending_grading_count"] == 1
        assert report(client, coach_headers, [player_id]).status_code == 200


class TestSharedCalculation:
    def test_the_report_reads_the_same_numbers_as_the_player_profile(
        self, app, client, coach_headers
    ):
        # There must be exactly one cumulative calculation. This pins the
        # report's source to the endpoint the profile page already uses.
        player_id = make_player(client, coach_headers)
        quiz_id = make_quiz(client, coach_headers)
        make_question(client, coach_headers, quiz_id, "Q1")
        make_question(client, coach_headers, quiz_id, "Q2")
        set_quiz_roster(client, coach_headers, quiz_id)
        code = activate(client, coach_headers, quiz_id)
        record_attempt(app, quiz_id, code["id"], player_id, "Sam Reed", [True, False])

        profile = client.get(f"/api/players/{player_id}/history", headers=coach_headers).get_json()

        with app.app_context():
            from app.models import Coach, Player

            coach = Coach.query.filter_by(username="coach1").first()
            report_history = build_player_history(
                coach, db.session.get(Player, player_id), organization_wide=False, result_limit=None
            )

        assert report_history["average_score_percent"] == profile["average_score_percent"]
        assert report_history["completed_count"] == profile["completed_count"]

    def test_the_default_history_limit_is_unchanged(self, app, client, coach_headers):
        # The PDF needed an uncapped list; the existing endpoints must keep
        # returning exactly what they always did.
        import inspect

        signature = inspect.signature(build_player_history)
        assert signature.parameters["result_limit"].default == 20


@pytest.mark.parametrize("count", [1, 2])
def test_report_renders_for_any_selection_size(client, coach_headers, count):
    ids = [make_player(client, coach_headers, f"P{i}", f"Last{i}") for i in range(count)]

    response = report(client, coach_headers, ids)

    assert response.status_code == 200
    assert response.data.startswith(b"%PDF")


# --- layout: a coach's packet, not one page per player --------------------


def synthetic_history(first, last, jersey, quiz_count, pending=0):
    """A history payload shaped exactly like build_player_history's, so the
    layout can be exercised without a database behind it."""
    results = [
        {
            "quiz_id": i + 1,
            "quiz_title": f"Install {i + 1}",
            "attempt_id": i + 1,
            "submitted_at": f"2026-08-{(i % 27) + 1:02d}T15:00:00+00:00",
            "score_percent": 80.0,
            "graded_answer_count": 10,
            "correct_answer_count": 8,
            "pending_grading_count": 1 if (pending and i == 0) else 0,
        }
        for i in range(quiz_count)
    ]
    return {
        "player": {"first_name": first, "last_name": last, "jersey_number": jersey},
        "completed_count": quiz_count,
        "average_score_percent": 80.0 if quiz_count else None,
        "total_correct_count": quiz_count * 8,
        "total_incorrect_count": quiz_count * 2,
        "total_graded_count": quiz_count * 10,
        "total_pending_grading_count": pending,
        "recent_results": results,
    }


def pdf_pages_text(pdf_bytes):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    return [doc[i].get_textpage().get_text_range() for i in range(len(doc))]


def squad(size=20, quizzes=6):
    return [synthetic_history(f"P{i}", f"Last{i}", str(i + 1), quizzes) for i in range(size)]


class TestPacketDensity:
    def test_many_players_share_pages(self):
        # THE point of the redesign. One page per player turned a squad into
        # a twenty-page document nobody flips through.
        pages = pdf_pages_text(build_cumulative_performance_pdf(squad()))

        assert len(pages) < 20
        assert len(pages) <= 7, f"20 players should not need {len(pages)} pages"

    def test_short_players_fit_on_one_page(self):
        histories = [synthetic_history(f"P{i}", f"Last{i}", str(i + 1), 3) for i in range(3)]

        assert len(pdf_pages_text(build_cumulative_performance_pdf(histories))) == 1

    def test_no_player_section_is_orphaned_across_a_page_break(self):
        # A heading and stats line stranded at the foot of a page with the
        # table overleaf is exactly what KeepTogether exists to prevent.
        pages = pdf_pages_text(build_cumulative_performance_pdf(squad()))

        for page in pages[1:]:
            body = [
                line
                for line in page.strip().splitlines()
                if line.strip() and not line.startswith("Cumulative Performance Report")
            ]
            assert body[0].startswith("#"), f"page opens mid-section: {body[0]!r}"

    def test_a_player_taller_than_a_page_still_uses_the_current_page(self):
        # KeepTogether cannot help a block bigger than a page; applying it
        # anyway pushed the block forward and left the page before it blank.
        pages = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("Marathon", "Player", "99", 60)])
        )

        assert "Install 1" in pages[0], "the first page should carry rows, not sit empty"

    def test_a_split_table_repeats_its_header(self):
        pages = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("Marathon", "Player", "99", 60)])
        )

        assert "Quiz" in pages[1] and "Score" in pages[1]


class TestPacketChrome:
    def test_the_report_title_appears_once_on_later_pages(self):
        # Page one carries the masthead AND the footer; later pages carry
        # only the footer, so the phrase count drops to one.
        pages = pdf_pages_text(build_cumulative_performance_pdf(squad()))

        assert pages[0].count("Cumulative Performance Report") >= 2
        for page in pages[1:]:
            assert page.count("Cumulative Performance Report") == 1

    def test_every_page_is_numbered(self):
        pages = pdf_pages_text(build_cumulative_performance_pdf(squad()))

        for index, page in enumerate(pages):
            assert f"Page {index + 1}" in page


class TestPacketReadability:
    def test_scores_lose_their_pointless_decimal(self):
        pages = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("A", "B", "1", 1)])
        )

        assert "80%" in pages[0]
        assert "80.0%" not in pages[0]

    def test_the_awaiting_column_is_dropped_when_nothing_is_awaiting(self):
        # A column of zeros is width spent on nothing.
        clean = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("A", "B", "1", 3)])
        )
        assert "Awaiting" not in clean[0]

        pending = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("A", "B", "1", 3, pending=1)])
        )
        assert "Awaiting" in pending[0]

    def test_a_long_player_name_and_quiz_title_survive_intact(self):
        history = synthetic_history(
            "Bartholomew Fitzwilliam-Montgomery", "Vandersteenhoven-Aleksandrovich", "88", 1
        )
        history["recent_results"][0]["quiz_title"] = (
            "Week 12 Opponent Preparation - Third Down and Long Situational Install "
            "with Red Zone Carryover"
        )

        pages = pdf_pages_text(build_cumulative_performance_pdf([history]))

        # Nothing clipped: text pushed outside its frame would be absent from
        # the text layer entirely.
        assert "Bartholomew" in pages[0]
        assert "Vandersteenhoven" in pages[0]
        assert "Red Zone Carryover" in pages[0]

    def test_a_player_with_no_attempts_says_so(self):
        pages = pdf_pages_text(
            build_cumulative_performance_pdf([synthetic_history("Empty", "Zero", "", 0)])
        )

        assert "No completed quizzes yet." in pages[0]
        assert "Overall: -" in pages[0]
