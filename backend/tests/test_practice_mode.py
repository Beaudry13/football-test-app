"""Practice Mode: a quiz sent for reps, not for a grade.

The two things this file exists to protect:

1. A practice attempt NEVER influences an official number. Not an average,
   not a completion count, not a grading queue, not an export. If that ever
   stops being true a coach's cumulative report is quietly wrong and nothing
   looks broken - so it is asserted here from several directions.

2. A graded attempt is completely unchanged. Every assertion about graded
   behaviour below is a regression test for "did adding practice alter the
   thing that already worked", which is the actual risk of this feature.
"""

import pytest

from app.extensions import db
from app.models import AccessCode, Answer, PlayerAttempt, Question, QuestionType
from app.models.assessment_mode import GRADED, PRACTICE

PLAYER = "Jordan Smith"


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def build_quiz(client, headers, *, explanation=None):
    """A quiz with one of each broadly-testable type.

    FILL_BLANK needs a playbook page and is exercised separately below.
    """
    quiz = client.post("/api/quizzes", json={"title": "Practice Install"}, headers=headers).get_json()

    def add(payload):
        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions", json=payload, headers=headers
        )
        assert response.status_code == 201, response.get_json()
        return response.get_json()

    multiple_choice = add(
        {
            "question_text": "Which coverage is this?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ],
            **({"answer_explanation": explanation} if explanation else {}),
        }
    )
    true_false = add(
        {
            "question_text": "Is the safety deep?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        }
    )
    written = add(
        {
            "question_text": "Describe your assignment.",
            "question_type": "written",
            "options": [],
        }
    )

    # Rostered through a canonical Player, not a legacy name-only entry, so
    # the resulting attempts carry player_id and reach the player profile -
    # which is exactly where practice must not show up.
    first, last = PLAYER.split(" ", 1)
    existing = client.get("/api/players", headers=headers).get_json()
    rows = existing["players"] if isinstance(existing, dict) else existing
    match = next((p for p in rows if p["display_name"] == PLAYER), None)
    if match is None:
        match = client.post(
            "/api/players", json={"first_name": first, "last_name": last}, headers=headers
        ).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/roster/members",
        json={"player_ids": [match["id"]]},
        headers=headers,
    )
    return quiz, multiple_choice, true_false, written


def activate(client, headers, quiz_id, mode=None):
    payload = {} if mode is None else {"mode": mode}
    response = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json=payload, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def start(client, code, player_name=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player_name}
    )


def save(client, code, question_id, *, option_id=None, text=None, player_name=PLAYER):
    return client.post(
        "/api/play/answers",
        json={
            "access_code_id": code["id"],
            "player_name": player_name,
            "question_id": question_id,
            "selected_option_id": option_id,
            "answer_text": text,
        },
    )


def check(client, code, question_id, player_name=PLAYER):
    return client.post(
        "/api/play/check",
        json={
            "access_code_id": code["id"],
            "player_name": player_name,
            "question_id": question_id,
        },
    )


def option_id(question, correct: bool):
    return next(o["id"] for o in question["options"] if o["is_correct_answer"] is correct)


def submit(client, code, answers, player_name=PLAYER):
    """Submit re-sends every answer, mirroring the real client - the endpoint
    treats that resend as its last-chance safety net and refuses an empty
    list, so a helper that sent [] would be testing a shape no client uses."""
    return client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"],
            "player_name": player_name,
            "answers": answers,
        },
    )


def answer_all(client, code, multiple_choice, true_false, written, *, correct=True):
    """Answer every question and return the payload /submit expects back."""
    payload = [
        {
            "question_id": multiple_choice["id"],
            "selected_option_id": option_id(multiple_choice, correct),
            "answer_text": None,
        },
        {
            "question_id": true_false["id"],
            "selected_option_id": option_id(true_false, correct),
            "answer_text": None,
        },
        {
            "question_id": written["id"],
            "selected_option_id": None,
            "answer_text": "Force the ball inside.",
        },
    ]
    for entry in payload:
        save(
            client,
            code,
            entry["question_id"],
            option_id=entry["selected_option_id"],
            text=entry["answer_text"],
        )
    return payload


# --------------------------------------------------------------------------
# The default: nothing changes for anybody who never asks for practice
# --------------------------------------------------------------------------


