"""Player Progress Analytics performance verification (Part 8): a
realistic-scale fixture - 100 Players, 100 Quizzes, several thousand
PlayerAttempts/Answers - built directly against the models (bypassing the
HTTP activation flow entirely, which would be far slower and isn't the
thing under test here) to measure query counts and response times for the
two hot paths: a single Player's own analytics, and the whole-organization
roster rollup.

This is a real, always-run test (not a skipped benchmark) with generous
but concrete assertions - a genuine N+1 regression would blow both the
query-count and the wall-clock budgets by a wide margin, so these bounds
have real slack without being meaningless.
"""

import random
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from app.extensions import db
from app.models import (
    AccessCode,
    Answer,
    AttemptStatus,
    Coach,
    Organization,
    Player,
    PlayerAttempt,
    Question,
    QuestionOption,
    QuestionType,
    Quiz,
)
from app.services.player_analytics import compute_org_roster, compute_player_analytics

PLAYER_COUNT = 100
QUIZ_COUNT = 100
ATTEMPTS_PER_PLAYER = 30  # -> ~3,000 attempts, ~9,000 answers (3 questions/quiz)
QUESTIONS_PER_QUIZ = 3


def _seed_large_fixture(app):
    """Builds the fixture in bulk, in as few round-trips as practical -
    this is fixture setup, not the thing being measured, so it isn't
    wrapped in the query-count assertions below."""
    with app.app_context():
        org = Organization(name="Perf Test Org")
        db.session.add(org)
        db.session.flush()

        coach = Coach(
            organization_id=org.id,
            username="perfcoach",
            email="perfcoach@example.com",
        )
        coach.set_password("password123")
        db.session.add(coach)

        players = [
            Player(
                organization_id=org.id,
                first_name=f"Player{i}",
                last_name="Test",
                position=["QB", "WR", "RB", "LB", "DB"][i % 5],
            )
            for i in range(PLAYER_COUNT)
        ]
        db.session.add_all(players)
        db.session.flush()

        quizzes = []
        for i in range(QUIZ_COUNT):
            quiz = Quiz(organization_id=org.id, coach_id=coach.id, title=f"Perf Quiz {i}")
            db.session.add(quiz)
            quizzes.append(quiz)
        db.session.flush()

        access_codes = []
        for i, quiz in enumerate(quizzes):
            code = AccessCode(
                quiz_id=quiz.id,
                code=f"PERF{i:04d}",
                activated_at=datetime.now(timezone.utc) - timedelta(days=1),
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            )
            db.session.add(code)
            access_codes.append(code)
        db.session.flush()

        questions_by_quiz: dict[int, list[tuple[Question, list[QuestionOption]]]] = {}
        for quiz in quizzes:
            questions_by_quiz[quiz.id] = []
            for q in range(QUESTIONS_PER_QUIZ):
                question = Question(
                    quiz_id=quiz.id,
                    question_text=f"Question {q} for {quiz.title}?",
                    question_type=QuestionType.TRUE_FALSE,
                    position=q,
                )
                db.session.add(question)
                db.session.flush()
                opt_true = QuestionOption(
                    question_id=question.id, option_text="True", position=0, is_correct_answer=True
                )
                opt_false = QuestionOption(
                    question_id=question.id, option_text="False", position=1, is_correct_answer=False
                )
                db.session.add_all([opt_true, opt_false])
                questions_by_quiz[quiz.id].append((question, [opt_true, opt_false]))
        db.session.flush()

        rng = random.Random(42)
        now = datetime.now(timezone.utc)
        attempts = []
        for player in players:
            attempted_codes = rng.sample(access_codes, k=min(ATTEMPTS_PER_PLAYER, len(access_codes)))
            for code in attempted_codes:
                submitted_at = now - timedelta(days=rng.randint(0, 60))
                attempt = PlayerAttempt(
                    quiz_id=code.quiz_id,
                    access_code_id=code.id,
                    player_name=player.full_name,
                    player_id=player.id,
                    status=AttemptStatus.SUBMITTED,
                    started_at=submitted_at - timedelta(minutes=5),
                    submitted_at=submitted_at,
                )
                db.session.add(attempt)
                attempts.append((attempt, code.quiz_id))
        db.session.flush()

        for attempt, quiz_id in attempts:
            for question, options in questions_by_quiz[quiz_id]:
                correct = rng.random() < 0.7
                selected = options[0] if correct else options[1]
                db.session.add(
                    Answer(
                        attempt_id=attempt.id,
                        question_id=question.id,
                        selected_option_id=selected.id,
                        is_correct=correct,
                    )
                )
        db.session.commit()

        return org.id, [p.id for p in players]


def _count_queries(fn):
    queries = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        queries.append(statement)

    event.listen(db.engine, "before_cursor_execute", _listener)
    start = time.perf_counter()
    try:
        result = fn()
    finally:
        event.remove(db.engine, "before_cursor_execute", _listener)
    elapsed = time.perf_counter() - start
    return result, len(queries), elapsed


def test_org_roster_performance_at_realistic_scale(app):
    """compute_org_roster over 100 Players / ~3,000 attempts / ~9,000
    graded answers: a small, roughly-constant number of queries (never
    one per Player - that's the N+1 this whole design avoids) and a
    response time that stays well within what an interactive page load
    needs."""
    organization_id, _player_ids = _seed_large_fixture(app)

    with app.app_context():
        result, query_count, elapsed = _count_queries(lambda: compute_org_roster(organization_id))

        assert len(result["players"]) == PLAYER_COUNT
        assert result["summary"]["total_active_players"] == PLAYER_COUNT
        # Generous bound: the real implementation issues a handful of
        # batched queries total, regardless of Player count - a genuine
        # N+1 over 100 Players would be in the hundreds, not under 20.
        assert query_count < 20, f"compute_org_roster issued {query_count} queries for {PLAYER_COUNT} players"
        assert elapsed < 5.0, f"compute_org_roster took {elapsed:.2f}s for {PLAYER_COUNT} players"

        print(
            f"\n[perf] compute_org_roster: {query_count} queries, {elapsed * 1000:.1f}ms "
            f"for {PLAYER_COUNT} players / ~{PLAYER_COUNT * ATTEMPTS_PER_PLAYER} attempts"
        )


def test_player_analytics_performance_at_realistic_scale(app):
    """A single Player's own analytics (Player Profile page) among ~3,000
    attempts total in the organization - bounded by this one Player's own
    ~30 attempts, not the organization's total."""
    organization_id, player_ids = _seed_large_fixture(app)

    with app.app_context():
        player = db.session.get(Player, player_ids[0])
        result, query_count, elapsed = _count_queries(lambda: compute_player_analytics(player))

        assert result["summary"]["assigned_count"] == ATTEMPTS_PER_PLAYER
        assert query_count < 10, f"compute_player_analytics issued {query_count} queries"
        assert elapsed < 1.0, f"compute_player_analytics took {elapsed:.2f}s"

        print(f"\n[perf] compute_player_analytics: {query_count} queries, {elapsed * 1000:.1f}ms")
