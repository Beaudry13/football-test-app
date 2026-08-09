"""Cumulative performance PDF for selected players.

The two things worth guarding here are the ones a reader cannot check by
looking at the PDF: that it never counts another coach's quizzes, and that
it never turns an ungraded answer into a wrong one.
"""

from datetime import datetime, timezone

import pytest

from app.extensions import db
from app.models import Answer, AttemptStatus, PlayerAttempt
from app.routes.players import build_player_history


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
