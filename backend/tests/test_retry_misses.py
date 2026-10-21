"""TRY THE MISSES AGAIN: a practice attempt holding only an earlier run's misses.

After a practice run - a Rep or a practice quiz - a player can start a new
practice attempt with just the questions he missed, through the same /start
and /claim every attempt uses. What this file protects:

1. THE SERVER DECIDES WHAT IS RETRIED. The client names one of HIS finished
   practice runs on THIS code; the misses are read from that run. Anyone
   else's run, another code's, an unfinished one, or a graded one is refused.
2. THE RUN IT RETRIES IS NEVER TOUCHED, and a graded attempt is never retried
   from the player's side at all (an assessment; a coach sends a Retest).
3. A RETRY IS LEARNING, NOT A RUN. It is left out of every run-level reading
   of a Rep - the coach's results, first tries, his "since last time".
4. Its delivery is exactly its misses: nothing added to the quiz later, and
   nothing retired, ever joins it.
"""

from types import SimpleNamespace

import pytest

from app.extensions import db
from app.models import PlayerAttempt
from app.services.attempts import delivery_question_ids
from app.services.rep_results import rep_attempts

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def _quiz(client, headers, title="Install", kind=None, n=3):
    body = {"title": title, **({"kind": kind} if kind else {})}
    quiz = client.post("/api/quizzes", json=body, headers=headers).get_json()
    questions = []
    for i in range(n):
        made = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": f"Decision {i + 1}?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "Right", "is_correct_answer": True}, {"option_text": "Wrong"}],
                "answer_explanation": f"Because {i + 1}.",
            },
            headers=headers,
        )
        assert made.status_code == 201, made.get_json()
        questions.append(made.get_json())
    client.put(f"/api/quizzes/{quiz['id']}/roster", json={"players": [PLAYER, OTHER]}, headers=headers)
    return quiz, questions


def _code(client, headers, quiz_id, mode="PRACTICE"):
    made = client.post(f"/api/quizzes/{quiz_id}/access-codes", json={"mode": mode}, headers=headers)
    assert made.status_code == 201, made.get_json()
    return made.get_json()


def _start(client, code, player=PLAYER, **extra):
    return client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": player, **extra})


def _option(delivered, question_id, text):
    q = next(q for q in delivered["questions"] if q["id"] == question_id)
    return next(o["id"] for o in q["options"] if o["option_text"] == text)


def _run(client, code, questions, wrong, player=PLAYER):
    """One finished run: `wrong` are the indexes he misses."""
    started = _start(client, code, player)
    assert started.status_code in (200, 201), started.get_json()
    state = started.get_json()
    answers = [
        {
            "question_id": q["id"],
            "selected_option_id": _option(state, q["id"], "Wrong" if i in wrong else "Right"),
            "answer_text": None,
        }
        for i, q in enumerate(questions)
        if any(d["id"] == q["id"] for d in state["questions"])
    ]
    submitted = client.post(
        "/api/play/submit", json={"access_code_id": code["id"], "player_name": player, "answers": answers}
    )
    assert submitted.status_code in (200, 201), submitted.get_json()
    return state["attempt_id"]


