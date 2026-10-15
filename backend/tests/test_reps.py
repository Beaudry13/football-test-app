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


class TestDidItStick:
    def test_a_retest_says_how_many_missed_the_concept_before(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, rotate = _option(first, "Stay boundary"), _option(first, "Rotate down")
        inside = _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})
        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        again = next(o["id"] for o in copied["options"] if o["option_text"] == "Rotate down")
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: again})

        results = client.get(f"/api/quizzes/{retest['id']}/rep-results", headers=headers).get_json()
        assert results["retest_of"]["id"] == rep["id"]
        stuck = results["retest_of"]["concepts"][0]
        assert stuck["name"] == "Motion adjustment"
        assert (stuck["missed_before"], stuck["responded_before"]) == (2, 2)
        assert (results["concepts"][0]["missed"], results["concepts"][0]["responded"]) == (0, 1)
        assert rotate  # the original's answer key is untouched

    def test_the_original_shows_each_problem_s_retest_and_how_it_went(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})
        before = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        assert before["concepts"][0]["retest"] is None

        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        still = next(o["id"] for o in copied["options"] if o["option_text"] == "Stay boundary")
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: still})

        after = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        motion = next(c for c in after["concepts"] if c["name"] == "Motion adjustment")
        assert motion["retest"] == {
            "id": retest["id"], "title": "Motion adjustment - Retest", "invited": 2, "ran": 1, "responded": 1, "missed": 1,
        }
        leverage = next(c for c in after["concepts"] if c["name"] == "Leverage")
        assert leverage["retest"] is None

    def test_an_ordinary_rep_is_not_a_retest(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, *_ = _built(client, headers, app, coach)
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        assert results["retest_of"] is None


class TestMakeRepFromAQuiz:
    def _quiz(self, client, headers):
        quiz = client.post("/api/quizzes", json={"title": "Week 3 install"}, headers=headers).get_json()
        concept = _concept(client, headers, "Coverage ID")
        tap = _decision(client, headers, quiz["id"], "Identify the coverage.", ["Cover 3", "Cover 2"], concept=concept,
                        why="One deep.")
        written = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Describe your fit.", "question_type": "written", "options": []},
            headers=headers,
        ).get_json()
        return quiz, tap, written

    def test_copies_the_tap_an_answer_questions_into_a_new_rep_and_leaves_the_quiz_alone(self, client, coach_headers):
        quiz, tap, _written = self._quiz(client, coach_headers)
        response = client.post(f"/api/quizzes/{quiz['id']}/make-rep", json={}, headers=coach_headers)
        assert response.status_code == 201, response.get_json()
        rep = response.get_json()
        assert rep["kind"] == "REP"
        assert rep["title"] == "Week 3 install - Rep"
        assert rep["left_behind"] == 1
        full = client.get(f"/api/quizzes/{rep['id']}", headers=coach_headers).get_json()
        assert [q["question_text"] for q in full["questions"]] == ["Identify the coverage."]
        assert full["questions"][0]["concept"]["name"] == "Coverage ID"
        assert full["questions"][0]["answer_explanation"] == "One deep."
        assert client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["question_count"] == 2

    def test_refuses_a_question_a_rep_cannot_judge(self, client, coach_headers):
        quiz, _tap, written = self._quiz(client, coach_headers)
        response = client.post(
            f"/api/quizzes/{quiz['id']}/make-rep", json={"question_ids": [written["id"]]}, headers=coach_headers
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "question_not_tappable"


class TestHomeSummary:
    def test_the_latest_reps_each_with_its_worst_football_problem(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        client.post("/api/quizzes", json={"title": "Install"}, headers=headers)  # a quiz is not a rep

        summary = client.get("/api/quizzes/reps-summary", headers=headers).get_json()
        assert [s["id"] for s in summary] == [rep["id"]]
        top = summary[0]
        assert (top["decisions"], top["ran"], top["invited"], top["live"]) == (2, 1, 4, True)
        assert top["worst"] == {
            "name": "Motion adjustment", "concept_id": first["concept"]["id"], "missed": 1, "responded": 1,
            "most_common_wrong": "Stay boundary",
        }

    def test_retests_are_summarised_by_how_they_went(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        rotate = _option(first, "Rotate down")
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: rotate, second["id"]: inside})
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})
        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        again = {o["option_text"]: o["id"] for o in copied["options"]}
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: again["Rotate down"]})
        _play(client, sent, "Cam Cole", ids["Cam Cole"], {copied["id"]: again["Stay boundary"]})

        summary = {s["id"]: s for s in client.get("/api/quizzes/reps-summary", headers=headers).get_json()}
        assert summary[retest["id"]]["signal"] == {
            "kind": "retest_missing", "concept": "Motion adjustment", "missed": 1, "responded": 2,
            "before_pct": 33, "now_pct": 50,
        }
        assert summary[rep["id"]]["signal"]["kind"] == "retested"
        assert summary[rep["id"]]["signal"]["retest_id"] == retest["id"]

    def test_another_organizations_reps_are_not_shown(self, client, register_coach, app):
        coach, _, headers = register_coach()
        _built(client, headers, app, coach)
        _, _, other = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert client.get("/api/quizzes/reps-summary", headers=other).get_json() == []

    def test_the_live_board_says_rep(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, *_ = _built(client, headers, app, coach)
        live = client.get("/api/quizzes/active-status", headers=headers).get_json()
        assert [(e["quiz_id"], e["quiz_kind"]) for e in live] == [(rep["id"], "REP")]


class TestFromQuestions:
    def test_a_question_that_says_who_he_is_makes_a_decision_that_knows_it(self, client, coach_headers):
        quiz = client.post("/api/quizzes", json={"title": "Week 3 install"}, headers=coach_headers).get_json()
        said = _decision(client, coach_headers, quiz["id"], "You\u2019re the boundary safety. #3 motions across - your check?", ["Rotate down", "Stay"])
        _decision(client, coach_headers, quiz["id"], "Identify the coverage.", ["Cover 3", "Cover 2"])
        rep = client.post(
            f"/api/quizzes/{quiz['id']}/make-rep", json={"question_ids": [said["id"]]}, headers=coach_headers
        ).get_json()
        full = client.get(f"/api/quizzes/{rep['id']}", headers=coach_headers).get_json()
        assert [q["subject_role"] for q in full["questions"]] == ["Boundary safety"]

    def test_adds_a_quiz_question_to_an_existing_rep_after_its_own_decisions(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        _decision(client, coach_headers, rep["id"], "Your check?", ["Rotate down", "Stay"], role="Boundary safety")
        quiz = client.post("/api/quizzes", json={"title": "Week 3 install"}, headers=coach_headers).get_json()
        cover = _decision(client, coach_headers, quiz["id"], "You're the Mike. Identify the coverage.", ["Cover 3", "Cover 2"])
        written = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={"question_text": "Describe it.", "question_type": "written", "options": []},
            headers=coach_headers,
        ).get_json()

        refused = client.post(
            f"/api/quizzes/{rep['id']}/add-decisions",
            json={"from_quiz_id": quiz["id"], "question_ids": [written["id"]]},
            headers=coach_headers,
        )
        assert refused.status_code == 422

        added = client.post(
            f"/api/quizzes/{rep['id']}/add-decisions",
            json={"from_quiz_id": quiz["id"], "question_ids": [cover["id"]]},
            headers=coach_headers,
        )
        assert added.status_code == 201, added.get_json()
        assert added.get_json()["added"] == 1
        full = client.get(f"/api/quizzes/{rep['id']}", headers=coach_headers).get_json()
        assert [q["question_text"] for q in full["questions"]] == ["Your check?", "You're the Mike. Identify the coverage."]
        assert [q["subject_role"] for q in full["questions"]] == ["Boundary safety", "Mike"]
        assert client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()["question_count"] == 2

    def test_only_into_a_rep(self, client, coach_headers):
        quiz = client.post("/api/quizzes", json={"title": "A"}, headers=coach_headers).get_json()
        other = client.post("/api/quizzes", json={"title": "B"}, headers=coach_headers).get_json()
        q = _decision(client, coach_headers, other["id"], "Q?", ["A", "B"])
        response = client.post(
            f"/api/quizzes/{quiz['id']}/add-decisions", json={"from_quiz_id": other["id"], "question_ids": [q["id"]]},
            headers=coach_headers,
        )
        assert response.status_code == 422


class TestPlayerProgress:
    def _progress(self, client, code, name, pid):
        return client.post(
            "/api/play/rep-progress", json={"access_code_id": code["id"], "player_name": name, "player_id": pid}
        )

    def test_his_previous_run_and_on_a_retest_the_original(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, rotate, inside = _option(first, "Stay boundary"), _option(first, "Rotate down"), _option(second, "Inside")
        bo = ("Bo Brown", ids["Bo Brown"])
        _play(client, code, *bo, {first["id"]: stay, second["id"]: inside})
        only = self._progress(client, code, *bo).get_json()
        assert only == {"previous": None, "original": None}

        _play(client, code, *bo, {first["id"]: rotate, second["id"]: inside})
        again = self._progress(client, code, *bo).get_json()
        assert again["previous"] == {
            "correct": 1, "answered": 2, "missed_concepts": ["Motion adjustment"], "mastered_concepts": ["Leverage"],
        }

        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        _play(client, sent, *bo, {copied["id"]: next(o["id"] for o in copied["options"] if o["option_text"] == "Rotate down")})
        on_retest = self._progress(client, sent, *bo).get_json()
        assert on_retest["previous"] is None
        assert on_retest["original"]["title"] == rep["title"]
        assert on_retest["original"]["missed_concepts"] == ["Motion adjustment"]

    def test_only_on_a_rep_and_only_for_a_player_who_started_it(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        assert self._progress(client, code, "Bo Brown", ids["Bo Brown"]).status_code == 404
        quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=headers).get_json()
        _decision(client, headers, quiz["id"], "Q?", ["A", "B"])
        client.post(f"/api/quizzes/{quiz['id']}/roster/members", json={"player_ids": [ids["Bo Brown"]]}, headers=headers)
        plain = _send(client, headers, quiz["id"], mode="PRACTICE")
        client.post("/api/play/start", json={"access_code_id": plain["id"], "player_name": "Bo Brown", "player_id": ids["Bo Brown"]})
        assert self._progress(client, plain, "Bo Brown", ids["Bo Brown"]).status_code == 422


class TestTapTheMan:
    TARGETS = [{"x": 0.2, "y": 0.6}, {"x": 0.8, "y": 0.55}]

    def _tap_decision(self, client, headers, quiz_id, targets=None):
        return client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Who gets the ball?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "X", "is_correct_answer": True}, {"option_text": "Z"}],
                "tap_targets": self.TARGETS if targets is None else targets,
            },
            headers=headers,
        )

    def test_each_answer_has_a_spot_in_the_picture_and_the_player_gets_them(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._tap_decision(client, coach_headers, rep["id"]).get_json()
        assert made["tap_targets"] == self.TARGETS
        _players(client, coach_headers, rep["id"])
        code = _send(client, coach_headers, rep["id"])
        delivered = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        assert delivered["quiz"]["questions"][0]["tap_targets"] == self.TARGETS
        copy = client.post(f"/api/quizzes/{rep['id']}/duplicate", headers=coach_headers).get_json()
        assert copy["questions"][0]["tap_targets"] == self.TARGETS

    def test_one_target_per_answer_or_none(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        response = self._tap_decision(client, coach_headers, rep["id"], targets=[{"x": 0.5, "y": 0.5}])
        assert response.status_code == 422
        assert response.get_json()["reason"] == "tap_targets_mismatch"
        off_picture = self._tap_decision(client, coach_headers, rep["id"], targets=[{"x": 1.5, "y": 0.5}, {"x": 0.1, "y": 0.1}])
        assert off_picture.status_code == 422

    def test_changing_the_answers_drops_targets_that_no_longer_line_up(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._tap_decision(client, coach_headers, rep["id"]).get_json()
        url = f"/api/quizzes/{rep['id']}/questions/{made['id']}"
        kept = client.patch(url, json={"question_text": "Who gets it?"}, headers=coach_headers).get_json()
        assert kept["tap_targets"] == self.TARGETS
        edited = client.patch(
            url,
            json={"options": [{"option_text": "X", "is_correct_answer": True}, {"option_text": "Z"}, {"option_text": "H"}]},
            headers=coach_headers,
        ).get_json()
        assert edited["tap_targets"] is None
