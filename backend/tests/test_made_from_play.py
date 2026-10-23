"""CREATE ONCE: "What have I already made from this play?"

GET /api/quizzes/made-from-play/<play_id> lists this coach's quizzes and Reps
that hold a live question made from a Motion Lab play, and what he said the last
time he made something from it (concept, man, role) - so Make question / Make
rep start there. What this file protects:

1. Only questions made from THIS play, still being sent (a retired one is not
   "made" any more), grouped by quiz, most recently made first.
2. Own-only, like every quiz list: a teammate's quiz is not listed, another
   organization sees nothing - and nothing about the play itself is returned.
3. "Last time" is the coach's own latest entry, verbatim; an archived concept
   is not offered again.
4. Reading it changes nothing.
"""

from app.extensions import db
from app.models import Concept, Question
from tests.test_reps import _concept, _decision, _motion_play, _rep

URL = "/api/quizzes/made-from-play/{}"


def _quiz(client, headers, title):
    response = client.post("/api/quizzes", json={"title": title}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _man(app, question_id, man):
    with app.app_context():
        db.session.get(Question, question_id).subject_man = man
        db.session.commit()


class TestMadeFromAPlay:
    def test_lists_what_was_made_from_this_play_newest_first(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        other = _motion_play(app, coach["organization_id"], name="Other")
        install = _quiz(client, headers, "Week 6 install")
        _decision(client, headers, install["id"], "Who gets the ball?", ["X", "Z"], play_id=play)
        _decision(client, headers, install["id"], "Not from a play", ["A", "B"])
        _decision(client, headers, install["id"], "Draw your assignment", ["A", "B"], play_id=play)
        rep = _rep(client, headers, title="Trips Jet - Boundary safety")
        motion = _concept(client, headers, "Motion adjustment")
        latest = _decision(
            client, headers, rep["id"], "#3 motions across - your check?", ["Rotate", "Stay"],
            play_id=play, concept=motion, role="Boundary safety", why="He is the new #3.",
        )
        _man(app, latest["id"], "D9")
        elsewhere = _quiz(client, headers, "Red zone")
        _decision(client, headers, elsewhere["id"], "From another play", ["A", "B"], play_id=other)

        body = client.get(URL.format(play), headers=headers).get_json()
        assert body["made"] == [
            {
                "id": rep["id"], "title": "Trips Jet - Boundary safety", "kind": "REP", "from_play": 1, "question_count": 1,
                "concepts": ["Motion adjustment"], "roles": ["Boundary safety"], "taught_at": None,
            },
            {
                "id": install["id"], "title": "Week 6 install", "kind": "QUIZ", "from_play": 2, "question_count": 3,
                "concepts": [], "roles": [], "taught_at": None,
            },
        ]
        assert body["last"] == {
            "concept": {"id": motion["id"], "name": "Motion adjustment"},
            "subject_man": "D9",
            "subject_role": "Boundary safety",
            "answer_explanation": "He is the new #3.",
        }

    def test_nothing_made_yet(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        assert client.get(URL.format(play), headers=headers).get_json() == {"made": [], "last": None}

    def test_a_retired_question_is_not_made_any_more(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        quiz = _quiz(client, headers, "Week 6 install")
        question = _decision(client, headers, quiz["id"], "Who gets the ball?", ["X", "Z"], play_id=play)
        retired = client.post(f"/api/quizzes/{quiz['id']}/questions/{question['id']}/retire", headers=headers)
        assert retired.status_code == 200, retired.get_json()
        assert client.get(URL.format(play), headers=headers).get_json() == {"made": [], "last": None}

    def test_an_archived_concept_is_not_offered_again(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        quiz = _quiz(client, headers, "Week 6 install")
        old = _concept(client, headers, "Old name")
        _decision(client, headers, quiz["id"], "Who gets the ball?", ["X", "Z"], play_id=play, concept=old, role="X")
        with app.app_context():
            db.session.get(Concept, old["id"]).is_archived = True
            db.session.commit()
        last = client.get(URL.format(play), headers=headers).get_json()["last"]
        assert last == {"concept": None, "subject_man": None, "subject_role": "X", "answer_explanation": None}

    def test_own_only_and_nothing_across_organizations(self, client, register_coach, invite_teammate, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        quiz = _quiz(client, headers, "Week 6 install")
        _decision(client, headers, quiz["id"], "Who gets the ball?", ["X", "Z"], play_id=play)

        _, _, teammate = invite_teammate(headers)
        assert client.get(URL.format(play), headers=teammate).get_json() == {"made": [], "last": None}
        _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert client.get(URL.format(play), headers=rival).get_json() == {"made": [], "last": None}
        assert client.get(URL.format(play)).status_code == 401

    def test_reading_it_changes_nothing(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        quiz = _quiz(client, headers, "Week 6 install")
        _decision(client, headers, quiz["id"], "Who gets the ball?", ["X", "Z"], play_id=play)
        before = client.get(f"/api/quizzes/{quiz['id']}", headers=headers).get_json()
        client.get(URL.format(play), headers=headers)
        after = client.get(f"/api/quizzes/{quiz['id']}", headers=headers).get_json()
        assert after == before

    def test_a_rep_taught_from_its_results_says_when(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play = _motion_play(app, coach["organization_id"])
        rep = _rep(client, headers, title="Trips Jet - Boundary safety")
        motion = _concept(client, headers, "Motion adjustment")
        _decision(client, headers, rep["id"], "Your check?", ["Rotate", "Stay"], play_id=play, concept=motion)
        taught = client.post(f"/api/quizzes/{rep['id']}/rep-teach", json={"concept_id": motion["id"]}, headers=headers)
        assert taught.status_code in (200, 201), taught.get_json()
        made = client.get(URL.format(play), headers=headers).get_json()["made"][0]
        assert made["taught_at"] is not None
