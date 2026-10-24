"""THE CONNECTED SCREENS MUST NOT COST A QUERY PER PLAYER OR PER QUESTION.

Results' weakest concepts, Home's Next up and an install's meeting all read
the quiz dashboard; Home polls "what is live". With an 80-120 player roster an
N+1 on any of them is the difference between a page and a wait - so, as in
test_multi_select_results_performance, the SAME request runs against a small
and a large fixture and the query count may not grow with the data.
"""

from sqlalchemy import event

from app.extensions import db


class _Counted(int):
    """A query count that, when it is wrong, says which statements repeat."""

    statements: list[str]

    def __new__(cls, statements):
        made = super().__new__(cls, len(statements))
        made.statements = statements
        return made

    def repeats(self) -> str:
        tally: dict[str, int] = {}
        for s in self.statements:
            head = " ".join(s.split())[:110]
            tally[head] = tally.get(head, 0) + 1
        return "; ".join(f"{n}x {h}" for h, n in sorted(tally.items(), key=lambda kv: -kv[1]) if n > 1)


def _count_queries(fn):
    seen = []

    def _listener(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(db.engine, "before_cursor_execute", _listener)
    try:
        result = fn()
    finally:
        event.remove(db.engine, "before_cursor_execute", _listener)
    return result, _Counted(seen)


def _concept(client, headers, name):
    made = client.post("/api/concepts", json={"name": name}, headers=headers)
    assert made.status_code == 201, made.get_json()
    return made.get_json()["id"]


def _quiz(client, headers, *, questions: int, players: list[str], concept_ids: list[int], groups: bool = False):
    """A quiz whose questions are tagged with concepts, sent to a roster (or a
    group), and run by every player - each missing the first question, so the
    weakest concept names who missed it and what they chose."""
    quiz = client.post("/api/quizzes", json={"title": f"Perf {questions}x{len(players)}"}, headers=headers).get_json()
    created = []
    for i in range(questions):
        made = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Who has force {i}?",
                "question_type": "multiple_choice",
                "concept_id": concept_ids[i % len(concept_ids)],
                "options": [{"option_text": t, "is_correct_answer": t == "A"} for t in ["A", "B", "C", "D"]],
            },
            headers=headers,
        )
        assert made.status_code == 201, made.get_json()
        created.append(made.get_json())
    ids: dict[str, int] = {}
    if groups:
        # Canonical master-roster players in a group: the path that reads each
        # GroupPlayer's Player.
        for name in players:
            first, last = name.split(" ", 1)
            made = client.post("/api/players", json={"first_name": first, "last_name": last}, headers=headers)
            assert made.status_code == 201, made.get_json()
            ids[name] = made.get_json()["id"]
        group = client.post("/api/groups", json={"name": f"Defense {quiz['id']}"}, headers=headers).get_json()
        added = client.post(f"/api/groups/{group['id']}/members", json={"player_ids": list(ids.values())}, headers=headers)
        assert added.status_code in (200, 201), added.get_json()
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]]}, headers=headers)
    else:
        client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": players}, headers=headers)
        code = client.post(f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=headers)
    assert code.status_code == 201, code.get_json()
    code = code.get_json()
    for player in players:
        who = {"player_name": player, **({"player_id": ids[player]} if player in ids else {})}
        started = client.post("/api/play/start", json={"access_code_id": code["id"], **who})
        assert started.status_code in (200, 201), started.get_json()
        payload = []
        for n, question in enumerate(created):
            # Everyone misses the first question, choosing B or C - a real distractor.
            pick = ("B" if len(payload) % 2 else "C") if n == 0 else "A"
            option = next(o["id"] for o in question["options"] if o["option_text"] == pick)
            payload.append({"question_id": question["id"], "selected_option_id": option, "answer_text": None})
        submitted = client.post(
            "/api/play/submit", json={"access_code_id": code["id"], **who, "answers": payload}
        )
        assert submitted.status_code == 201, submitted.get_json()
    return quiz["id"]


def _players(n, tag):
    return [f"Player {tag}x{i}" for i in range(n)]


