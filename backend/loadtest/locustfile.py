"""Realistic player-flow load test.

Each virtual user performs exactly one complete, realistic quiz-taking
session - not a repeated hammer on one endpoint:

    validate-code -> think (reads the join screen) -> start -> for each
    question: think (reads it) -> answer (autosave) -> submit -> results

Run via `locust -f locustfile.py --headless -u N -r R -t Ts --csv=... --host=...`
- see README.md for the exact commands per stage. Each user is assigned a
unique, pre-seeded roster player name (see scenario.py) so verify.py can
check every single one individually afterward.
"""

import itertools
import json
import os
import random
import time

from locust import HttpUser, between, events, task

from scenario import build_answer_plan

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loadtest_config.json")

with open(CONFIG_PATH) as f:
    CONFIG = json.load(f)

ACCESS_CODE_ID = CONFIG["access_code_id"]
CODE = CONFIG["code"]
QUESTIONS = CONFIG["questions"]
PLAYERS = CONFIG["players"]

# Shared across all users in this process. Safe without a lock: Locust runs
# every user's tasks as gevent greenlets in one process, which only switch
# at actual I/O (e.g. an HTTP call or time.sleep) - not at a plain
# `next()` call on a generator - so this can't race between two greenlets
# both trying to claim the same player.
_player_pool = itertools.count()


@events.init.add_listener
def _check_pool_size(environment, **kwargs):
    users = getattr(environment.parsed_options, "num_users", None)
    if users and users > len(PLAYERS):
        raise SystemExit(
            f"Requested {users} users but only {len(PLAYERS)} players are seeded - "
            f"re-run `python seed.py --players {users}` first."
        )


class PlayerUser(HttpUser):
    # Between-question think time, not between-task time (the whole
    # scripted flow is one task - see the `idle` task below). Applied
    # manually via time.sleep() at each realistic pause point instead.
    wait_time = between(1, 1)

    def on_start(self):
        player_idx = next(_player_pool)
        if player_idx >= len(PLAYERS):
            # More users than seeded players (shouldn't happen given the
            # init-time check above, but fail loudly rather than reusing a
            # name and silently corrupting the "one attempt per player"
            # integrity check).
            raise RuntimeError(f"Ran out of seeded players at index {player_idx}")
        self.player_name = PLAYERS[player_idx]
        self.answer_plan = build_answer_plan(player_idx, QUESTIONS)
        self._run_flow()

    def _run_flow(self):
        # 1. Join screen - loads the quiz by code.
        with self.client.post(
            "/api/play/validate-code", json={"code": CODE}, name="01_validate_code", catch_response=True
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"validate-code failed: {resp.status_code} {resp.text[:200]}")
                return
            resp.success()

        time.sleep(random.uniform(1.0, 3.0))  # reading the join screen / picking a name

        # 2. Identify as this player, create/resume the attempt.
        with self.client.post(
            "/api/play/start",
            json={"access_code_id": ACCESS_CODE_ID, "player_name": self.player_name},
            name="02_start",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 201):
                resp.failure(f"start failed: {resp.status_code} {resp.text[:200]}")
                return
            resp.success()

        # 3. Answer every question, one autosave call per question, with
        # realistic reading/thinking time before each.
        for answer in self.answer_plan:
            time.sleep(random.uniform(1.5, 4.0))
            payload = {
                "access_code_id": ACCESS_CODE_ID,
                "player_name": self.player_name,
                "question_id": answer["question_id"],
                "selected_option_id": answer["selected_option_id"],
            }
            with self.client.post(
                "/api/play/answers", json=payload, name="03_answer", catch_response=True
            ) as resp:
                if resp.status_code != 204:
                    resp.failure(f"answer failed: {resp.status_code} {resp.text[:200]}")
                    return
                resp.success()

        time.sleep(random.uniform(0.5, 1.5))  # reviewing before hitting submit

        # 4. Final submission - the response includes the submitted-answer
        # payload, which /submit re-upserts server-side before locking, same
        # as the real QuizStep.tsx flush-on-submit behavior.
        submit_payload = {
            "access_code_id": ACCESS_CODE_ID,
            "player_name": self.player_name,
            "answers": [
                {"question_id": a["question_id"], "selected_option_id": a["selected_option_id"]}
                for a in self.answer_plan
            ],
        }
        with self.client.post(
            "/api/play/submit", json=submit_payload, name="04_submit", catch_response=True
        ) as resp:
            if resp.status_code != 201:
                resp.failure(f"submit failed: {resp.status_code} {resp.text[:200]}")
                return
            resp.success()

        # 5. Confirm the player can immediately read back their own results
        # (the bookmarkable results-check flow every player is shown after submitting).
        with self.client.post(
            "/api/play/results",
            json={"code": CODE, "player_name": self.player_name},
            name="05_results",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"results failed: {resp.status_code} {resp.text[:200]}")
                return
            resp.success()

    @task
    def idle(self):
        # The scripted flow already ran once in on_start. This just keeps
        # the user "alive" without repeating the flow in a loop - Locust
        # requires at least one @task, and a long sleep here means nothing
        # fires again before --run-time ends the test.
        time.sleep(3600)
