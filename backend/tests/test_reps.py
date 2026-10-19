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
from app.models import MotionPlay, Organization, Quiz, RepTeachMark
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

    def test_a_variation_starts_unsent_with_every_decision_intact(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        concept = _concept(client, coach_headers, "Motion adjustment")
        _decision(
            client, coach_headers, rep["id"], "Your check?", ["Rotate", "Stay"],
            concept=concept, role="Boundary safety", why="He is the new #3.",
        )
        _players(client, coach_headers, rep["id"])
        _send(client, coach_headers, rep["id"])
        copy = client.post(f"/api/quizzes/{rep['id']}/duplicate", headers=coach_headers).get_json()
        decision = copy["questions"][0]
        assert decision["concept"]["id"] == concept["id"]
        assert decision["answer_explanation"] == "He is the new #3."
        assert [o["is_correct_answer"] for o in decision["options"]] == [True, False]
        # Never sent: no code, and nobody on its roster until the coach picks them.
        assert client.get(f"/api/quizzes/{copy['id']}/access-codes", headers=coach_headers).get_json() == []
        assert client.get(f"/api/quizzes/{copy['id']}/roster", headers=coach_headers).get_json()["players"] == []

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
        assert results["audience"]["positions"] == ["S"]

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
        assert top["open_problem"] == {
            "name": "Motion adjustment", "concept_id": first["concept"]["id"], "missed": 1, "responded": 1, "taught": None,
        }
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
            "before_pct": 33, "now_pct": 50, "concept_id": first["concept"]["id"],
        }
        assert summary[rep["id"]]["signal"]["kind"] == "retested"
        assert summary[rep["id"]]["signal"]["retest_id"] == retest["id"]
        # Motion adjustment has been retested; nothing else was missed, so nothing is open.
        assert summary[rep["id"]]["open_problem"] is None
        assert summary[retest["id"]]["open_problem"] is None

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


class TestConceptTrends:
    def test_first_try_percent_on_the_first_rep_and_the_latest(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, rotate, inside = _option(first, "Stay boundary"), _option(first, "Rotate down"), _option(second, "Inside")
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: rotate, second["id"]: inside})
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: next(o["id"] for o in copied["options"] if o["option_text"] == "Rotate down")})

        trends = client.get("/api/quizzes/concept-trends", headers=headers).get_json()
        motion = next(t for t in trends if t["name"] == "Motion adjustment")
        assert (motion["reps"], motion["first_pct"], motion["last_pct"], motion["last_missed"]) == (2, 50, 100, 0)
        assert motion["last_rep_id"] == retest["id"]
        leverage = next(t for t in trends if t["name"] == "Leverage")
        assert (leverage["reps"], leverage["first_pct"], leverage["last_pct"]) == (1, 100, 100)
        # Most recently tested first.
        assert trends[0]["name"] == "Motion adjustment"


