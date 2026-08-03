"""Deterministic per-player answer plan, shared by seed.py, locustfile.py,
and verify.py so "what a virtual player submits" and "what we expect to
find in the database afterward" can never drift apart from each other.

Every virtual player answers every question - correctly or incorrectly,
by a fixed formula based on their player index and the question's
position - so verify.py can recompute the exact expected score for every
single player from nothing but their name, and catch not just "was
something graded wrong" but specifically "was this player's answer
associated with a different player" (a wrong-but-differently-wrong score
pattern would show that up immediately).
"""

PLAYER_NAME_PREFIX = "LoadPlayer"


def player_name(index: int) -> str:
    return f"{PLAYER_NAME_PREFIX}{index + 1:04d}"


def player_index_from_name(name: str) -> int | None:
    if not name.startswith(PLAYER_NAME_PREFIX):
        return None
    try:
        return int(name[len(PLAYER_NAME_PREFIX):]) - 1
    except ValueError:
        return None


def chosen_option_index(player_idx: int, question_idx: int, option_count: int) -> int:
    """Which option (by position) this player selects for this question."""
    return (player_idx + question_idx) % option_count


def build_answer_plan(player_idx: int, questions: list[dict]) -> list[dict]:
    """questions: the "questions" list from loadtest_config.json (see
    seed.py). Returns one entry per question: {question_id, selected_option_id,
    expected_correct}, ready to both drive a submission and check the result.
    """
    plan = []
    for q_idx, question in enumerate(questions):
        options = question["options"]
        chosen = options[chosen_option_index(player_idx, q_idx, len(options))]
        plan.append(
            {
                "question_id": question["id"],
                "selected_option_id": chosen["id"],
                "expected_correct": chosen["is_correct"],
            }
        )
    return plan