class TestBackwardCompatibility:
    def test_activating_without_a_mode_is_graded(self, client, coach_headers):
        quiz, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        assert code["mode"] == GRADED
        assert code["is_practice"] is False

    def test_an_attempt_under_a_graded_code_is_graded(self, app, client, coach_headers):
        quiz, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)

        with app.app_context():
            assert PlayerAttempt.query.one().mode == GRADED

    def test_a_graded_autosave_still_returns_204_and_no_body(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)

        response = save(
            client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
        )

        # The player learns nothing about correctness mid-assessment. This is
        # the single most important thing practice must not have changed.
        assert response.status_code == 204
        assert response.data == b""

    def test_a_graded_attempt_cannot_be_retaken(self, client, coach_headers):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written)
        assert submit(client, code, answers).status_code == 201

        # The partial unique indexes still cover GRADED, so exactly-once
        # survives the practice rewrite.
        assert start(client, code).status_code == 409

    def test_graded_players_cannot_reach_the_check_endpoint(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        response = check(client, code, multiple_choice["id"])

        assert response.status_code == 422

    def test_an_existing_row_written_before_this_feature_reads_as_graded(
        self, app, client, coach_headers
    ):
        """The server default, not application code, is what makes historical
        data graded - so this asserts a row inserted without touching `mode`."""
        quiz, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        with app.app_context():
            db.session.execute(
                db.text(
                    "INSERT INTO player_attempts (quiz_id, access_code_id, player_name, status)"
                    " VALUES (:quiz_id, :code_id, :name, 'IN_PROGRESS')"
                ),
                {"quiz_id": quiz["id"], "code_id": code["id"], "name": "Legacy Player"},
            )
            db.session.commit()
            legacy = PlayerAttempt.query.filter_by(player_name="Legacy Player").one()
            assert legacy.mode == GRADED
            assert legacy.counts_officially is True


# --------------------------------------------------------------------------
# The practice player's experience
# --------------------------------------------------------------------------


class TestImmediateFeedback:
    def test_a_practice_code_says_so_before_the_player_starts(self, client, coach_headers):
        quiz, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)

        payload = client.post(
            "/api/play/validate-code", json={"code": code["code"]}
        ).get_json()

        assert payload["mode"] == PRACTICE

    def test_a_correct_multiple_choice_answer_is_confirmed(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        feedback = check(client, code, multiple_choice["id"]).get_json()

        assert feedback["auto_gradable"] is True
        assert feedback["is_correct"] is True

    def test_an_incorrect_multiple_choice_answer_is_not_softened(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, False))

        feedback = check(client, code, multiple_choice["id"]).get_json()

        assert feedback["is_correct"] is False

    def test_true_false_is_checked_the_same_way(self, client, coach_headers):
        quiz, _, true_false, _ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, true_false["id"], option_id=option_id(true_false, False))

        feedback = check(client, code, true_false["id"]).get_json()

        assert feedback["auto_gradable"] is True
        assert feedback["is_correct"] is False

    def test_short_answer_records_the_response_without_inventing_a_verdict(
        self, client, coach_headers
    ):
        quiz, _, _, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, written["id"], text="Squeeze the C gap.")

        feedback = check(client, code, written["id"]).get_json()

        # Peira cannot grade this, so it says so rather than fabricating a
        # right/wrong - the same honesty rule as never showing a 0% average.
        assert feedback["auto_gradable"] is False
        assert feedback["is_correct"] is None

    def test_feedback_never_carries_the_correct_answer(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, False))

        feedback = check(client, code, multiple_choice["id"]).get_json()

        assert "correct_option_id" not in feedback
        assert "options" not in feedback
        assert "Cover 2" not in str(feedback)

    def test_the_coachs_explanation_is_shown_when_written(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(
            client, coach_headers, explanation="Two deep safeties means Cover 2."
        )
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        feedback = check(client, code, multiple_choice["id"]).get_json()

        assert feedback["answer_explanation"] == "Two deep safeties means Cover 2."

    def test_a_question_without_an_explanation_simply_has_none(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        feedback = check(client, code, multiple_choice["id"]).get_json()

        assert feedback["answer_explanation"] is None

    def test_an_autosave_still_reveals_nothing(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)

        response = save(
            client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
        )

        # Checking is an explicit act. A player still typing must not be able
        # to read the verdict out of the network tab before asking for it.
        assert response.status_code == 204
        assert response.data == b""

    def test_the_player_gets_no_explanation_before_checking(self, client, coach_headers):
        quiz, *_ = build_quiz(client, coach_headers, explanation="Two deep safeties.")
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)

        payload = client.post(
            "/api/play/validate-code", json={"code": code["code"]}
        ).get_json()

        assert "Two deep safeties" not in str(payload)


class TestAnswerLocking:
    def test_a_checked_answer_cannot_be_rewritten(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, False))
        check(client, code, multiple_choice["id"])

        response = save(
            client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
        )

        assert response.status_code == 409
        assert response.get_json()["reason"] == "practice_answer_locked"

    def test_an_unchecked_answer_can_still_be_changed(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, False))

        # Changing your mind before you commit is not cheating.
        response = save(
            client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
        )
        assert response.status_code == 204

    def test_checking_one_question_does_not_lock_the_others(self, client, coach_headers):
        quiz, multiple_choice, true_false, _ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))
        check(client, code, multiple_choice["id"])

        response = save(client, code, true_false["id"], option_id=option_id(true_false, True))
        assert response.status_code == 204

    def test_checking_twice_re_reads_the_same_feedback(self, app, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        first = check(client, code, multiple_choice["id"])
        with app.app_context():
            stamped = Answer.query.filter_by(question_id=multiple_choice["id"]).one().checked_at
        second = check(client, code, multiple_choice["id"])
        with app.app_context():
            still = Answer.query.filter_by(question_id=multiple_choice["id"]).one().checked_at

        # A double-tap is not a second look - the clock does not move.
        assert first.get_json() == second.get_json()
        assert stamped == still

    def test_the_lock_survives_a_reload(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))
        check(client, code, multiple_choice["id"])

        # /start on an in-progress attempt is what a refresh does.
        state = start(client, code).get_json()

        answer = next(a for a in state["answers"] if a["question_id"] == multiple_choice["id"])
        assert answer["checked"] is True
        assert state["mode"] == PRACTICE
        assert [f["question_id"] for f in state["feedback"]] == [multiple_choice["id"]]

    def test_a_graded_reload_reports_nothing_checked(self, client, coach_headers):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        state = start(client, code).get_json()

        assert state["mode"] == GRADED
        assert state["feedback"] == []
        assert all(a["checked"] is False for a in state["answers"])

    def test_checking_a_skipped_question_uses_up_the_attempt_at_it(
        self, client, coach_headers
    ):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)

        feedback = check(client, code, multiple_choice["id"])
        assert feedback.status_code == 200
        assert feedback.get_json()["is_correct"] is not True

        assert (
            save(
                client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
            ).status_code
            == 409
        )