class TestRepsForAPlay:
    def test_lists_the_reps_holding_a_decision_from_this_play(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play_id = _motion_play(app, coach["organization_id"])
        other_play = _motion_play(app, coach["organization_id"], name="Other")
        with_play = _rep(client, headers, title="Trips Jet - Boundary safety")
        _decision(client, headers, with_play["id"], "Your check?", ["A", "B"], play_id=play_id)
        without = _rep(client, headers, title="Red zone")
        _decision(client, headers, without["id"], "Your check?", ["A", "B"], play_id=other_play)
        found = client.get(f"/api/quizzes/reps-for-play/{play_id}", headers=headers).get_json()
        assert found == [{"id": with_play["id"], "title": "Trips Jet - Boundary safety", "question_count": 1}]
        _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert client.get(f"/api/quizzes/reps-for-play/{play_id}", headers=rival).get_json() == []


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


class TestThePresnapMoment:
    CLIP = {
        "v": 1,
        "situation": {"losYard": 35, "hash": "middle", "down": 1, "distance": 10, "show": True},
        "highlight": "D9",
        "players": [
            {"id": "O8", "side": "offense", "label": "H", "x": 38, "y": -1.6, "speed": "fast", "timing": "on-snap",
             "motion": [{"x": 38, "y": -1.6}, {"x": 20, "y": -1.6}]},
            {"id": "D9", "side": "defense", "label": "FS", "x": 26, "y": 12, "speed": "fast", "timing": "on-snap"},
        ],
    }

    def _make(self, client, headers, quiz_id, presnap):
        return client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "#3 motions across. Your check?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "Rotate down", "is_correct_answer": True}, {"option_text": "Stay"}],
                "presnap": presnap,
            },
            headers=headers,
        )

    def test_the_motion_rides_with_the_decision_to_the_player_and_into_copies(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._make(client, coach_headers, rep["id"], self.CLIP)
        assert made.status_code == 201, made.get_json()
        assert made.get_json()["presnap"] == self.CLIP
        _players(client, coach_headers, rep["id"])
        code = _send(client, coach_headers, rep["id"])
        delivered = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()
        assert delivered["quiz"]["questions"][0]["presnap"] == self.CLIP
        copy = client.post(f"/api/quizzes/{rep['id']}/duplicate", headers=coach_headers).get_json()
        assert copy["questions"][0]["presnap"] == self.CLIP

    def test_a_decision_moment_and_only_a_short_beat_after_the_snap(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        mid = {**self.CLIP, "freeze": "mid"}
        assert self._make(client, coach_headers, rep["id"], mid).status_code == 201
        beat = {**self.CLIP, "freeze": "after", "after": {"step": 0.1, "duration": 0.8, "samples": [
            {"id": "O8", "pts": [{"x": 20, "y": -1.6}, {"x": 20, "y": -0.6}]}]}}
        assert self._make(client, coach_headers, rep["id"], beat).status_code == 201
        a_whole_route = {**beat, "after": {"step": 0.1, "duration": 6, "samples": beat["after"]["samples"]}}
        assert self._make(client, coach_headers, rep["id"], a_whole_route).status_code == 422
        nonsense = {**self.CLIP, "freeze": "halftime"}
        assert self._make(client, coach_headers, rep["id"], nonsense).status_code == 422

    def test_nothing_that_would_answer_the_question_is_accepted(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        with_route = {**self.CLIP, "players": [{**self.CLIP["players"][0], "path": [{"x": 20, "y": -1.6}, {"x": 20, "y": 10}]}]}
        assert self._make(client, coach_headers, rep["id"], with_route).status_code == 422
        with_ball = {**self.CLIP, "ball": {"kind": "pass", "targetId": "O8"}}
        assert self._make(client, coach_headers, rep["id"], with_ball).status_code == 422
        stray_key = {**self.CLIP, "players": [{**self.CLIP["players"][0], "engagement": "x"}]}
        assert self._make(client, coach_headers, rep["id"], stray_key).status_code == 422
        legacy_pre_snap = {**self.CLIP, "players": [{**self.CLIP["players"][1], "timing": "pre-snap", "path": [{"x": 26, "y": 12}, {"x": 30, "y": 8}]}]}
        assert self._make(client, coach_headers, rep["id"], legacy_pre_snap).status_code == 201


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

    def test_a_place_on_the_field_is_marked_as_one(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        targets = [{"x": 0.48, "y": 0.5, "zone": True}, {"x": 0.44, "y": 0.5, "zone": True}]
        made = self._tap_decision(client, coach_headers, rep["id"], targets=targets)
        assert made.status_code == 201, made.get_json()
        assert made.get_json()["tap_targets"] == targets
        men = self._tap_decision(client, coach_headers, rep["id"], targets=[{"x": 0.1, "y": 0.5}, {"x": 0.9, "y": 0.5}])
        assert men.get_json()["tap_targets"] == [{"x": 0.1, "y": 0.5}, {"x": 0.9, "y": 0.5}]

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


class TestTeachIsRemembered:
    """Taught on one device, by one coach: the next step is Retest for every
    coach, everywhere (models/rep_teach_mark)."""

    def _missed(self, client, headers, app, coach):
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        return rep, first

    def _motion(self, results, concept_id):
        return next(c for c in results["concepts"] if (c["concept"] or {}).get("id") == concept_id)

    def test_every_coach_sees_it_taught_and_teaching_again_moves_it_forward(
        self, client, register_coach, invite_teammate, app
    ):
        coach, _, headers = register_coach()
        rep, first = self._missed(client, headers, app, coach)
        concept_id = first["concept"]["id"]
        url = f"/api/quizzes/{rep['id']}/rep-results"
        assert self._motion(client.get(url, headers=headers).get_json(), concept_id)["taught"] is None

        marked = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": concept_id}, headers=headers)
        assert marked.status_code == 200, marked.get_json()
        assert marked.get_json()["concept_key"] == str(concept_id)

        # Another coach who may open this Rep - an admin - on his own device.
        mate, _, teammate = invite_teammate(headers)
        with app.app_context():
            from app.models import Coach, CoachRole

            db.session.get(Coach, mate["id"]).role = CoachRole.ADMIN
            db.session.commit()
        seen = self._motion(client.get(url, headers=teammate).get_json(), concept_id)
        assert seen["taught"]["by"] == coach["username"]
        assert seen["taught"]["at"]

        again = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": concept_id}, headers=teammate)
        assert again.get_json()["taught"]["by"] == "teammate"
        with app.app_context():
            assert RepTeachMark.query.filter_by(quiz_id=rep["id"]).count() == 1

    def test_home_next_up_knows_it_was_taught(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first = self._missed(client, headers, app, coach)
        client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": first["concept"]["id"]}, headers=headers)
        top = client.get("/api/quizzes/reps-summary", headers=headers).get_json()[0]
        assert top["open_problem"]["taught"]["by"] == coach["username"]

    def test_the_untagged_problem_and_nothing_across_organizations(self, client, register_coach):
        _, _, headers = register_coach()
        rep = _rep(client, headers)
        _decision(client, headers, rep["id"], "Your check?", ["A", "B"])
        general = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": None}, headers=headers)
        assert general.get_json()["concept_key"] == "general"

        _, _, stranger = register_coach(username="coach2", email="coach2@example.com", organization="Rams")
        refused = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": None}, headers=stranger)
        assert refused.status_code in (403, 404)
        theirs = _concept(client, stranger, "Their concept")
        foreign = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": theirs["id"]}, headers=headers)
        assert foreign.status_code == 422

        plain = client.post("/api/quizzes", json={"title": "Install"}, headers=headers).get_json()
        assert client.post(f"/api/quizzes/{plain['id']}/rep-teach", json={}, headers=headers).status_code == 422

    def test_merging_the_concept_keeps_it_taught(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first = self._missed(client, headers, app, coach)
        old = first["concept"]["id"]
        client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": old}, headers=headers)
        keep = _concept(client, headers, "Motion check")
        merged = client.post("/api/concepts/merge", json={"keep_id": keep["id"], "merge_ids": [old]}, headers=headers)
        assert merged.status_code == 200, merged.get_json()
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        assert self._motion(results, keep["id"])["taught"]["by"] == coach["username"]


class TestRepListsAreYourOwn:
    """Lists show a coach his own Reps - the rule every quiz list follows - so
    nothing is offered that would then refuse to open (utils/auth)."""

    def test_a_teammates_rep_is_not_on_your_home_trends_or_play(self, client, register_coach, invite_teammate, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, play_id = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        assert [s["id"] for s in client.get("/api/quizzes/reps-summary", headers=headers).get_json()] == [rep["id"]]

        _, _, teammate = invite_teammate(headers)
        assert client.get("/api/quizzes/reps-summary", headers=teammate).get_json() == []
        assert client.get("/api/quizzes/concept-trends", headers=teammate).get_json() == []
        assert client.get(f"/api/quizzes/reps-for-play/{play_id}", headers=teammate).get_json() == []
        assert client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=teammate).status_code == 404


class TestConceptHistory:
    """One football problem over time: the trend, the recent Reps, who still
    misses it, and the next step - by the same first-try rules."""

    def test_the_trend_and_who_is_still_missing_it(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        concept_id = first["concept"]["id"]
        stay, rotate, inside = _option(first, "Stay boundary"), _option(first, "Rotate down"), _option(second, "Inside")
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: rotate, second["id"]: inside})
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: stay, second["id"]: inside})
        # Retest the two who missed it; Bo gets it now, Cam still does not.
        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": concept_id}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        again = {o["option_text"]: o["id"] for o in copied["options"]}
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: again["Rotate down"]})
        _play(client, sent, "Cam Cole", ids["Cam Cole"], {copied["id"]: again["Stay boundary"]})

        history = client.get(f"/api/quizzes/concept-history/{concept_id}", headers=headers).get_json()
        assert history["concept"]["name"] == "Motion adjustment"
        assert [p["pct"] for p in history["points"]] == [33, 50]
        assert [p["rep_id"] for p in history["recent"]] == [retest["id"], rep["id"]]
        assert history["points"][1]["is_retest"] is True
        assert [p["display_name"] for p in history["still_missing"]] == ["Cam Cole"]
        assert history["latest"]["rep_id"] == retest["id"]
        assert (history["latest"]["missed"], history["latest"]["taught"]) == (1, None)

    def test_never_across_organizations_and_only_your_own_reps(self, client, register_coach, invite_teammate, app):
        coach, _, headers = register_coach()
        _rep_, first, *_ = _built(client, headers, app, coach)
        concept_id = first["concept"]["id"]
        _, _, stranger = register_coach(username="coach2", email="coach2@example.com", organization="Rams")
        assert client.get(f"/api/quizzes/concept-history/{concept_id}", headers=stranger).status_code == 404
        _, _, teammate = invite_teammate(headers)
        theirs = client.get(f"/api/quizzes/concept-history/{concept_id}", headers=teammate).get_json()
        assert (theirs["points"], theirs["still_missing"], theirs["latest"]) == ([], [], None)


class TestTheTestedMan:
    """Which man a decision tests is recorded, so the words, the ring and the
    picture stay about the same man - and once players have it, it stays."""

    CLIP = TestThePresnapMoment.CLIP

    def _decision(self, client, headers, quiz_id, **extra):
        return client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "#3 motions across. Your check?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "Rotate down", "is_correct_answer": True}, {"option_text": "Stay"}],
                "subject_role": "Free safety",
                **extra,
            },
            headers=headers,
        )

    def test_recorded_named_and_carried_into_copies(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._decision(client, coach_headers, rep["id"], subject_man="D9", presnap=self.CLIP)
        assert made.status_code == 201, made.get_json()
        assert made.get_json()["subject_man"] == "D9"
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=coach_headers).get_json()
        assert results["decisions"][0]["subject_man"] == {"id": "D9", "label": "FS"}
        copy = client.post(f"/api/quizzes/{rep['id']}/duplicate", headers=coach_headers).get_json()
        assert copy["questions"][0]["subject_man"] == "D9"

    def test_a_motion_decision_made_before_it_was_recorded_names_its_ringed_man(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        self._decision(client, coach_headers, rep["id"], presnap=self.CLIP)
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=coach_headers).get_json()
        assert results["decisions"][0]["subject_man"] == {"id": "D9", "label": "FS"}

    def test_a_still_decision_names_its_man_from_the_play(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep = _rep(client, headers)
        with app.app_context():
            play = MotionPlay(
                organization_id=coach["organization_id"], name="Base", schema_version=3,
                document={"players": [{"id": "D6", "label": "NB"}]},
            )
            db.session.add(play)
            db.session.commit()
            play_id = play.id
        self._decision(client, headers, rep["id"], subject_man="D6", motion_play_id=play_id)
        results = client.get(f"/api/quizzes/{rep['id']}/rep-results", headers=headers).get_json()
        assert results["decisions"][0]["subject_man"] == {"id": "D6", "label": "NB"}

    def test_before_players_have_it_the_man_moment_and_spots_can_change(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._decision(client, coach_headers, rep["id"], subject_man="D9", presnap=self.CLIP).get_json()
        url = f"/api/quizzes/{rep['id']}/questions/{made['id']}"
        moved = client.patch(
            url, json={"subject_man": "O8", "subject_role": "H", "presnap": {**self.CLIP, "highlight": "O8", "freeze": "mid"}},
            headers=coach_headers,
        )
        assert moved.status_code == 200, moved.get_json()
        assert (moved.get_json()["subject_man"], moved.get_json()["presnap"]["freeze"]) == ("O8", "mid")

    def test_once_players_have_it_the_man_moment_and_spots_are_locked_but_words_are_not(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        targets = [{"x": 0.1, "y": 0.5}, {"x": 0.9, "y": 0.5}]
        made = self._decision(
            client, coach_headers, rep["id"], subject_man="D9", presnap=self.CLIP, tap_targets=targets
        ).get_json()
        ids = _players(client, coach_headers, rep["id"])
        code = _send(client, coach_headers, rep["id"])
        _play(client, code, "Ty Adams", ids["Ty Adams"], {made["id"]: made["options"][0]["id"]})
        url = f"/api/quizzes/{rep['id']}/questions/{made['id']}"
        for change in (
            {"subject_man": "O8"},
            {"presnap": {**self.CLIP, "freeze": "mid"}},
            {"tap_targets": [{"x": 0.2, "y": 0.5}, {"x": 0.8, "y": 0.5}]},
        ):
            refused = client.patch(url, json=change, headers=coach_headers)
            assert refused.status_code == 422, change
            assert refused.get_json()["reason"] == "delivered_locked"
        # Same man, new words - and sending what is already there - are fine.
        reworded = client.patch(url, json={"subject_role": "Boundary safety", "subject_man": "D9"}, headers=coach_headers)
        assert reworded.status_code == 200, reworded.get_json()
        assert reworded.get_json()["subject_role"] == "Boundary safety"


class TestTheRingOnAPhoto:
    """A coach-placed 'you are this player' ring on an uploaded photo: placed,
    kept in copies, sane in size - and, once players have it, locked."""

    def _q(self, client, headers, quiz_id, **extra):
        return client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Your read?",
                "question_type": "multiple_choice",
                "options": [{"option_text": "Fit A", "is_correct_answer": True}, {"option_text": "Fit B"}],
                "subject_role": "Mike",
                **extra,
            },
            headers=headers,
        )

    def test_placed_returned_and_copied(self, client, coach_headers):
        quiz = client.post("/api/quizzes", json={"title": "Fits"}, headers=coach_headers).get_json()
        ring = {"x": 0.4, "y": 0.55, "r": 0.05}
        made = self._q(client, coach_headers, quiz["id"], subject_marker=ring)
        assert made.status_code == 201, made.get_json()
        assert made.get_json()["subject_marker"] == ring
        copy = client.post(f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers).get_json()
        assert copy["questions"][0]["subject_marker"] == ring

    def test_a_ring_off_the_picture_or_the_size_of_it_is_refused(self, client, coach_headers):
        quiz = client.post("/api/quizzes", json={"title": "Fits"}, headers=coach_headers).get_json()
        assert self._q(client, coach_headers, quiz["id"], subject_marker={"x": 1.4, "y": 0.5, "r": 0.05}).status_code == 422
        assert self._q(client, coach_headers, quiz["id"], subject_marker={"x": 0.4, "y": 0.5, "r": 0.9}).status_code == 422

    def test_once_players_have_it_the_ring_stays(self, client, coach_headers):
        rep = _rep(client, coach_headers)
        made = self._q(client, coach_headers, rep["id"], subject_marker={"x": 0.4, "y": 0.55, "r": 0.05}).get_json()
        ids = _players(client, coach_headers, rep["id"])
        code = _send(client, coach_headers, rep["id"])
        _play(client, code, "Ty Adams", ids["Ty Adams"], {made["id"]: made["options"][0]["id"]})
        moved = client.patch(
            f"/api/quizzes/{rep['id']}/questions/{made['id']}",
            json={"subject_marker": {"x": 0.7, "y": 0.55, "r": 0.05}},
            headers=coach_headers,
        )
        assert moved.status_code == 422
        assert moved.get_json()["reason"] == "delivered_locked"


class TestTheQuestionsAlreadyWrittenAboutAConcept:
    """For a targeted Rep built from what exists: the coach's own questions on
    a concept, across his quizzes and Reps - never a teammate's, never a
    stopped one."""

    def test_own_questions_on_the_concept_across_quizzes_and_reps(self, client, register_coach, invite_teammate):
        coach, _, headers = register_coach()
        concept = _concept(client, headers, "Motion adjustment")
        quiz = client.post("/api/quizzes", json={"title": "Week 3"}, headers=headers).get_json()
        rep = _rep(client, headers)
        on_quiz = _decision(client, headers, quiz["id"], "Your check?", ["Rotate", "Stay"], concept=concept)
        on_rep = _decision(client, headers, rep["id"], "Who has #3?", ["Me", "Corner"], concept=concept)
        _decision(client, headers, quiz["id"], "Untagged one", ["A", "B"])
        stopped = _decision(client, headers, quiz["id"], "Stopped one", ["A", "B"], concept=concept)
        client.post(f"/api/quizzes/{quiz['id']}/questions/{stopped['id']}/retire", headers=headers)
        _, _, teammate = invite_teammate(headers)
        theirs = client.post("/api/quizzes", json={"title": "Theirs"}, headers=teammate).get_json()
        _decision(client, teammate, theirs["id"], "Their check?", ["A", "B"], concept=concept)

        found = client.get(f"/api/concepts/{concept['id']}/questions", headers=headers).get_json()
        assert sorted(f["question_id"] for f in found) == sorted([on_quiz["id"], on_rep["id"]])
        kinds = {f["question_id"]: f["quiz_kind"] for f in found}
        assert (kinds[on_quiz["id"]], kinds[on_rep["id"]]) == ("QUIZ", "REP")

    def test_another_organizations_concept_is_not_found(self, client, register_coach):
        _, _, headers = register_coach()
        concept = _concept(client, headers, "Leverage")
        _, _, stranger = register_coach(username="coach2", email="coach2@example.com", organization="Rams")
        assert client.get(f"/api/concepts/{concept['id']}/questions", headers=stranger).status_code == 404


class TestWhatAPlayerKnows:
    """One player, by the concepts the coach tagged: HAS, WORK ON, and how each
    changed - from the coach's own Reps (first tries) and quizzes (graded)."""

    def test_missed_then_retested_correct_moves_to_has(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside, outside = _option(first, "Stay boundary"), _option(second, "Inside"), _option(second, "Outside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        before = client.get(f"/api/players/{ids['Bo Brown']}/learning", headers=headers).get_json()
        assert [c["name"] for c in before["work_on"]] == ["Motion adjustment"]
        assert [c["name"] for c in before["has"]] == ["Leverage"]
        assert before["work_on"][0]["last"]["question_ids"] == [first["id"]]

        retest = client.post(
            f"/api/quizzes/{rep['id']}/rep-retest", json={"concept_id": first["concept"]["id"]}, headers=headers
        ).get_json()
        sent = _send(client, headers, retest["id"])
        copied = client.get(f"/api/quizzes/{retest['id']}", headers=headers).get_json()["questions"][0]
        again = {o["option_text"]: o["id"] for o in copied["options"]}
        _play(client, sent, "Bo Brown", ids["Bo Brown"], {copied["id"]: again["Rotate down"]})

        after = client.get(f"/api/players/{ids['Bo Brown']}/learning", headers=headers).get_json()
        assert after["work_on"] == []
        assert sorted(c["name"] for c in after["has"]) == ["Leverage", "Motion adjustment"]
        trail = next(r for r in after["recent"] if r["name"] == "Motion adjustment")["trail"]
        assert [(t["outcome"], t["is_retest"]) for t in trail] == [("missed", False), ("got", True)]

    def test_a_teammate_sees_the_player_but_not_my_results(self, client, register_coach, app, invite_teammate):
        # Players are org-shared; results are Coach View - the teammate's
        # learning view reads only HIS own quizzes and Reps, never mine.
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        stay, inside = _option(first, "Stay boundary"), _option(second, "Inside")
        _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: inside})
        assert client.get(f"/api/players/{ids['Bo Brown']}/learning", headers=headers).get_json()["work_on"]
        _, _, teammate = invite_teammate(headers)
        seen = client.get(f"/api/players/{ids['Bo Brown']}/learning", headers=teammate)
        assert seen.status_code == 200
        assert seen.get_json() == {"has": [], "work_on": [], "recent": []}

    def test_a_malformed_id_fails_safely(self, client, coach_headers):
        assert client.get("/api/players/not-a-number/learning", headers=coach_headers).status_code == 404
        assert client.get("/api/players/987654321/learning", headers=coach_headers).status_code == 404
        assert client.get("/api/players/1/learning").status_code == 401

    def test_another_organizations_player_is_not_found(self, client, register_coach, app):
        coach, _, headers = register_coach()
        _rep_, _first, _second, ids, _code, _ = _built(client, headers, app, coach)
        _, _, stranger = register_coach(username="coach2", email="coach2@example.com", organization="Rams")
        assert client.get(f"/api/players/{ids['Bo Brown']}/learning", headers=stranger).status_code == 404
