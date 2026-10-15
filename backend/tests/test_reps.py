"""Situational Rep: "put me in the play, make me prove I know my job."

A Rep is a quiz with kind REP. What this file protects:

1. A Rep is created, sent and played through the ordinary routes - always one
   decision at a time, always practice-delivered (the immediate verdict and the
   coach's explanation exist only there) - and a plain quiz is unchanged.
2. A decision carries who the player IS ("Boundary safety") and the Motion Lab
   play it came from, and both survive a copy.
3. The coach's diagnostics name the FOOTBALL PROBLEM from each player's FIRST
   try: "Motion adjustment - 3 of 4 missed - most chose 'Stay boundary'", who
   missed it, what each answered.
4. Retest builds a new Rep from exactly that concept's decisions, for exactly
   the players who missed it.
"""

from app.extensions import db
from app.models import MotionPlay, Organization, Quiz
from app.models.assessment_mode import PRACTICE

PLAYERS = ["Ty Adams", "Bo Brown", "Cam Cole", "Dee Diaz"]


def _rep(client, headers, **extra):
    response = client.post(
        "/api/quizzes", json={"title": "Boundary safety: motion", "kind": "REP", **extra}, headers=headers
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _concept(client, headers, name):
    return client.post("/api/concepts", json={"name": name}, headers=headers).get_json()


def _decision(client, headers, quiz_id, text, options, *, concept=None, role=None, play_id=None, why=None):
    payload = {
        "question_text": text,
        "question_type": "multiple_choice",
        "options": [{"option_text": o, "is_correct_answer": i == 0} for i, o in enumerate(options)],
        "concept_id": concept["id"] if concept else None,
        "subject_role": role,
        "motion_play_id": play_id,
        "answer_explanation": why,
    }
    response = client.post(f"/api/quizzes/{quiz_id}/questions", json=payload, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _players(client, headers, quiz_id):
    ids = {}
    for name in PLAYERS:
        first, last = name.split(" ")
        player = client.post(
            "/api/players", json={"first_name": first, "last_name": last, "position": "S"}, headers=headers
        ).get_json()
        ids[name] = player["id"]
    client.post(
        f"/api/quizzes/{quiz_id}/roster/members", json={"player_ids": list(ids.values())}, headers=headers
    )
    return ids


def _send(client, headers, quiz_id, **payload):
    response = client.post(f"/api/quizzes/{quiz_id}/access-codes", json=payload, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _play(client, code, name, player_id, picks: dict, ms=2500):
    """One run of the Rep: answer and check each decision, as the player screen does."""
    started = client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": name, "player_id": player_id}
    )
    assert started.status_code in (200, 201), started.get_json()
    for question_id, option_id in picks.items():
        saved = client.post(
            "/api/play/answers",
            json={
                "access_code_id": code["id"],
                "player_name": name,
                "player_id": player_id,
                "question_id": question_id,
                "selected_option_id": option_id,
                "time_to_answer_ms": ms,
            },
        )
        assert saved.status_code == 204, saved.get_json()
        checked = client.post(
            "/api/play/check",
            json={"access_code_id": code["id"], "player_name": name, "player_id": player_id, "question_id": question_id},
        )
        assert checked.status_code == 200, checked.get_json()
    submitted = client.post(
        "/api/play/submit",
        json={
            "access_code_id": code["id"], "player_name": name, "player_id": player_id,
            "answers": [{"question_id": q, "selected_option_id": o} for q, o in picks.items()],
        },
    )
    assert submitted.status_code in (200, 201), submitted.get_json()
    return checked.get_json()


def _option(decision, text):
    return next(o["id"] for o in decision["options"] if o["option_text"] == text)


def _motion_play(app, organization_id, name="Trips Jet"):
    with app.app_context():
        play = MotionPlay(organization_id=organization_id, name=name, document={}, schema_version=3)
        db.session.add(play)
        db.session.commit()
        return play.id


def _built(client, headers, app, coach):
    """A two-decision boundary-safety Rep, sent, with four safeties on it."""
    rep = _rep(client, headers)
    motion = _concept(client, headers, "Motion adjustment")
    leverage = _concept(client, headers, "Leverage")
    play_id = _motion_play(app, coach["organization_id"])
    first = _decision(
        client, headers, rep["id"], "#3 motions across. What is your check?",
        ["Rotate down", "Stay boundary", "Bail deep"],
        concept=motion, role="Boundary safety", play_id=play_id,
        why="He is the new #3 - you rotate down to him.",
    )
    second = _decision(
        client, headers, rep["id"], "Where is your leverage?", ["Inside", "Outside"],
        concept=leverage, role="Boundary safety",
    )
    ids = _players(client, headers, rep["id"])
    code = _send(client, headers, rep["id"])
    return rep, first, second, ids, code, play_id


class TestARepIsAQuizKind:
    def test_a_rep_is_one_decision_at_a_time_and_a_plain_quiz_is_unchanged(self, client, coach_headers):
        rep = _rep(client, coach_headers, one_question_at_a_time=False)
        assert rep["kind"] == "REP"
        assert rep["one_question_at_a_time"] is True
        plain = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
        assert plain["kind"] == "QUIZ"

    def test_an_unknown_kind_is_refused(self, client, coach_headers):
        response = client.post("/api/quizzes", json={"title": "x", "kind": "DRILL"}, headers=coach_headers)
        assert response.status_code == 422

    def test_a_rep_always_goes_out_for_immediate_feedback(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        _decision(client, coach_headers, rep["id"], "Your check?", ["Rotate down", "Stay boundary"])
        _players(client, coach_headers, rep["id"])
        code = _send(client, coach_headers, rep["id"], mode="GRADED")
        assert code["mode"] == PRACTICE


class TestADecisionKnowsWhoAndWhere:
    def test_role_and_play_are_stored_shown_to_the_coach_and_only_the_role_to_the_player(
        self, client, register_coach, app
    ):
        coach, _, headers = register_coach()
        rep = _rep(client, headers)
        play_id = _motion_play(app, coach["organization_id"])
        made = _decision(
            client, headers, rep["id"], "Your check?", ["Rotate down", "Stay boundary"],
            role="  Boundary safety ", play_id=play_id,
        )
        assert made["subject_role"] == "Boundary safety"
        assert made["motion_play_id"] == play_id

        _players(client, headers, rep["id"])
        code = _send(client, headers, rep["id"])
        delivered = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        assert delivered["quiz"]["kind"] == "REP"
        question = delivered["quiz"]["questions"][0]
        assert question["subject_role"] == "Boundary safety"
        assert "motion_play_id" not in question

    def test_another_organizations_play_is_refused(self, client, coach_headers, app):
        with app.app_context():
            other = Organization(name="Rivals")
            db.session.add(other)
            db.session.commit()
            other_id = other.id
        foreign = _motion_play(app, other_id)
        rep = _rep(client, coach_headers)
        response = client.post(
            f"/api/quizzes/{rep['id']}/questions",
            json={
                "question_text": "Your check?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "A", "is_correct_answer": True}, {"option_text": "B"}],
                "motion_play_id": foreign,
            },
            headers=coach_headers,
        )
        assert response.status_code == 422

    def test_an_edit_can_set_and_clear_the_role_and_a_partial_edit_keeps_it(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = _decision(client, coach_headers, rep["id"], "Your check?", ["A", "B"], role="Mike")
        url = f"/api/quizzes/{rep['id']}/questions/{made['id']}"
        kept = client.patch(url, json={"question_text": "Your fit?"}, headers=coach_headers).get_json()
        assert kept["subject_role"] == "Mike"
        cleared = client.patch(url, json={"subject_role": ""}, headers=coach_headers).get_json()
        assert cleared["subject_role"] is None

    def test_a_copy_of_a_rep_is_a_rep_and_keeps_who_and_where(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep = _rep(client, headers)
        play_id = _motion_play(app, coach["organization_id"])
        _decision(client, headers, rep["id"], "Your check?", ["A", "B"], role="Boundary safety", play_id=play_id)
        copy = client.post(f"/api/quizzes/{rep['id']}/duplicate", headers=headers).get_json()
        assert copy["kind"] == "REP"
        assert copy["questions"][0]["subject_role"] == "Boundary safety"
        assert copy["questions"][0]["motion_play_id"] == play_id

    def test_deleting_the_play_keeps_the_decision(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep = _rep(client, headers)
        play_id = _motion_play(app, coach["organization_id"])
        made = _decision(client, headers, rep["id"], "Your check?", ["A", "B"], play_id=play_id)
        with app.app_context():
            db.session.delete(db.session.get(MotionPlay, play_id))
            db.session.commit()
        quiz = client.get(f"/api/quizzes/{rep['id']}", headers=headers).get_json()
        assert quiz["questions"][0]["id"] == made["id"]
        assert quiz["questions"][0]["motion_play_id"] is None


class TestDiagnostics:
    def test_names_the_football_problem_from_each_players_first_try(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, play_id = _built(client, headers, app, coach)
        rotate, stay, bail = (_option(first, t) for t in ("Rotate down", "Stay boundary", "Bail deep"))
        inside = _option(second, "Inside")

        feedback = _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: rotate, second["id"]: inside})
        assert feedback["is_correct"] is True
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Dee Diaz", ids["Dee Diaz"], {first["id"]: bail, second["id"]: inside})
        # Bo runs it again and gets it right - his FIRST try still counts.
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: rotate, second["id"]: inside})

        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        top = results["concepts"][0]
        assert top["name"] == "Motion adjustment"
        assert (top["missed"], top["responded"]) == (3, 4)
        assert top["most_common_wrong"]["text"] == "Stay boundary"
        assert top["most_common_wrong"]["count"] == 2
        assert [p["display_name"] for p in top["players_missed"]] == ["Bo Brown", "Cam Cole", "Dee Diaz"]
        assert top["players_missed"][2]["answers"][0]["chose"] == ["Bail deep"]
        assert top["motion_play_id"] == play_id
        assert results["concepts"][1]["name"] == "Leverage"
        assert results["concepts"][1]["missed"] == 0

        decision = results["decisions"][0]
        assert decision["subject_role"] == "Boundary safety"
        assert decision["correct_text"] == ["Rotate down"]
        assert decision["median_ms"] == 2500
        assert {c["text"]: c["count"] for c in decision["choices"]} == {
            "Rotate down": 1, "Stay boundary": 2, "Bail deep": 1,
        }

        bo = next(p for p in results["players"] if p["display_name"] == "Bo Brown")
        assert (bo["correct"], bo["answered"], bo["attempts"]) == (1, 2, 2)
        assert results["audience"]["invited"] == 4

    def test_a_player_who_answered_and_left_without_submitting_still_counts(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, _second, ids, code, _ = _built(client, headers, app, coach)
        name, pid = "Cam Cole", ids["Cam Cole"]
        client.post("/api/play/start", json={"access_code_id": code["id"], "player_name": name, "player_id": pid})
        client.post(
            "/api/play/answers",
            json={"access_code_id": code["id"], "player_name": name, "player_id": pid,
                  "question_id": first["id"], "selected_option_id": _option(first, "Stay boundary")},
        )
        client.post(
            "/api/play/check",
            json={"access_code_id": code["id"], "player_name": name, "player_id": pid, "question_id": first["id"]},
        )
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        assert results["concepts"][0]["missed"] == 1

    def test_a_plain_quiz_has_no_rep_results(self, client, coach_headers):
        plain = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
        response = client.get(f"/api/quizzes/{plain['id']}/rep-results", headers=coach_headers)
        assert response.status_code == 422

    def test_rep_answers_never_reach_the_official_results(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, _second, ids, code, _ = _built(client, headers, app, coach)
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: _option(first, "Stay boundary")})
        dashboard = client.get(f"/api/quizzes/{rep['id']}/dashboard", headers=headers).get_json()
        assert all(c["players_missed_count"] == 0 for c in dashboard["concept_breakdown"])


class TestRetest:
    def test_sends_the_missed_concept_back_to_exactly_the_players_who_missed_it(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, play_id = _built(client, headers, app, coach)
        rotate, stay = _option(first, "Rotate down"), _option(first, "Stay boundary")
        inside = _option(second, "Inside")
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: rotate, second["id"]: inside})
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})

        concept_id = first["concept"]["id"]
        response = client.post(f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": concept_id}, headers=headers)
        assert response.status_code == 201, response.get_json()
        retest = response.get_json()
        assert retest["kind"] == "REP"
        assert retest["title"] == "Motion adjustment - Retest"
        assert retest["player_count"] == 2
        assert retest["retest_of"]["id"] == rep["id"]

        full = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()
        assert [q["question_text"] for q in full["questions"]] == ["#3 motions across. What is your check?"]
        assert full["questions"][0]["subject_role"] == "Boundary safety"
        assert full["questions"][0]["motion_play_id"] == play_id

        # Activated with no groups, it admits exactly those two.
        sent = _send(client, headers, retest["id"])
        delivered = client.post("/api/play/validate-code", json={"code": sent["code"]}).get_json()
        names = sorted(p["name"] for p in delivered["roster_players_v2"])
        assert names == ["Bo Brown", "Cam Cole"]

    def test_nobody_to_retest_when_nobody_missed(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: _option(first, "Rotate down"),
                                                          second["id"]: _option(second, "Inside")})
        response = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": second["concept"]["id"]}, headers=headers
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "nobody_missed"
        with app.app_context():
            assert Quiz.query.filter_by(retest_of_quiz_id=rep["id"]).count() == 0
