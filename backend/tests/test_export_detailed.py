"""Detailed per-Player, per-question PDF export (GET /export-detailed.pdf).

Read-only above all else: this quiz-submission-export feature exists next
to a real production quiz with real submitted data, so the READ-ONLY DATA
PRESERVATION section below is the load-bearing part of this file - every
other test category matters, but none of it is worth anything if exporting
can silently mutate a PlayerAttempt or Answer row.
"""

import io
import re

from pypdf import PdfReader

from app.extensions import db
from app.models import Answer, AttemptStatus, PlayerAttempt
from tests.conftest import make_image_file
from tests.test_play_and_grading import build_ready_quiz, start_and_submit


# --- helpers ----------------------------------------------------------------


def _pdf_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() for page in reader.pages)


def _snapshot(app):
    """Every field the data-safety requirement explicitly calls out, for
    every PlayerAttempt/Answer row that currently exists - compared
    before/after an export to prove nothing changed."""
    with app.app_context():
        attempts = PlayerAttempt.query.order_by(PlayerAttempt.id).all()
        answers = Answer.query.order_by(Answer.id).all()
        return {
            "attempt_count": len(attempts),
            "answer_count": len(answers),
            "attempts": [
                (
                    a.id,
                    a.status.value,
                    a.player_id,
                    a.player_name,
                    a.submitted_at.isoformat() if a.submitted_at else None,
                    a.started_at.isoformat(),
                )
                for a in attempts
            ],
            "answers": [
                (
                    a.id,
                    a.attempt_id,
                    a.question_id,
                    a.is_correct,
                    a.coach_feedback,
                    a.selected_option_id,
                    a.answer_text,
                    a.graded_at.isoformat() if a.graded_at else None,
                    a.graded_by_coach_id,
                )
                for a in answers
            ],
        }


def _make_player(client, headers, first, last, jersey=None, position=None):
    response = client.post(
        "/api/players",
        json={"first_name": first, "last_name": last, "jersey_number": jersey, "position": position},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _add_to_roster(client, headers, quiz_id, player_ids):
    response = client.post(
        f"/api/quizzes/{quiz_id}/roster/members", json={"player_ids": player_ids}, headers=headers
    )
    assert response.status_code == 201, response.get_json()


def _create_tf_quiz(client, headers, title="Install Quiz", question_text="Is this cover 2?"):
    quiz = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": question_text,
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=headers,
    ).get_json()
    return quiz, question


def _activate_canonical(client, headers, quiz_id, player_ids):
    _add_to_roster(client, headers, quiz_id, player_ids)
    response = client.post(f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _submit_canonical(client, access_code, question, player_name, player_id, correct=True):
    client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": player_name, "player_id": player_id},
    )
    option_id = question["options"][0 if correct else 1]["id"]
    return client.post(
        "/api/play/submit",
        json={
            "access_code_id": access_code["id"],
            "player_name": player_name,
            "player_id": player_id,
            "answers": [{"question_id": question["id"], "selected_option_id": option_id}],
        },
    )


def _grade(client, headers, answer_id, is_correct, feedback=None):
    body = {"is_correct": is_correct}
    if feedback is not None:
        body["coach_feedback"] = feedback
    response = client.patch(f"/api/answers/{answer_id}/grade", json=body, headers=headers)
    assert response.status_code == 200, response.get_json()
    return response.get_json()


# --- AUTHORIZATION -----------------------------------------------------------


def test_authenticated_coach_can_export_their_own_quiz(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert response.content_type == "application/pdf"
    assert response.get_data()[:5] == b"%PDF-"


def test_export_requires_authentication(client):
    quiz = {"id": 1}
    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf")
    assert response.status_code == 401


def test_export_404s_for_another_organizations_quiz(client, register_coach):
    _, _, coach_a_headers = register_coach(username="coachA", email="a@example.com")
    _, _, coach_b_headers = register_coach(username="coachB", email="b@example.com")
    quiz, *_ = build_ready_quiz(client, coach_a_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_b_headers)

    assert response.status_code == 404


def test_removed_coach_immediately_loses_export_access(client, coach_headers, invite_teammate):
    teammate, _, teammate_headers = invite_teammate(coach_headers)
    # The teammate exports THEIR OWN quiz. It used to be the admin's, which a
    # teammate could export back when every quiz was visible org-wide; now
    # that would be a 404 and would prove nothing about removal.
    quiz, *_ = build_ready_quiz(client, teammate_headers)

    # Sanity: can export while still a member.
    ok = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=teammate_headers)
    assert ok.status_code == 200

    # Removal now requires somewhere for their quizzes to go - see
    # remove_member. Handing them to the admin in the same call.
    admin_id = next(
        m["id"]
        for m in client.get("/api/organizations", headers=coach_headers).get_json()["members"]
        if m["id"] != teammate["id"]
    )
    remove_response = client.delete(
        f"/api/organizations/members/{teammate['id']}",
        headers=coach_headers,
        json={"reassign_quizzes_to": admin_id},
    )
    assert remove_response.status_code == 204

    after_removal = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=teammate_headers)
    assert after_removal.status_code == 401


