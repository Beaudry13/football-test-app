"""Seeds the disposable loadtest database with one throwaway coach/org, one
5-question auto-graded quiz, an N-player roster, and an active access code.
Writes loadtest_config.json (gitignored) for locustfile.py and verify.py.

Seeds directly via the SQLAlchemy models inside an app context (not real
HTTP calls) - faster for potentially 100 rows, and sidesteps /api/auth
/register's 10-per-hour rate limit, which has nothing to do with what this
suite is trying to measure.

Usage:
    python loadtest/seed.py --players 50
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

DB_NAME = "football_quiz_loadtest"
DATABASE_URL = f"postgresql://quiz_user:quiz_password@localhost:5432/{DB_NAME}"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loadtest_config.json")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/

# Must be set before importing app.config (module-level os.environ.get calls).
os.environ["DATABASE_URL"] = DATABASE_URL
os.environ.setdefault("SECRET_KEY", "loadtest-only-not-a-real-secret-abc123")
os.environ.setdefault("JWT_SECRET_KEY", "loadtest-only-not-a-real-secret-xyz789")

from scenario import player_name  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models import (  # noqa: E402
    AccessCode,
    Coach,
    CoachRole,
    Organization,
    Question,
    QuestionOption,
    QuestionType,
    Quiz,
    Roster,
    RosterPlayer,
)
from app.services.access_codes import generate_unique_code  # noqa: E402


def _true_false_question(quiz_id: int, position: int, text: str, correct: bool) -> Question:
    question = Question(quiz_id=quiz_id, question_text=text, question_type=QuestionType.TRUE_FALSE, position=position)
    db.session.add(question)
    db.session.flush()
    db.session.add(QuestionOption(question_id=question.id, option_text="True", is_correct_answer=correct, position=0))
    db.session.add(QuestionOption(question_id=question.id, option_text="False", is_correct_answer=not correct, position=1))
    return question


def _multiple_choice_question(quiz_id: int, position: int, text: str, option_texts: list[str], correct_index: int) -> Question:
    question = Question(quiz_id=quiz_id, question_text=text, question_type=QuestionType.MULTIPLE_CHOICE, position=position)
    db.session.add(question)
    db.session.flush()
    for i, option_text in enumerate(option_texts):
        db.session.add(
            QuestionOption(question_id=question.id, option_text=option_text, is_correct_answer=(i == correct_index), position=i)
        )
    return question


def seed(num_players: int) -> dict:
    app = create_app("development")  # dev config: no production secret/env-name gating, still points at DATABASE_URL above
    with app.app_context():
        # Fresh coach/org every run - if a previous run's data is still
        # sitting here, setup_db.py wasn't re-run first. Fail loudly rather
        # than silently accumulating duplicate organizations across runs.
        if Organization.query.filter_by(name="Load Test Org").first() is not None:
            raise SystemExit(
                "Load Test Org already exists in this database - run `python loadtest/setup_db.py` "
                "first to get a clean database before reseeding."
            )

        org = Organization(name="Load Test Org")
        db.session.add(org)
        db.session.flush()

        coach = Coach(username="loadtest_coach", email="loadtest@example.com", organization_id=org.id, role=CoachRole.ADMIN)
        coach.set_password("not-used-by-the-load-test-itself")
        db.session.add(coach)
        db.session.flush()

        quiz = Quiz(organization_id=org.id, coach_id=coach.id, title="Load Test Quiz")
        db.session.add(quiz)
        db.session.flush()

        questions = [
            _true_false_question(quiz.id, 0, "Load test check 1: is this true?", correct=True),
            _true_false_question(quiz.id, 1, "Load test check 2: is this true?", correct=False),
            _multiple_choice_question(quiz.id, 2, "Load test check 3: pick the right option.", ["A", "B", "C", "D"], correct_index=2),
            _multiple_choice_question(quiz.id, 3, "Load test check 4: pick the right option.", ["A", "B", "C"], correct_index=0),
            _true_false_question(quiz.id, 4, "Load test check 5: is this true?", correct=True),
        ]
        db.session.flush()

        players = [player_name(i) for i in range(num_players)]
        roster = Roster(quiz_id=quiz.id)
        db.session.add(roster)
        db.session.flush()
        for i, name in enumerate(players):
            db.session.add(RosterPlayer(roster_id=roster.id, player_name=name, position=i))

        access_code = AccessCode(
            quiz_id=quiz.id,
            code=generate_unique_code(),
            activated_at=datetime.now(timezone.utc),
            expires_at=AccessCode.default_expiry(24),
        )
        db.session.add(access_code)
        db.session.commit()

        config = {
            "code": access_code.code,
            "access_code_id": access_code.id,
            "quiz_id": quiz.id,
            "questions": [
                {
                    "id": q.id,
                    "type": q.question_type.value,
                    "options": [{"id": o.id, "is_correct": o.is_correct_answer} for o in q.options],
                }
                for q in questions
            ],
            "players": players,
        }
        with open(CONFIG_PATH, "w") as f:
            json.dump(config, f, indent=2)

        print(f"Seeded quiz_id={quiz.id}, access_code={access_code.code}, {num_players} players.")
        print(f"Wrote {CONFIG_PATH}")
        return config


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--players", type=int, default=50)
    args = parser.parse_args()
    seed(args.players)