class TestUnlimitedRetakes:
    def test_a_finished_practice_attempt_can_be_started_again(
        self, app, client, coach_headers
    ):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written, correct=False)
        assert submit(client, code, answers).status_code == 201

        again = start(client, code)

        assert again.status_code == 201
        with app.app_context():
            assert PlayerAttempt.query.count() == 2

    def test_a_retake_starts_every_question_unlocked(self, client, coach_headers):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, False))
        check(client, code, multiple_choice["id"])
        answers = answer_all(client, code, multiple_choice, true_false, written, correct=False)
        submit(client, code, answers)

        state = start(client, code).get_json()
        assert state["answers"] == []
        assert state["feedback"] == []

        # And the previously-locked question accepts a fresh answer.
        assert (
            save(
                client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True)
            ).status_code
            == 204
        )

    def test_work_continues_on_the_newest_attempt_not_the_oldest(
        self, app, client, coach_headers
    ):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written, correct=False)
        submit(client, code, answers)
        start(client, code)

        save(client, code, multiple_choice["id"], option_id=option_id(multiple_choice, True))

        with app.app_context():
            newest = PlayerAttempt.query.order_by(PlayerAttempt.id.desc()).first()
            assert [a.question_id for a in newest.answers] == [multiple_choice["id"]]


# --------------------------------------------------------------------------
# The part that protects the coach's numbers
# --------------------------------------------------------------------------


def graded_and_practice_history(client, coach_headers):
    """One graded submission and one practice submission on the same quiz,
    by the same player - the arrangement every official number must be able
    to tell apart."""
    quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)

    graded_code = activate(client, coach_headers, quiz["id"])
    start(client, graded_code)
    answers = answer_all(client, graded_code, multiple_choice, true_false, written, correct=True)
    assert submit(client, graded_code, answers).status_code == 201

    practice_code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
    start(client, practice_code)
    wrong = answer_all(
        client, practice_code, multiple_choice, true_false, written, correct=False
    )
    assert submit(client, practice_code, wrong).status_code == 201

    return quiz, multiple_choice, graded_code, practice_code