# --- READ-ONLY DATA PRESERVATION ---------------------------------------------


def test_export_does_not_change_attempt_or_answer_counts(client, coach_headers, app):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [
            {"question_id": tf["id"], "selected_option_id": None},
            {"question_id": written["id"], "answer_text": "I set the edge."},
        ],
    )
    assert submit_response.status_code == 201
    before = _snapshot(app)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    assert response.status_code == 200

    after = _snapshot(app)
    assert before["attempt_count"] == after["attempt_count"]
    assert before["answer_count"] == after["answer_count"]


def test_export_does_not_change_any_recorded_field(client, coach_headers, app):
    """The full-fidelity version of the above: every field value on every
    attempt/answer row, byte-for-byte, unchanged - not just the counts."""
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    correct_option_id = next(
        o["id"]
        for o in client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"][0][
            "options"
        ]
        if o["is_correct_answer"]
    )
    submit_response = start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [
            {"question_id": tf["id"], "selected_option_id": correct_option_id},
            {"question_id": written["id"], "answer_text": "I set the edge."},
        ],
    )
    answer_id = next(a["id"] for a in submit_response.get_json()["answers"] if a["question_id"] == written["id"])
    _grade(client, coach_headers, answer_id, True, "Nice detail.")

    before = _snapshot(app)
    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    assert response.status_code == 200
    after = _snapshot(app)

    assert before == after


def test_exporting_twice_makes_no_database_changes(client, coach_headers, app):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    first = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    after_first = _snapshot(app)
    second = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    after_second = _snapshot(app)

    assert first.status_code == 200
    assert second.status_code == 200
    assert after_first == after_second


def test_a_failed_export_leaves_all_records_untouched(client, coach_headers, app, monkeypatch):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )
    before = _snapshot(app)

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated PDF generation failure")

    monkeypatch.setattr("app.routes.grading.build_detailed_results_pdf", _boom)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    assert response.status_code == 500

    after = _snapshot(app)
    assert before == after


# --- SUMMARY CALCULATIONS -----------------------------------------------------


