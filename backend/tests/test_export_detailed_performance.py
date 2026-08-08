"""Detailed PDF export performance (quiz-submission-export Part: PERFORMANCE).

Seeds a realistic-scale quiz directly against the models (bypassing the
slow per-request HTTP roster/activation flow, which isn't what's under
test here) with N Players and 20 questions, each Player answering every
question with a mix of correct/incorrect/pending-grading, then calls the
real GET /export-detailed.pdf endpoint end-to-end and measures query count,
generation time, and output file size.
"""

import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app.extensions import db
from app.models import (
    AccessCode,
    Answer,
    AttemptStatus,
    Coach,
    Organization,
    PlayerAttempt,
    Question,
    QuestionOption,
    QuestionType,
    Quiz,
)

QUESTION_COUNT = 20


def _seed(app, player_count: int):
    with app.app_context():
        org = Organization(name=f"Perf Export Org {player_count}")
        db.session.add(org)
        db.session.flush()

        coach = Coach(organization_id=org.id, username=f"perfcoach{player_count}", email=f"perf{player_count}@example.com")
        coach.set_password("password123")
        db.session.add(coach)
        # flush() so coach.id exists. Without it coach_id was None and this
        # fixture built an OWNERLESS quiz - invisible to everyone now that
        # Coach View is own-only, and silently fine before.
        db.session.flush()

        quiz = Quiz(organization_id=org.id, coach_id=coach.id, title=f"Perf Export Quiz {player_count}")
        db.session.add(quiz)
        db.session.flush()

        code = AccessCode(
            quiz_id=quiz.id,
            code=f"PERFX{player_count}",
            activated_at=datetime.now(timezone.utc) - timedelta(hours=1),
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        db.session.add(code)
        db.session.flush()

        questions = []
        for i in range(QUESTION_COUNT):
            q = Question(
                quiz_id=quiz.id, question_text=f"Question {i}?", question_type=QuestionType.TRUE_FALSE, position=i
            )
            db.session.add(q)
            db.session.flush()
            opt_true = QuestionOption(question_id=q.id, option_text="True", position=0, is_correct_answer=True)
            opt_false = QuestionOption(question_id=q.id, option_text="False", position=1, is_correct_answer=False)
            db.session.add_all([opt_true, opt_false])
            questions.append((q, opt_true, opt_false))
        db.session.flush()

        now = datetime.now(timezone.utc)
        for p in range(player_count):
            attempt = PlayerAttempt(
                quiz_id=quiz.id,
                access_code_id=code.id,
                player_name=f"Player {p}",
                status=AttemptStatus.SUBMITTED,
                started_at=now - timedelta(minutes=10),
                submitted_at=now,
            )
            db.session.add(attempt)
            db.session.flush()
            for i, (q, opt_true, opt_false) in enumerate(questions):
                if i % 5 == 4:
                    continue  # one unanswered question per Player
                is_correct = i % 3 != 0
                db.session.add(
                    Answer(
                        attempt_id=attempt.id,
                        question_id=q.id,
                        selected_option_id=opt_true.id if is_correct else opt_false.id,
                        is_correct=is_correct,
                    )
                )
        db.session.commit()
        return quiz.id, coach.id, org.id


def _auth_headers(client, coach_id: int) -> dict:
    from flask_jwt_extended import create_access_token

    with client.application.app_context():
        token = create_access_token(identity=str(coach_id))
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("player_count", [22, 50, 100])
def test_detailed_export_performance_at_scale(app, client, player_count):
    quiz_id, coach_id, _org_id = _seed(app, player_count)
    headers = _auth_headers(client, coach_id)

    queries = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        queries.append(statement)

    event.listen(db.engine, "before_cursor_execute", _listener)
    start = time.perf_counter()
    try:
        response = client.get(f"/api/quizzes/{quiz_id}/export-detailed.pdf", headers=headers)
    finally:
        event.remove(db.engine, "before_cursor_execute", _listener)
    elapsed = time.perf_counter() - start

    assert response.status_code == 200
    pdf_bytes = response.get_data()
    assert pdf_bytes[:5] == b"%PDF-"

    print(
        f"\n[perf] export-detailed.pdf: {player_count} players x {QUESTION_COUNT} questions -> "
        f"{len(queries)} queries, {elapsed * 1000:.0f}ms, {len(pdf_bytes) / 1024:.0f}KB"
    )

    # A small, constant number of queries regardless of Player count (in
    # practice: 13, whether 22 or 100 Players) - eager-loading questions'
    # options/image fixed a real N+1 found during this test's first run
    # (50 queries at every scale, from lazy per-question option/image
    # loads - see export_results_detailed_pdf's docstring). A real N+1
    # over Players or questions would scale into the hundreds, not stay
    # flat.
    assert len(queries) < 20
    # PDF generation work is proportional to content rendered (~20
    # question-blocks per Player), so wall-clock scales with player_count -
    # bounded generously per-Player rather than with one flat ceiling.
    assert elapsed < 0.15 * player_count + 5.0