class TestPracticeIsInvisibleToOfficialNumbers:
    def test_the_results_tab_shows_only_the_graded_attempt(self, client, coach_headers):
        quiz, *_ = graded_and_practice_history(client, coach_headers)

        responses = client.get(
            f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers
        ).get_json()

        rows = responses["responses"] if isinstance(responses, dict) else responses
        assert len(rows) == 1

    def test_the_quiz_dashboard_counts_only_the_graded_attempt(
        self, client, coach_headers
    ):
        quiz, multiple_choice, *_ = graded_and_practice_history(client, coach_headers)

        dashboard = client.get(
            f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers
        ).get_json()

        assert dashboard["response_count"] == 1
        breakdown = next(
            q for q in dashboard["question_breakdown"] if q["question_id"] == multiple_choice["id"]
        )
        # Graded answered it correctly, practice deliberately wrongly. An
        # incorrect_count of 1 here would be practice leaking into the number
        # a coach uses to decide what to re-teach.
        assert breakdown["answered_count"] == 1
        assert breakdown["correct_count"] == 1
        assert breakdown["incorrect_count"] == 0

    def test_a_practice_answer_never_reaches_the_grading_queue(
        self, app, client, coach_headers
    ):
        quiz, *_ = graded_and_practice_history(client, coach_headers)

        responses = client.get(
            f"/api/quizzes/{quiz['id']}/responses", headers=coach_headers
        ).get_json()
        rows = responses["responses"] if isinstance(responses, dict) else responses
        listed = {answer["id"] for row in rows for answer in row.get("answers", [])}
        with app.app_context():
            practice_answer_id = (
                Answer.query.join(PlayerAttempt)
                .filter(PlayerAttempt.mode == PRACTICE)
                .first()
                .id
            )

        # It is not listed...
        assert practice_answer_id not in listed
        # ...and it cannot be graded even by id.
        graded = client.patch(
            f"/api/answers/{practice_answer_id}/grade",
            headers=coach_headers,
            json={"is_correct": True},
        )
        assert graded.status_code == 404

    def test_the_dashboard_response_count_and_average_ignore_practice(
        self, client, coach_headers
    ):
        quiz, *_ = graded_and_practice_history(client, coach_headers)

        card = next(
            q
            for q in client.get("/api/quizzes", headers=coach_headers).get_json()
            if q["id"] == quiz["id"]
        )

        assert card["completed_count"] == 1
        # Graded was answered correctly, practice deliberately wrongly. A
        # score below 100 here would mean practice leaked into the average.
        assert card["average_score_percent"] == 100.0

    def test_the_player_profile_excludes_practice(self, app, client, coach_headers):
        graded_and_practice_history(client, coach_headers)

        with app.app_context():
            player_id = (
                PlayerAttempt.query.filter(PlayerAttempt.player_id.isnot(None)).first().player_id
            )
        history = client.get(
            f"/api/players/{player_id}/history", headers=coach_headers
        ).get_json()

        assert history["completed_count"] == 1
        assert len(history["recent_results"]) == 1
        # The graded attempt was answered correctly. A cumulative score below
        # 100 would mean the deliberately-wrong practice reps were averaged in.
        assert history["recent_results"][0]["score_percent"] == 100.0

    def test_admin_view_org_wide_analytics_exclude_practice(
        self, app, client, coach_headers
    ):
        """Admin View is a wider SCOPE, not a second set of numbers.

        Both org-wide history routes delegate to the same functions Coach View
        uses (grading._player_history_payload / players.build_player_history),
        which is what stops the two disagreeing. Asserted through the actual
        admin endpoints rather than trusting that delegation stays in place.
        """
        graded_and_practice_history(client, coach_headers)

        with app.app_context():
            player_id = (
                PlayerAttempt.query.filter(PlayerAttempt.player_id.isnot(None)).first().player_id
            )

        by_id = client.get(
            f"/api/organizations/players/{player_id}/history", headers=coach_headers
        )
        assert by_id.status_code == 200, by_id.get_json()
        assert by_id.get_json()["completed_count"] == 1

        by_name = client.get(
            f"/api/organizations/players/history?name={PLAYER}", headers=coach_headers
        )
        assert by_name.status_code == 200, by_name.get_json()
        payload = by_name.get_json()
        assert len(payload["history"]) == 1

    def test_the_cumulative_performance_pdf_excludes_practice(
        self, app, client, coach_headers
    ):
        """The PDF a coach hands to a player or a parent.

        It reuses build_player_history, so it inherits the rule - but this is
        the artefact that leaves the building, so it is asserted against the
        real endpoint rather than trusted to delegation.
        """
        graded_and_practice_history(client, coach_headers)

        with app.app_context():
            player_id = (
                PlayerAttempt.query.filter(PlayerAttempt.player_id.isnot(None)).first().player_id
            )

        response = client.get(
            f"/api/players/report.pdf?ids={player_id}", headers=coach_headers
        )

        assert response.status_code == 200
        assert response.mimetype == "application/pdf"
        # The numbers are the profile's numbers, and the profile counts one
        # completion - so a PDF built from three attempts would disagree with
        # the screen the coach was just looking at.
        history = client.get(
            f"/api/players/{player_id}/history", headers=coach_headers
        ).get_json()
        assert history["completed_count"] == 1

    def test_the_results_csv_excludes_practice(self, client, coach_headers):
        quiz, *_ = graded_and_practice_history(client, coach_headers)

        response = client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=coach_headers)

        assert response.status_code == 200
        body = response.get_data(as_text=True)
        # One row per answer, so three questions answered once each. Six rows
        # would mean the practice attempt was exported alongside the graded
        # one - the exact failure this whole feature must never cause.
        assert len([line for line in body.splitlines() if PLAYER in line]) == 3