class TestARetryHoldsOnlyTheMisses:
    def test_a_practice_quiz_retry_is_his_misses_in_the_order_he_met_them(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        first = _run(client, code, qs, wrong={1, 2})

        retry = _start(client, code, retry_of_attempt_id=first)
        assert retry.status_code == 201, retry.get_json()
        state = retry.get_json()
        assert state["is_retry"] is True
        assert state["question_order"] == [qs[1]["id"], qs[2]["id"]]
        assert [q["id"] for q in state["questions"]] == [qs[1]["id"], qs[2]["id"]]
        assert state["mode"] == "PRACTICE"
        # The same football: text and choices exactly as the questions have them.
        assert [o["option_text"] for o in state["questions"][0]["options"]] == ["Right", "Wrong"]

    def test_the_run_it_retries_is_untouched(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        first = _run(client, code, qs, wrong={0})
        before = db.session.get(PlayerAttempt, first)
        verdicts = sorted((a.question_id, a.is_correct) for a in before.answers)
        assert _start(client, code, retry_of_attempt_id=first).status_code == 201
        db.session.expire_all()
        after = db.session.get(PlayerAttempt, first)
        assert after.status.value == "submitted"
        assert sorted((a.question_id, a.is_correct) for a in after.answers) == verdicts
        assert after.retry_of_attempt_id is None

    def test_an_ordinary_start_is_unchanged(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        _run(client, code, qs, wrong={0})
        again = _start(client, code).get_json()
        assert again["is_retry"] is False
        assert len(again["questions"]) == 3

    def test_a_retry_of_a_retry_holds_what_the_retry_missed(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        first = _run(client, code, qs, wrong={0, 2})
        retry_state = _start(client, code, retry_of_attempt_id=first).get_json()
        # On the retry he gets the first right and the third wrong again.
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {"question_id": qs[0]["id"], "selected_option_id": _option(retry_state, qs[0]["id"], "Right"), "answer_text": None},
                    {"question_id": qs[2]["id"], "selected_option_id": _option(retry_state, qs[2]["id"], "Wrong"), "answer_text": None},
                ],
            },
        )
        assert submitted.status_code in (200, 201)
        again = _start(client, code, retry_of_attempt_id=retry_state["attempt_id"]).get_json()
        assert again["question_order"] == [qs[2]["id"]]


class TestWhatIsRefused:
    def test_a_graded_attempt_is_never_retried_from_the_players_side(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"], mode="GRADED")
        first = _run(client, code, qs, wrong={0})
        refused = _start(client, code, retry_of_attempt_id=first)
        assert refused.status_code in (409, 422)
        assert db.session.query(PlayerAttempt).filter_by(access_code_id=code["id"]).count() == 1

    def test_another_players_run_is_refused(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        theirs = _run(client, code, qs, wrong={0}, player=OTHER)
        refused = _start(client, code, PLAYER, retry_of_attempt_id=theirs)
        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "retry_not_available"

    def test_another_codes_run_is_refused(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        one = _code(client, coach_headers, quiz["id"])
        first = _run(client, one, qs, wrong={0})
        # A new code (which retires the old one) cannot retry the old code's run.
        two = _code(client, coach_headers, quiz["id"])
        refused = _start(client, two, retry_of_attempt_id=first)
        assert refused.status_code == 422

    def test_nothing_missed_means_nothing_to_retry(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        clean = _run(client, code, qs, wrong=set())
        refused = _start(client, code, retry_of_attempt_id=clean)
        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "nothing_to_retry"

    def test_an_attempt_underway_is_handed_back_as_always(self, client, coach_headers):
        quiz, qs = _quiz(client, coach_headers)
        code = _code(client, coach_headers, quiz["id"])
        first = _run(client, code, qs, wrong={0})
        underway = _start(client, code).get_json()
        resumed = _start(client, code, retry_of_attempt_id=first)
        assert resumed.status_code == 200
        assert resumed.get_json()["attempt_id"] == underway["attempt_id"]
        assert resumed.get_json()["is_retry"] is False


class TestARetryIsLearningNotARun:
    def test_rep_run_readings_leave_it_out(self, client, coach_headers):
        rep, qs = _quiz(client, coach_headers, title="Trips Jet", kind="REP", n=2)
        code = _code(client, coach_headers, rep["id"])
        first = _run(client, code, qs, wrong={0, 1})
        retry_state = _start(client, code, retry_of_attempt_id=first).get_json()
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": PLAYER,
                "answers": [
                    {"question_id": q["id"], "selected_option_id": _option(retry_state, q["id"], "Right"), "answer_text": None}
                    for q in qs
                ],
            },
        )
        from app.models import Quiz

        quiz = db.session.get(Quiz, rep["id"])
        # Only the real run: the coach's results, first tries and his
        # "since last time" (player_progress) all read through rep_attempts.
        ids = [a.id for a in rep_attempts(quiz)]
        assert ids == [first]
        assert retry_state["attempt_id"] not in [a.id for a in rep_attempts(quiz, player_id=None)]


class TestDeliveryUnit:
    def test_a_retry_never_picks_up_the_rest_of_the_quiz(self, monkeypatch):
        import app.services.attempts as attempts

        monkeypatch.setattr(attempts, "deliverable_question_ids", lambda quiz: [1, 2, 3, 4])
        retry = SimpleNamespace(question_order=[3, 9], retry_of_attempt_id=7)
        ordinary = SimpleNamespace(question_order=[3, 9], retry_of_attempt_id=None)
        # A retired or deleted miss (9) falls out; nothing else ever joins.
        assert delivery_question_ids(retry, None) == [3]
        # An ordinary frozen order still picks up what was added since.
        assert delivery_question_ids(ordinary, None) == [3, 1, 2, 4]


class TestThroughClaim:
    """A player who proves himself - PIN, then the token his device holds -
    gets the same retry, by the same rules."""

    def _env(self, client, headers):
        player = client.post("/api/players", json={"first_name": "John", "last_name": "Smith"}, headers=headers).get_json()
        pin = client.post(f"/api/players/{player['id']}/pin/reset", headers=headers).get_json()["issued"]["pin"]
        quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=headers).get_json()
        qs = [
            client.post(
                f"/api/quizzes/{quiz['id']}/questions",
                json={"question_text": f"Cover {i}?", "question_type": "true_false", "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False}]},
                headers=headers,
            ).get_json()
            for i in (2, 3)
        ]
        group = client.post("/api/groups", json={"name": "Squad"}, headers=headers).get_json()
        client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=headers)
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": [group["id"]], "mode": "PRACTICE"}, headers=headers
        ).get_json()
        return player, pin, qs, code

    def test_pin_then_token_retry(self, client, coach_headers):
        player, pin, qs, code = self._env(client, coach_headers)
        claimed = client.post("/api/play/claim", json={"access_code_id": code["id"], "player_id": player["id"], "pin": pin})
        assert claimed.status_code == 201, claimed.get_json()
        body = claimed.get_json()
        header, token = body["token_header"], body["attempt_token"]
        state = body["attempt"]
        wrong = {q["id"]: next(o["id"] for o in q["options"] if o["option_text"] == "False") for q in state["questions"]}
        submitted = client.post(
            "/api/play/submit",
            json={
                "access_code_id": code["id"],
                "player_name": player["full_name"] if "full_name" in player else "John Smith",
                "player_id": player["id"],
                "answers": [{"question_id": qs[0]["id"], "selected_option_id": wrong[qs[0]["id"]], "answer_text": None}],
            },
            headers={header: token},
        )
        assert submitted.status_code in (200, 201), submitted.get_json()

        retry = client.post(
            "/api/play/claim",
            json={"access_code_id": code["id"], "player_id": player["id"], "retry_of_attempt_id": state["attempt_id"]},
            headers={header: token},
        )
        assert retry.status_code == 201, retry.get_json()
        again = retry.get_json()
        assert again["attempt"]["is_retry"] is True
        # Missed one, left one blank: only the miss is retried.
        assert again["attempt"]["question_order"] == [qs[0]["id"]]
        assert again["attempt_token"] and again["attempt_token"] != token