def test_counts_correct_incorrect_not_graded_and_unanswered(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Counting Quiz"}, headers=coach_headers).get_json()
    q1 = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Q1",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()
    q2 = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Q2",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()
    q3 = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q3 written", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    q4 = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q4 unanswered", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()

    correct_option = next(o["id"] for o in q1["options"] if o["is_correct_answer"])
    wrong_option = next(o["id"] for o in q2["options"] if not o["is_correct_answer"])
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [
            {"question_id": q1["id"], "selected_option_id": correct_option},  # correct
            {"question_id": q2["id"], "selected_option_id": wrong_option},  # incorrect
            {"question_id": q3["id"], "answer_text": "some detail"},  # not graded
            # q4 never answered -> unanswered
        ],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # The counts render as stacked value/label metric cards, not one fused
    # sentence - assert each count sits next to its own label. \b keeps
    # "INCORRECT" from also satisfying the "CORRECT" check.
    assert re.search(r"1\s*CORRECT\b", text) is not None
    assert re.search(r"1\s*INCORRECT\b", text) is not None
    assert re.search(r"1\s*NOT GRADED\b", text) is not None
    assert re.search(r"1\s*UNANSWERED\b", text) is not None


def test_score_is_percent_of_graded_questions_only(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    correct_option = next(
        o["id"]
        for o in client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["questions"][0][
            "options"
        ]
        if o["is_correct_answer"]
    )
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [
            {"question_id": tf["id"], "selected_option_id": correct_option},
            {"question_id": written["id"], "answer_text": "pending"},
        ],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # 1 correct / 1 graded (the written answer is pending, excluded from
    # the denominator) = 100%, shown as a metric-card value plus the
    # caption clarifying grading is still in progress.
    assert "100.0%" in text
    assert "1 response awaiting grading" in text


def test_partially_graded_score_is_never_presented_as_final_without_a_label(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # Nothing graded yet at all (the true/false answer was left blank in
    # this deliberately-adversarial submission) -> no fabricated score.
    assert "not available (nothing graded yet)" in text


def test_reset_attempt_is_excluded_from_the_export(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    submit_response = start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )
    attempt_id = submit_response.get_json()["id"]
    client.delete(f"/api/quizzes/{quiz['id']}/attempts/{attempt_id}", headers=coach_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "Jordan Smith" not in text
    assert "No submitted Player responses are available to export yet." in text


def test_in_progress_attempt_is_excluded_from_the_export(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": "Still Playing"}
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "Still Playing" not in text


def test_no_submissions_shows_a_friendly_message_and_still_renders(client, coach_headers):
    quiz, *_ = build_ready_quiz(client, coach_headers)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_data()[:5] == b"%PDF-"
    assert "No submitted Player responses are available to export yet." in _pdf_text(response.get_data())


# --- PLAYER IDENTITY -----------------------------------------------------------


def test_canonical_player_jersey_and_position_are_shown(client, coach_headers):
    quiz, question = _create_tf_quiz(client, coach_headers)
    player = _make_player(client, coach_headers, "Jordan", "Lee", jersey="12", position="WR")
    code = _activate_canonical(client, coach_headers, quiz["id"], [player["id"]])
    _submit_canonical(client, code, question, "Jordan Lee", player["id"], correct=True)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "#12" in text
    assert "WR" in text
    assert "Jordan Lee" in text


def test_renamed_canonical_player_shows_current_display_name(client, coach_headers):
    quiz, question = _create_tf_quiz(client, coach_headers)
    player = _make_player(client, coach_headers, "Jordan", "Lee", jersey="12", position="WR")
    code = _activate_canonical(client, coach_headers, quiz["id"], [player["id"]])
    _submit_canonical(client, code, question, "Jordan Lee", player["id"], correct=True)

    client.patch(
        f"/api/players/{player['id']}",
        json={"first_name": "Jordan", "last_name": "Lee-Martinez", "jersey_number": "12", "position": "WR"},
        headers=coach_headers,
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "Jordan Lee-Martinez" in text
    assert "Jordan Lee " not in text and "Jordan Lee\n" not in text


def test_same_name_players_remain_separate_in_the_export(client, coach_headers):
    quiz, question = _create_tf_quiz(client, coach_headers)
    chris_a = _make_player(client, coach_headers, "Chris", "Smith", jersey="2", position="WR")
    chris_b = _make_player(client, coach_headers, "Chris", "Smith", jersey="42", position="LB")
    code = _activate_canonical(client, coach_headers, quiz["id"], [chris_a["id"], chris_b["id"]])
    _submit_canonical(client, code, question, "Chris Smith", chris_a["id"], correct=True)
    _submit_canonical(client, code, question, "Chris Smith", chris_b["id"], correct=False)

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert text.count("Chris Smith") >= 2
    assert "#2" in text
    assert "#42" in text


def test_legacy_name_only_attempt_displays_correctly(client, coach_headers):
    # build_ready_quiz's roster ("Jordan Smith", "Alex Lee") is plain
    # name-only entries, never linked to a canonical Player - exactly the
    # legacy case.
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    start_and_submit(
        client,
        code["id"],
        "Jordan Smith",
        [{"question_id": tf["id"], "selected_option_id": None}, {"question_id": written["id"], "answer_text": "x"}],
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert "Jordan Smith" in text


# --- PDF CONTENT ---------------------------------------------------------------


def test_organization_name_and_quiz_title_appear(client, coach_headers):
    quiz, *_ = build_ready_quiz(client, coach_headers)
    coach = client.get("/api/auth/me", headers=coach_headers).get_json()

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    assert coach["organization"] in text
    assert quiz["title"] in text
    # The wordmark is set as letterspaced caps in the redesigned masthead
    # and footer - match case-insensitively so this asserts "the brand is
    # on the page" rather than one particular capitalization.
    assert "peira" in text.lower()


def test_every_submitted_player_appears_exactly_once(client, coach_headers):
    quiz, tf, written, code = build_ready_quiz(client, coach_headers)
    for name in ("Jordan Smith", "Alex Lee"):
        start_and_submit(
            client,
            code["id"],
            name,
            [
                {"question_id": tf["id"], "selected_option_id": None},
                {"question_id": written["id"], "answer_text": "x"},
            ],
        )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # Each name appears twice: once in the page-1 summary table, once as
    # that Player's own detail-page header - never more than that.
    assert text.count("Jordan Smith") == 2
    assert text.count("Alex Lee") == 2


def test_questions_appear_in_quiz_display_order(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Order Quiz"}, headers=coach_headers).get_json()
    titles = ["Alpha question", "Bravo question", "Charlie question"]
    questions = []
    for t in titles:
        q = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": t, "question_type": "written", "options": []},
            headers=coach_headers,
        ).get_json()
        questions.append(q)
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    start_and_submit(
        client, code["id"], "Jordan Smith", [{"question_id": q["id"], "answer_text": "ok"} for q in questions]
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    positions = [text.index(t) for t in titles]
    assert positions == sorted(positions)


def test_correct_answer_is_shown_for_an_objective_question(client, coach_headers):
    quiz, question = _create_tf_quiz(client, coach_headers, question_text="Is this a blitz?")
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    wrong_option = next(o["id"] for o in question["options"] if not o["is_correct_answer"])
    start_and_submit(
        client, code["id"], "Jordan Smith", [{"question_id": question["id"], "selected_option_id": wrong_option}]
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)
    text = _pdf_text(response.get_data())

    # Field labels are letterspaced small-caps in the redesigned card
    # ("CORRECT ANSWER", no colon), and the per-question status now reads
    # as a chip in the card header rather than a trailing "Result:" line -
    # same facts, different presentation.
    assert "CORRECT ANSWER" in text
    assert "True" in text  # the correct option's text
    assert "INCORRECT" in text


def test_filename_is_sanitized_and_readable(client, coach_headers):
    quiz = client.post(
        "/api/quizzes", json={"title": "Week 1: Cover 2 & Blitz Install!!"}, headers=coach_headers
    ).get_json()
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q", "question_type": "written", "options": []},
        headers=coach_headers,
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)

    disposition = response.headers["Content-Disposition"]
    assert "week-1-cover-2-blitz-install" in disposition
    assert "&" not in disposition
    assert "!" not in disposition
    assert disposition.endswith('.pdf"')


# --- EDGE CASES: IMAGES --------------------------------------------------------


def test_image_question_embeds_the_base_image_without_error(client, coach_headers):
    quiz = client.post("/api/quizzes", json={"title": "Image Quiz"}, headers=coach_headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    file_obj, filename = make_image_file()
    upload = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=coach_headers,
        content_type="multipart/form-data",
    )
    assert upload.status_code == 201

    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    start_and_submit(
        client, code["id"], "Jordan Smith", [{"question_id": question["id"], "answer_text": "the SAM"}]
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert response.get_data()[:5] == b"%PDF-"


def test_missing_image_file_degrades_cleanly(client, coach_headers, app):
    """The QuestionImage row exists but the underlying file is gone (e.g.
    deleted from disk out-of-band) - the export must not 500."""
    quiz = client.post("/api/quizzes", json={"title": "Broken Image Quiz"}, headers=coach_headers).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Circle the mike backer", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()
    file_obj, filename = make_image_file()
    upload = client.post(
        f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
        data={"image": (file_obj, filename)},
        headers=coach_headers,
        content_type="multipart/form-data",
    )
    image_url = upload.get_json()["image_url"]
    with app.app_context():
        from app.services.file_storage import get_file_storage

        storage = get_file_storage()
        storage.delete_image(image_url)  # simulate the file having gone missing

    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": ["Jordan Smith"]}, headers=coach_headers)
    code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", headers=coach_headers).get_json()
    start_and_submit(
        client, code["id"], "Jordan Smith", [{"question_id": question["id"], "answer_text": "the SAM"}]
    )

    response = client.get(f"/api/quizzes/{quiz['id']}/export-detailed.pdf", headers=coach_headers)

    assert response.status_code == 200
    assert "[Image unavailable]" in _pdf_text(response.get_data())