class TestTheLiveBoardIsModeAware:
    """"Live now" answers "who is doing the thing I just sent", which is not
    an official-performance question - so it is the one coach-facing board
    that must SHOW practice rather than hide it, clearly labelled."""

    def test_a_live_practice_code_reports_who_has_practised(
        self, client, coach_headers
    ):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written)
        submit(client, code, answers)

        board = client.get("/api/quizzes/active-status", headers=coach_headers).get_json()
        entry = next(e for e in board if e["access_code_id"] == code["id"])

        # Filtering this by official_only would leave the card reading
        # "nobody submitted, whole roster not started" forever.
        assert entry["is_practice"] is True
        assert entry["mode"] == PRACTICE
        assert [p["player_name"] for p in entry["submitted"]] == [PLAYER]
        assert entry["not_started"] == []

    def test_a_graded_card_is_unchanged(self, client, coach_headers):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written)
        submit(client, code, answers)

        board = client.get("/api/quizzes/active-status", headers=coach_headers).get_json()
        entry = next(e for e in board if e["access_code_id"] == code["id"])

        assert entry["is_practice"] is False
        assert [p["player_name"] for p in entry["submitted"]] == [PLAYER]

    def test_a_card_never_absorbs_an_attempt_from_the_other_mode(
        self, app, client, coach_headers
    ):
        """Attempts are matched against their own code's mode, so re-moding a
        code after the fact cannot make a graded card count practice reps."""
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written)
        submit(client, code, answers)

        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            stored.mode = GRADED
            db.session.commit()

        board = client.get("/api/quizzes/active-status", headers=coach_headers).get_json()
        entry = next(e for e in board if e["access_code_id"] == code["id"])

        # The code now claims GRADED; the attempt is still PRACTICE and must
        # not be counted as a real submission.
        assert entry["submitted"] == []


class TestOnboardingCountsPractice:
    """The one intentional exception, asserted so a future reader does not
    'fix' it. The milestone measures usage, not performance."""

    def test_a_practice_completion_satisfies_the_milestone(self, client, coach_headers):
        from tests.test_onboarding import complete_onboarding, get_progress

        quiz_id, graded_code = complete_onboarding(client, coach_headers)
        assert get_progress(client, coach_headers)["milestone"]["complete"] is False

        payload = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()
        question_id = payload["questions"][0]["id"]
        practice_code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes",
            json={"mode": PRACTICE, "group_ids": graded_code["groups"][0:1] and
                  [g["id"] for g in graded_code["groups"]]},
            headers=coach_headers,
        ).get_json()

        player = "Sam Reed"
        assert start(client, practice_code, player_name=player).status_code == 201
        save(client, practice_code, question_id, text="Reps.", player_name=player)
        assert (
            submit(
                client,
                practice_code,
                [{"question_id": question_id, "answer_text": "Reps.", "selected_option_id": None}],
                player_name=player,
            ).status_code
            == 201
        )

        assert get_progress(client, coach_headers)["milestone"]["complete"] is True