class TestTheDashboardIsFlat:
    def test_weakest_concepts_do_not_cost_a_query_per_player_or_question(self, client, coach_headers):
        concepts = [_concept(client, coach_headers, "Force / Contain"), _concept(client, coach_headers, "Run fit")]
        small = _quiz(client, coach_headers, questions=2, players=_players(2, "s"), concept_ids=concepts)
        large = _quiz(client, coach_headers, questions=8, players=_players(9, "l"), concept_ids=concepts)

        def fetch(quiz_id):
            got = client.get(f"/api/quizzes/{quiz_id}/dashboard", headers=coach_headers)
            assert got.status_code == 200, got.get_json()
            body = got.get_json()
            # THE PRECONDITION: the breakdown really named who missed, and what they chose.
            weakest = body["concept_breakdown"][0]
            assert weakest["players_missed_count"] > 0
            assert weakest["players_missed"]
            return body

        _, small_count = _count_queries(lambda: fetch(small))
        _, large_count = _count_queries(lambda: fetch(large))
        assert large_count == small_count, f"dashboard: {small_count} -> {large_count} queries ({large_count.repeats()})"

    def test_a_group_audience_does_not_cost_a_query_per_player(self, client, coach_headers):
        concepts = [_concept(client, coach_headers, "Leverage")]
        small = _quiz(client, coach_headers, questions=2, players=_players(2, "gs"), concept_ids=concepts, groups=True)
        large = _quiz(client, coach_headers, questions=2, players=_players(9, "gl"), concept_ids=concepts, groups=True)

        def fetch(quiz_id):
            got = client.get(f"/api/quizzes/{quiz_id}/dashboard", headers=coach_headers)
            assert got.status_code == 200, got.get_json()
            return got.get_json()

        _, small_count = _count_queries(lambda: fetch(small))
        _, large_count = _count_queries(lambda: fetch(large))
        assert large_count == small_count, f"dashboard (group): {small_count} -> {large_count} queries"


class TestWhatIsLiveIsFlat:
    def test_homes_live_poll_does_not_cost_a_query_per_player(self, client, coach_headers):
        concepts = [_concept(client, coach_headers, "Motion adjustment")]
        _quiz(client, coach_headers, questions=1, players=_players(2, "as"), concept_ids=concepts, groups=True)
        _, small_count = _count_queries(lambda: client.get("/api/quizzes/active-status", headers=coach_headers))
        _quiz(client, coach_headers, questions=1, players=_players(9, "al"), concept_ids=concepts, groups=True)
        got, large_count = _count_queries(lambda: client.get("/api/quizzes/active-status", headers=coach_headers))
        assert got.status_code == 200
        # A second live quiz may cost its own constant few; never one per player.
        assert large_count - small_count <= 3, f"active-status: {small_count} -> {large_count} queries"


class TestARoomsNeedsAreFlat:
    def test_what_a_position_room_needs_does_not_grow_with_his_quizzes_or_players(self, client, coach_headers):
        """/players/needs reads every quiz the coach has - which grows all
        season. More quizzes and more players may not mean more queries."""
        concepts = [_concept(client, coach_headers, "Cover 3"), _concept(client, coach_headers, "Run fit")]

        def room(tag, quizzes, players):
            names = _players(players, tag)
            for n in range(quizzes):
                _quiz(client, coach_headers, questions=2, players=names[:], concept_ids=concepts, groups=True)
                # each quiz made fresh canonical players; reuse the last set's ids below
            return names

        def needs_for(ids):
            got = client.get(f"/api/players/needs?ids={','.join(str(i) for i in ids)}", headers=coach_headers)
            assert got.status_code == 200, got.get_json()
            body = got.get_json()
            assert body["concepts"], body  # PRECONDITION: they really are missing something
            return body

        def player_ids():
            listed = client.get("/api/players", headers=coach_headers).get_json()
            return [p["id"] for p in listed]

        room("na", quizzes=1, players=2)
        _, small_count = _count_queries(lambda: needs_for(player_ids()))
        room("nb", quizzes=3, players=4)
        _, large_count = _count_queries(lambda: needs_for(player_ids()))
        assert large_count == small_count, f"players/needs: {small_count} -> {large_count} queries ({large_count.repeats()})"
