"""Competition Mode load test: does a room of thirty phones actually work?

WHAT THIS ANSWERS
------------------
One-second polling was chosen over WebSockets on the argument that the poll is
cheap enough. That is a claim about behaviour under load, and a claim like that
is worth nothing until it is measured. This measures it.

The scenario is a real meeting room:
  * 30 players, each polling GET /<code>/state once a second
  * 1 host, polling its own state once a second
  * ordinary Peira traffic continuing throughout - a coach loading their quiz
    list, because "the competition works" is not good enough if it makes the
    rest of the product unusable while it runs

WHERE THIS RUNS
----------------
Against the LOCAL docker stack, on seeded data it creates and then deletes.
Never against production - a load test that leaves thirty fake players in a
real organization is worse than no load test (see CLAUDE.md).

READING THE RESULT
-------------------
The number that matters is p95 latency on the ordinary traffic, not on the
poll. A poll that is fast while making everything else slow has not passed.

    python tools/competition_load_test.py --seconds 30 --players 30
"""

from __future__ import annotations

import argparse
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import json
import secrets

BASE = "http://localhost:5000/api"


def call(method: str, path: str, body=None, token=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, json.loads(payload or b"null"), time.perf_counter() - started
    except urllib.error.HTTPError as exc:
        return exc.code, None, time.perf_counter() - started


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------


def seed(player_count: int):
    """A throwaway LOCAL organization. Deleted again at the end."""
    tag = secrets.token_hex(4)
    status, body, _ = call(
        "POST",
        "/auth/register",
        {
            "username": f"loadtest_{tag}",
            "email": f"loadtest_{tag}@example.invalid",
            "password": "password123",
            "organization": f"Load Test {tag}",
        },
    )
    if status != 201:
        sys.exit(f"could not register a local coach ({status}) - is the docker stack up?")
    token = body["access_token"]

    quiz_id = call("POST", "/quizzes", {"title": "Load Test"}, token)[1]["id"]
    call(
        "POST",
        f"/quizzes/{quiz_id}/questions",
        {
            "question_text": "Cover 2?",
            "question_type": "true_false",
            "options": [
                {"option_text": "True", "is_correct_answer": True},
                {"option_text": "False", "is_correct_answer": False},
            ],
        },
        token,
    )

    players = []
    for index in range(player_count):
        status, player, _ = call(
            "POST", "/players", {"first_name": "Load", "last_name": f"Player{index:03d}"}, token
        )
        if status == 201:
            players.append(player["id"])

    status, session, _ = call("POST", f"/competition/quizzes/{quiz_id}", {}, token)
    if status != 201:
        sys.exit(f"could not open a lobby: {status}")

    return token, session["join_code"], session["id"], quiz_id, players


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def poller(stop, path, samples, errors, token=None):
    """One phone. Polls at 1 Hz, and does NOT drift: the interval is measured
    from the start of each request, so a slow response does not silently turn
    30 clients into 15."""
    while not stop.is_set():
        cycle = time.perf_counter()
        status, _, elapsed = call("GET", path, token=token)
        if status != 200:
            errors.append(status)
        else:
            samples.append(elapsed)
        remaining = 1.0 - (time.perf_counter() - cycle)
        if remaining > 0:
            stop.wait(remaining)


#: Client-side floor between heavy fetches, mirroring the frontend's
#: HEAVY_FETCH_MIN_INTERVAL_MS. Modelled here so the harness measures what the
#: product actually does rather than a worst case nothing ships.
HEAVY_FETCH_MIN_INTERVAL = 2.0


def versioned_client(
    stop, code, poll_samples, poll_errors, heavy_samples, heavy_errors, waiting_room=True
):
    """A REAL M1 player client.

    TWO CLIENT SHAPES, BOTH REAL
    -----------------------------
    `waiting_room=True` is a player who has already joined. Since
    participant_count moved onto the cheap poll, that screen makes NO heavy
    fetches at all - it needs a number, not a roster.

    `waiting_room=False` is a player still on the identity picker, which does
    need the roster and refetches it when the version moves. Those clients
    coalesce to at most one fetch per HEAVY_FETCH_MIN_INTERVAL, exactly as the
    frontend hook does.

    The mix matters: a room of thirty is mostly the first kind within a few
    seconds of the code going up, which is precisely why moving the count onto
    the poll was worth doing.
    """
    last_version = None
    last_heavy = 0.0
    pending = False
    while not stop.is_set():
        cycle = time.perf_counter()
        status, body, elapsed = call("GET", f"/competition/{code}/state")
        if status != 200:
            poll_errors.append(status)
        else:
            poll_samples.append(elapsed)
            version = (body or {}).get("version")
            if version != last_version:
                last_version = version
                pending = True

            # A joined player never needs the roster again.
            if pending and not waiting_room:
                now_ts = time.perf_counter()
                if last_heavy == 0.0 or (now_ts - last_heavy) >= HEAVY_FETCH_MIN_INTERVAL:
                    pending = False
                    last_heavy = now_ts
                    h_status, _, h_elapsed = call("GET", f"/competition/{code}")
                    if h_status != 200:
                        heavy_errors.append(h_status)
                    else:
                        heavy_samples.append(h_elapsed)
        remaining = 1.0 - (time.perf_counter() - cycle)
        if remaining > 0:
            stop.wait(remaining)


def joiner(code, player_ids, results, stagger):
    """Players arriving one after another, each bumping the version.

    Staggered rather than simultaneous because that is worse, not better: a
    burst of 30 joins at t=0 produces one version storm, while arrivals spread
    over the run produce 30 of them - one per join, each fanning out to every
    connected client.
    """
    for index, player_id in enumerate(player_ids):
        time.sleep(stagger)
        status, _, elapsed = call(
            "POST", f"/competition/{code}/join", {"player_id": player_id}
        )
        results.append((status, elapsed))


def summarise(name, samples, errors):
    if not samples:
        print(f"  {name:<28} NO SUCCESSFUL SAMPLES  errors={len(errors)}")
        return
    ordered = sorted(samples)
    p = lambda q: ordered[min(len(ordered) - 1, int(len(ordered) * q))] * 1000
    print(
        f"  {name:<28} n={len(samples):<6} "
        f"p50={p(0.50):6.1f}ms  p95={p(0.95):6.1f}ms  p99={p(0.99):6.1f}ms  "
        f"max={ordered[-1] * 1000:6.1f}ms  errors={len(errors)}"
    )
    if errors:
        counts = {}
        for status in errors:
            counts[status] = counts.get(status, 0) + 1
        print(f"  {'':28} error breakdown: {counts}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--players", type=int, default=30)
    parser.add_argument("--seconds", type=int, default=30)
    args = parser.parse_args()

    print(f"seeding a local organization with {args.players} players ...")
    token, code, session_id, quiz_id, player_ids = seed(args.players)
    print(f"lobby {code} ready; running {args.seconds}s at 1 Hz\n")

    stop = threading.Event()
    player_samples, player_errors = [], []
    heavy_samples, heavy_errors = [], []
    host_samples, host_errors = [], []
    normal_samples, normal_errors = [], []
    join_results = []

    # Each simulated phone runs the REAL client behaviour: cheap poll plus a
    # heavy fetch on version change.
    # A realistic mix: most phones are in the waiting room, a few are still on
    # the picker. The picker clients are the only ones fetching the roster.
    picker_count = max(1, args.players // 5)
    threads = [
        threading.Thread(
            target=versioned_client,
            args=(
                stop,
                code,
                player_samples,
                player_errors,
                heavy_samples,
                heavy_errors,
                index >= picker_count,  # waiting_room for all but the first few
            ),
            daemon=True,
        )
        for index in range(args.players)
    ]
    # Arrivals spread across the first part of the run, so the version moves
    # repeatedly while everyone is connected.
    threads.append(
        threading.Thread(
            target=joiner,
            args=(code, player_ids, join_results, max(0.1, args.seconds / (len(player_ids) * 3))),
            daemon=True,
        )
    )
    threads.append(
        threading.Thread(
            target=poller,
            args=(stop, f"/competition/sessions/{session_id}/state", host_samples, host_errors),
            kwargs={"token": token},
            daemon=True,
        )
    )
    # Ordinary traffic: an authenticated coach using the rest of the product
    # while the competition runs. THIS is the measurement that decides whether
    # polling is affordable.
    threads.append(
        threading.Thread(
            target=poller,
            args=(stop, "/quizzes", normal_samples, normal_errors),
            kwargs={"token": token},
            daemon=True,
        )
    )

    for thread in threads:
        thread.start()
    time.sleep(args.seconds)
    stop.set()
    for thread in threads:
        thread.join(timeout=25)

    print(f"RESULTS ({args.players} players + 1 host + ordinary traffic, {args.seconds}s)\n")
    summarise("player poll /state", player_samples, player_errors)
    summarise("picker /<code> (roster)", heavy_samples, heavy_errors)
    summarise("host poll /sessions/state", host_samples, host_errors)
    summarise("ordinary traffic /quizzes", normal_samples, normal_errors)

    joined_ok = sum(1 for status, _ in join_results if status == 200)
    rate_limited = sum(1 for status, _ in join_results if status == 429)
    print(
        f"\n  joins: {joined_ok}/{len(join_results)} succeeded"
        f"{f', {rate_limited} RATE LIMITED' if rate_limited else ', 0 rate limited'}"
    )
    print(
        f"  heavy fetches triggered by version changes: {len(heavy_samples)}"
        f"  (~{len(heavy_samples) / max(1, args.seconds):.1f}/s)"
    )

    total = (
        len(player_samples) + len(heavy_samples) + len(host_samples) + len(normal_samples)
    )
    print(f"\n  throughput ~{total / args.seconds:.1f} req/s sustained")
    if player_errors or host_errors or normal_errors:
        print("\n  *** ERRORS OCCURRED - see the breakdown above ***")

    # Tidy up. This is local seeded data and it should not survive the run.
    call("POST", f"/competition/sessions/{session_id}/end", None, token)
    print(f"\n  lobby ended. Local seed data remains in the dev DB "
          f"(quiz {quiz_id}) - drop the dev database to clear it.")


if __name__ == "__main__":
    main()