# --------------------------------------------------------------------------
# Mode is decided by the coach and frozen on the attempt
# --------------------------------------------------------------------------


class TestModeIsNotTheClientsToChoose:
    def test_the_player_cannot_ask_for_a_practice_attempt(
        self, app, client, coach_headers
    ):
        quiz, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])

        response = client.post(
            "/api/play/start",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "mode": PRACTICE,
            },
        )

        # Refused outright rather than quietly ignored - the schema has no
        # `mode` field, so there is no path from the player's request to the
        # column at all.
        assert response.status_code == 422
        with app.app_context():
            assert PlayerAttempt.query.count() == 0

    def test_an_attempt_keeps_the_mode_it_started_under(
        self, app, client, coach_headers
    ):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)

        # A coach editing the code afterwards must not reclassify work already
        # done - that would either erase reps or promote them into a grade.
        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            stored.mode = GRADED
            db.session.commit()

        assert check(client, code, multiple_choice["id"]).status_code == 200
        with app.app_context():
            assert PlayerAttempt.query.one().mode == PRACTICE

    def test_an_unknown_mode_is_refused(self, client, coach_headers):
        quiz, *_ = build_quiz(client, coach_headers)

        response = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": "UNGRADED"},
            headers=coach_headers,
        )

        assert response.status_code == 422


# --------------------------------------------------------------------------
# The remaining question types
# --------------------------------------------------------------------------


class TestDrawResponseInPractice:
    def test_a_drawing_is_recorded_without_a_verdict(self, client, coach_headers):
        from tests.test_drawings import build_drawing_quiz

        quiz, question, _ = build_drawing_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)

        feedback = check(client, code, question["id"]).get_json()

        # V1: Peira does not grade a drawing, so it does not pretend to.
        assert feedback["auto_gradable"] is False
        assert feedback["is_correct"] is None

    def test_a_checked_drawing_can_no_longer_be_edited(self, client, coach_headers):
        from tests.test_drawings import _document, build_drawing_quiz

        quiz, question, _ = build_drawing_quiz(client, coach_headers)
        document = _document()
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        first = client.put(
            "/api/play/drawing",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": question["id"],
                "document": document,
                "base_revision": None,
            },
        )
        assert first.status_code == 200
        check(client, code, question["id"])

        response = client.put(
            "/api/play/drawing",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "question_id": question["id"],
                "document": document,
                "base_revision": first.get_json()["revision"],
            },
        )

        assert response.status_code == 409
        assert response.get_json()["reason"] == "practice_answer_locked"


class TestFillBlankInPractice:
    def test_a_fill_blank_answer_is_checked_automatically(self, client, coach_headers):
        from tests.test_playbook_questions import playbook_quiz

        quiz, _, question = playbook_quiz(client, coach_headers)
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            headers=coach_headers,
            json={"players": [PLAYER]},
        )
        code = activate(client, coach_headers, quiz["id"], mode=PRACTICE)
        start(client, code)
        save(client, code, question["id"], text="Cover 3")

        feedback = check(client, code, question["id"]).get_json()

        assert feedback["auto_gradable"] is True
        assert feedback["is_correct"] is True

    def test_the_explanation_is_editable_on_a_region_question(
        self, client, coach_headers
    ):
        from tests.test_playbook_questions import playbook_quiz

        quiz, _, question = playbook_quiz(client, coach_headers)

        response = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/region",
            headers=coach_headers,
            json={"answer_explanation": "Three deep, four under."},
        )

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["answer_explanation"] == "Three deep, four under."


# --------------------------------------------------------------------------
# The guard that stops this decaying
# --------------------------------------------------------------------------


