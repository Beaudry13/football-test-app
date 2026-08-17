"""Multi-Select M4 - THE SELECTION SETS MUST NOT COST A QUERY EACH.

WHY A SCALE-INVARIANT TEST RATHER THAN A CEILING
------------------------------------------------
A flat number ("under 20 queries") passes on a small fixture and says nothing
about an N+1 - the whole point of an N+1 is that it is invisible until the data
grows. These tests run the SAME request against a small and a large quiz and
assert the query count did not move. A per-answer lazy load fails that
immediately, and it fails by a margin that names itself: the difference is
exactly the number of extra answers.

WHAT WOULD REGRESS WITHOUT THEM
-------------------------------
`Answer.to_dict` now emits `selected_option_ids`, and three display paths now
resolve a set. Each one walks `answer.selected_options`, which lazy-loads once
per answer unless the route eager-loads it - on the Results tab, the CSV, the
detailed PDF and the player's own results page, all of which load an entire
roster's answers at once.
"""

import pytest
from sqlalchemy import event

from app.extensions import db

PLAYER = "Jordan Smith"
#: Selected on EVERY question, so the number of selection rows grows with the
#: quiz rather than staying constant while only the answer count moves.
PICKED = ["A", "C", "D"]


def _make_quiz(client, headers, *, questions: int, players: list[str]):
    quiz = client.post(
        "/api/quizzes", json={"title": f"Perf {questions}x{len(players)}"}, headers=headers
    ).get_json()
    created = []
    for i in range(questions):
        made = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Who is in pressure {i}?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "options": [
                    {"option_text": t, "is_correct_answer": t in ("A", "C")}
                    for t in ["A", "B", "C", "D", "E"]
                ],
            },
            headers=headers,
        )
        assert made.status_code == 201, made.get_json()
        created.append(made.get_json())
    client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": players}, headers=headers
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers
    )
    assert code.status_code == 201, code.get_json()
    code = code.get_json()

    for player in players:
        client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": player},
        )
        payload = []
        for question in created:
            ids = [
                o["id"] for o in question["options"] if o["option_text"] in PICKED
            ]
            saved = client.post(
                "/api/play/answers",
                json={
                    "access_code_id": code["id"],
                    "player_name": player,
                    "question_id": question["id"],
                    "selected_option_id": None,
                    "selected_option_ids": ids,
                    "answer_text": None,
                },
            )
            assert saved.status_code == 204, saved.get_json()
            payload.append(
                {
                    "question_id": question["id"],
                    "selected_option_id": None,
                    "selected_option_ids": ids,
                    "answer_text": None,
                }
            )
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": player,
                "answers": payload,
            },
        )
        assert submitted.status_code == 201, submitted.get_json()

    return {"quiz_id": quiz["id"], "code": code}


def _count_queries(fn):
    seen = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(db.engine, "before_cursor_execute", _listener)
    try:
        result = fn()
    finally:
        event.remove(db.engine, "before_cursor_execute", _listener)
    return result, len(seen)


def _assert_flat(small_count, large_count, *, label, extra_answers):
    """The count may not grow with the data. AT ALL, at these sizes.

    THE TOLERANCE USED TO BE +3 AND THAT WAS TOO LOOSE TO BE USEFUL. The
    selection sets were first eager-loaded with `selectinload`, which chunks
    parent keys 500 at a time - so the count grew by one query per 500 answers.
    A +3 bound passed that happily here and only failed in the detailed
    export's own guard at 2000 answers. Joining the selections onto the answers
    query instead costs zero queries at any size, so the honest bound is zero.

    Above ~500 answers a route may still gain a query per chunk from a loader
    that legitimately batches (`Answer.drawing` does, because repeating a
    megabyte of strokes across joined rows would be the worse trade). Both
    sizes here are under that boundary, so this asserts what it can actually
    see rather than a flatness it has not measured.
    """
    assert large_count == small_count, (
        f"{label}: {small_count} -> {large_count} queries for {extra_answers} "
        f"more answers - the loading strategy grows with the data"
    )


class TestPlayerResultsIsFlat:
    def test_one_players_results_do_not_cost_a_query_per_answer(
        self, client, coach_headers
    ):
        small = _make_quiz(client, coach_headers, questions=3, players=[PLAYER])
        large = _make_quiz(client, coach_headers, questions=15, players=[PLAYER])

        def fetch(fixture):
            got = client.post(
                "/api/play/results",
                json={"code": fixture["code"]["code"], "player_name": PLAYER},
            )
            assert got.status_code == 200, got.get_json()
            body = got.get_json()
            # THE PRECONDITION. Without it this passes just as well against a
            # request that returned nothing and therefore resolved nothing.
            assert len(body["answers"]) in (3, 15)
            assert body["answers"][0]["your_answer"] == "A; C; D"
            return body

        _, small_queries = _count_queries(lambda: fetch(small))
        _, large_queries = _count_queries(lambda: fetch(large))

        assert small_queries > 0
        _assert_flat(
            small_queries, large_queries, label="/play/results", extra_answers=12
        )


class TestCoachSurfacesAreFlat:
    @pytest.fixture
    def sizes(self, client, coach_headers):
        small = _make_quiz(
            client, coach_headers, questions=3, players=["Small One", "Small Two"]
        )
        large = _make_quiz(
            client,
            coach_headers,
            questions=15,
            players=[f"Large {i}" for i in range(8)],
        )
        return small, large

    def test_the_responses_list_does_not_cost_a_query_per_answer(
        self, client, coach_headers, sizes
    ):
        small, large = sizes

        def fetch(fixture, expected_players):
            got = client.get(
                f"/api/quizzes/{fixture['quiz_id']}/responses", headers=coach_headers
            )
            assert got.status_code == 200
            body = got.get_json()
            assert len(body) == expected_players
            # Proves the payload really did resolve every selection set - the
            # field this test exists to keep cheap.
            assert len(body[0]["answers"][0]["selected_option_ids"]) == 3
            return body

        _, small_queries = _count_queries(lambda: fetch(small, 2))
        _, large_queries = _count_queries(lambda: fetch(large, 8))

        assert small_queries > 0
        # 6 answers -> 120. A lazy load would add 114 queries.
        _assert_flat(
            small_queries, large_queries, label="/responses", extra_answers=114
        )

    def test_the_csv_does_not_cost_a_query_per_answer(
        self, client, coach_headers, sizes
    ):
        small, large = sizes

        def fetch(fixture, expected_rows):
            got = client.get(
                f"/api/quizzes/{fixture['quiz_id']}/export.csv", headers=coach_headers
            )
            assert got.status_code == 200
            body = got.get_data(as_text=True)
            assert body.count("A; C; D") == expected_rows
            return body

        _, small_queries = _count_queries(lambda: fetch(small, 6))
        _, large_queries = _count_queries(lambda: fetch(large, 120))

        assert small_queries > 0
        _assert_flat(small_queries, large_queries, label="export.csv", extra_answers=114)

    def test_the_detailed_pdf_does_not_cost_a_query_per_answer(
        self, client, coach_headers, sizes
    ):
        small, large = sizes

        def fetch(fixture):
            got = client.get(
                f"/api/quizzes/{fixture['quiz_id']}/export-detailed.pdf",
                headers=coach_headers,
            )
            assert got.status_code == 200
            assert got.get_data()[:5] == b"%PDF-"
            return got

        _, small_queries = _count_queries(lambda: fetch(small))
        _, large_queries = _count_queries(lambda: fetch(large))

        assert small_queries > 0
        _assert_flat(
            small_queries, large_queries, label="export-detailed.pdf", extra_answers=114
        )
