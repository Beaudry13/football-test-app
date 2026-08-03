"""Post-run data-integrity check, independent of whatever Locust itself
reported. Connects directly to football_quiz_loadtest and checks every
expected player individually for:

  - lost submissions (no SUBMITTED attempt at all)
  - duplicate results (more than one attempt row for that player)
  - cross-player association errors (an answer's selected option doesn't
    match what that specific player's deterministic answer plan says it
    should be - would show up if answers ever got attached to the wrong
    attempt)
  - incorrect scoring (stored is_correct doesn't match the recomputed
    expected value for that player+question)

Usage:
    python loadtest/verify.py --expected 50
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/

DB_NAME = "football_quiz_loadtest"
os.environ["DATABASE_URL"] = f"postgresql://quiz_user:quiz_password@localhost:5432/{DB_NAME}"

from scenario import build_answer_plan, player_name  # noqa: E402

from app import create_app  # noqa: E402
from app.models import AttemptStatus, PlayerAttempt  # noqa: E402

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loadtest_config.json")


def main(expected: int) -> int:
    with open(CONFIG_PATH) as f:
        config = json.load(f)
    access_code_id = config["access_code_id"]
    questions = config["questions"]

    app = create_app("development")
    with app.app_context():
        all_attempts = PlayerAttempt.query.filter_by(access_code_id=access_code_id).all()
        attempts_by_name: dict[str, list[PlayerAttempt]] = {}
        for a in all_attempts:
            attempts_by_name.setdefault(a.player_name, []).append(a)

        lost = []
        duplicated = []
        wrong_status = []
        association_errors = []
        scoring_errors = []

        for i in range(expected):
            name = player_name(i)
            attempts = attempts_by_name.get(name, [])

            if not attempts:
                lost.append(name)
                continue
            if len(attempts) > 1:
                duplicated.append((name, len(attempts)))

            attempt = attempts[0]
            if attempt.status != AttemptStatus.SUBMITTED:
                wrong_status.append((name, attempt.status.value))
                continue

            expected_plan = {a["question_id"]: a for a in build_answer_plan(i, questions)}
            actual_answers = {a.question_id: a for a in attempt.answers}

            for question_id, expected_answer in expected_plan.items():
                actual = actual_answers.get(question_id)
                if actual is None:
                    association_errors.append(f"{name}: missing answer for question {question_id}")
                    continue
                if actual.selected_option_id != expected_answer["selected_option_id"]:
                    association_errors.append(
                        f"{name}: question {question_id} selected_option_id={actual.selected_option_id}, "
                        f"expected {expected_answer['selected_option_id']} (cross-player mixup or lost write)"
                    )
                if actual.is_correct != expected_answer["expected_correct"]:
                    scoring_errors.append(
                        f"{name}: question {question_id} is_correct={actual.is_correct}, "
                        f"expected {expected_answer['expected_correct']}"
                    )

        unexpected_names = set(attempts_by_name) - {player_name(i) for i in range(expected)}

        print(f"Expected players: {expected}")
        print(f"Attempts found for access_code_id={access_code_id}: {len(all_attempts)}")
        print()
        print(f"Lost submissions:            {len(lost)}")
        if lost:
            print(f"  {lost}")
        print(f"Duplicate result records:    {len(duplicated)}")
        if duplicated:
            print(f"  {duplicated}")
        print(f"Wrong attempt status:        {len(wrong_status)}")
        if wrong_status:
            print(f"  {wrong_status}")
        print(f"Cross-association errors:    {len(association_errors)}")
        for e in association_errors[:20]:
            print(f"  {e}")
        print(f"Incorrect scoring:           {len(scoring_errors)}")
        for e in scoring_errors[:20]:
            print(f"  {e}")
        print(f"Unexpected extra players:    {len(unexpected_names)}")
        if unexpected_names:
            print(f"  {sorted(unexpected_names)}")

        total_problems = (
            len(lost) + len(duplicated) + len(wrong_status) + len(association_errors) + len(scoring_errors) + len(unexpected_names)
        )
        print()
        if total_problems == 0:
            print(f"PASS: all {expected} players submitted exactly once with correct, correctly-associated scores.")
            return 0
        print(f"FAIL: {total_problems} integrity problem(s) found - see above.")
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected", type=int, required=True, help="number of players expected to have completed (the -u value from the Locust run)")
    args = parser.parse_args()
    sys.exit(main(args.expected))