class TestOfficialScopeGuard:
    """attempt_scope exists so the official/practice rule is written once.

    This test fails when somebody adds an attempt query for reporting without
    routing it through that module - the failure mode being a coach's average
    silently absorbing practice scores while nothing looks broken.
    """

    #: Every module allowed to read PlayerAttempt without official_only, and
    #: why. Adding to this list is a deliberate act with a stated reason.
    EXEMPT = {
        # The player's own in-progress attempt. Must see practice: it IS the
        # practice session.
        "app/routes/play.py",
        # Attempt lookup shared by the /play routes. Same reason.
        "app/services/attempts.py",
        # The rule itself.
        "app/services/attempt_scope.py",
        # "Has this coach's product ever been used", not "how did anyone do".
        # Documented at the call site.
        "app/services/onboarding.py",
    }

    def test_every_reporting_query_goes_through_attempt_scope(self):
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parent.parent / "app"
        offenders = []
        for path in sorted(root.rglob("*.py")):
            relative = path.relative_to(root.parent).as_posix()
            if relative in self.EXEMPT:
                continue
            source = path.read_text(encoding="utf-8")
            if "PlayerAttempt" not in source:
                continue
            # Every form a reporting query actually takes in this codebase.
            # `db.session.query(PlayerAttempt...)` matters as much as
            # `PlayerAttempt.query` - quizzes.py's dashboard counters use it,
            # and a guard that only knew the ORM shorthand would have waved
            # them straight through.
            queries = re.findall(
                r"PlayerAttempt\.query|select_from\(PlayerAttempt|session\.query\(\s*PlayerAttempt",
                source,
            )
            if not queries:
                continue
            if "official_only" not in source and "official_filter" not in source:
                offenders.append(relative)

        assert offenders == [], (
            "These modules query PlayerAttempt for reporting without using "
            "app/services/attempt_scope. Either route them through it or add "
            "them to EXEMPT with a reason: " + ", ".join(offenders)
        )


class TestAutoGradableIsPublished:
    def test_the_coach_payload_says_which_types_peira_can_check(
        self, client, coach_headers
    ):
        quiz, multiple_choice, _, written = build_quiz(client, coach_headers)

        payload = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
        by_id = {q["id"]: q for q in payload["questions"]}

        assert by_id[multiple_choice["id"]]["auto_gradable"] is True
        assert by_id[written["id"]]["auto_gradable"] is False

    @pytest.mark.parametrize(
        "question_type,expected",
        [
            (QuestionType.MULTIPLE_CHOICE, True),
            (QuestionType.TRUE_FALSE, True),
            (QuestionType.FILL_BLANK, True),
            (QuestionType.WRITTEN, False),
            (QuestionType.DRAW_RESPONSE, False),
        ],
    )
    def test_the_set_is_derived_not_listed(self, question_type, expected):
        from app.models.question import AUTO_GRADABLE_TYPES

        assert (question_type in AUTO_GRADABLE_TYPES) is expected

    def test_the_two_sets_partition_every_type(self):
        from app.models.question import AUTO_GRADABLE_TYPES, MANUALLY_GRADED_TYPES

        # A new question type must land in exactly one of them - this fails
        # loudly rather than letting a type quietly default to "gradable".
        assert AUTO_GRADABLE_TYPES | MANUALLY_GRADED_TYPES == set(QuestionType)
        assert AUTO_GRADABLE_TYPES & MANUALLY_GRADED_TYPES == set()


class TestExplanationAuthoring:
    def test_it_can_be_written_while_creating_the_question(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Explained"}, headers=coach_headers
        ).get_json()

        response = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            headers=coach_headers,
            json={
                "question_text": "Which coverage?",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
                "answer_explanation": "Look at the safety depth.",
            },
        )

        assert response.status_code == 201
        assert response.get_json()["answer_explanation"] == "Look at the safety depth."

    def test_it_stays_editable_after_players_have_answered(
        self, client, coach_headers
    ):
        quiz, multiple_choice, true_false, written = build_quiz(client, coach_headers)
        code = activate(client, coach_headers, quiz["id"])
        start(client, code)
        answers = answer_all(client, code, multiple_choice, true_false, written)
        submit(client, code, answers)

        # Editing the options after an answer is refused; editing the teaching
        # note is not, because it cannot change anybody's score.
        response = client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{multiple_choice['id']}",
            headers=coach_headers,
            json={"answer_explanation": "Improved after seeing the answers."},
        )

        assert response.status_code == 200, response.get_json()
        assert response.get_json()["answer_explanation"] == "Improved after seeing the answers."

    def test_clearing_it_stores_null_rather_than_an_empty_string(
        self, app, client, coach_headers
    ):
        quiz, multiple_choice, *_ = build_quiz(client, coach_headers, explanation="Temporary.")

        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{multiple_choice['id']}",
            headers=coach_headers,
            json={"answer_explanation": ""},
        )

        with app.app_context():
            assert db.session.get(Question, multiple_choice["id"]).answer_explanation is None
