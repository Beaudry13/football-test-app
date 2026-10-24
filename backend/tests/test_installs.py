"""INSTALLS - "this is what we are installing this week".

What this file protects:

1. An install REFERS to existing football - a Motion Lab play, a quiz or Rep,
   a concept - and copies none of it. Adding the same football twice is one
   item; removing it, archiving or deleting the install never touches the
   football; deleting the football removes its item.
2. One level of sections and an order, set whole (layout): every item placed
   exactly once; a removed section's items must go somewhere.
3. Duplicate = the same organization with a new name: the same references,
   no football copied, nothing delivered changed.
4. Each item says what PEIRA already knows (made from the play, out / turned
   in / to grade / weakest concept, the Rep's open problem) - nothing invented.
5. Own-only, like every quiz list; another organization sees nothing; a play
   needs a Motion Lab coach, as Motion Lab does.
6. The CURRENT install is the coach's explicit choice: one at a time, set by
   him, cleared by archiving or deleting it - never by opening, teaching,
   editing or restoring it.
"""

from app.extensions import db
from app.models import Install, MotionPlay, Question, Quiz
from tests.test_motion_lab import make_owner
from tests.test_play_and_grading import build_ready_quiz, start_and_submit
from tests.test_reps import _built, _concept, _decision, _motion_play, _option, _play, _rep

URL = "/api/installs"


def _owner(app, register_coach):
    coach, _, headers = register_coach(username="owner", email="owner@example.com", organization="Wildcats")
    make_owner(app, "owner@example.com")
    return coach, headers


def _install(client, headers, title="Week 7 - West Virginia", **extra):
    response = client.post(URL, json={"title": title, **extra}, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _add(client, headers, install_id, kind, ref_id, section_id=None):
    response = client.post(
        f"{URL}/{install_id}/items", json={"kind": kind, "ref_id": ref_id, "section_id": section_id}, headers=headers
    )
    assert response.status_code in (200, 201), response.get_json()
    return response.get_json()


class TestAnInstallRefersToFootball:
    def test_create_add_football_and_read_it_back(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        rep = _rep(client, headers, title="Trips Jet - Boundary safety")
        motion = _concept(client, headers, "Motion adjustment")
        install = _install(client, headers)
        _add(client, headers, install["id"], "play", play_id)
        _add(client, headers, install["id"], "quiz", rep["id"])
        body = _add(client, headers, install["id"], "concept", motion["id"])
        assert [(i["kind"], i["ref_id"]) for i in body["items"]] == [
            ("play", play_id),
            ("quiz", rep["id"]),
            ("concept", motion["id"]),
        ]
        assert body["items"][0]["ref"]["name"] == "Trips Jet"
        assert body["items"][1]["ref"]["kind"] == "REP"
        assert body["items"][2]["ref"]["name"] == "Motion adjustment"
        assert body["counts"] == {"plays": 1, "quizzes": 0, "reps": 1, "concepts": 1}
        assert client.get(f"{URL}/{install['id']}", headers=headers).get_json()["items"] == body["items"]

    def test_the_same_football_twice_is_one_item(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        install = _install(client, headers)
        _add(client, headers, install["id"], "play", play_id)
        again = client.post(f"{URL}/{install['id']}/items", json={"kind": "play", "ref_id": play_id}, headers=headers)
        assert again.status_code == 200
        assert len(again.get_json()["items"]) == 1

    def test_removing_archiving_or_deleting_never_touches_the_football(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        rep = _rep(client, headers)
        _decision(client, headers, rep["id"], "Your check?", ["A", "B"], play_id=play_id)
        install = _install(client, headers)
        body = _add(client, headers, install["id"], "play", play_id)
        _add(client, headers, install["id"], "quiz", rep["id"])
        removed = client.delete(f"{URL}/{install['id']}/items/{body['items'][0]['id']}", headers=headers)
        assert [i["kind"] for i in removed.get_json()["items"]] == ["quiz"]
        archived = client.patch(f"{URL}/{install['id']}", json={"archived": True}, headers=headers).get_json()
        assert archived["archived"] is True
        assert client.get(URL, headers=headers).get_json() == []
        assert [i["id"] for i in client.get(f"{URL}?archived=1", headers=headers).get_json()] == [install["id"]]
        assert client.delete(f"{URL}/{install['id']}", headers=headers).status_code == 204
        with app.app_context():
            assert db.session.get(MotionPlay, play_id) is not None
            assert db.session.get(Quiz, rep["id"]) is not None
            assert Question.query.filter_by(quiz_id=rep["id"]).count() == 1

    def test_deleting_the_football_removes_its_item(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        rep = _rep(client, headers)
        install = _install(client, headers)
        _add(client, headers, install["id"], "quiz", rep["id"])
        assert client.delete(f"/api/quizzes/{rep['id']}", headers=headers).status_code in (200, 204)
        assert client.get(f"{URL}/{install['id']}", headers=headers).get_json()["items"] == []


class TestOrderAndSections:
    def test_one_level_of_sections_and_the_whole_order_at_once(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        plays = [_motion_play(app, coach["organization_id"], name=n) for n in ("Base 1", "Base 2", "RZ 1")]
        install = _install(client, headers)
        for p in plays:
            body = _add(client, headers, install["id"], "play", p)
        a, b, c = [i["id"] for i in body["items"]]
        laid = client.put(
            f"{URL}/{install['id']}/layout",
            json={"loose": [c], "sections": [{"title": "Base", "item_ids": [b, a]}, {"title": "Red zone", "item_ids": []}]},
            headers=headers,
        )
        assert laid.status_code == 200, laid.get_json()
        body = laid.get_json()
        assert [s["title"] for s in body["sections"]] == ["Base", "Red zone"]
        base = body["sections"][0]["id"]
        by_id = {i["id"]: i for i in body["items"]}
        assert (by_id[c]["section_id"], by_id[c]["position"]) == (None, 0)
        assert (by_id[b]["section_id"], by_id[b]["position"]) == (base, 0)
        assert (by_id[a]["section_id"], by_id[a]["position"]) == (base, 1)
        # Rename a section, drop the empty one, move an item into the section.
        relaid = client.put(
            f"{URL}/{install['id']}/layout",
            json={"loose": [], "sections": [{"id": base, "title": "Base offense", "item_ids": [c, b, a]}]},
            headers=headers,
        ).get_json()
        assert [s["title"] for s in relaid["sections"]] == ["Base offense"]
        assert sorted(i["section_id"] for i in relaid["items"]) == [base, base, base]

    def test_every_item_must_be_placed_exactly_once(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        p1, p2 = _motion_play(app, coach["organization_id"], name="A"), _motion_play(app, coach["organization_id"], name="B")
        install = _install(client, headers)
        _add(client, headers, install["id"], "play", p1)
        body = _add(client, headers, install["id"], "play", p2)
        a, b = [i["id"] for i in body["items"]]
        for layout in ({"loose": [a]}, {"loose": [a, a, b]}, {"loose": [a, b, 999]}):
            response = client.put(f"{URL}/{install['id']}/layout", json=layout, headers=headers)
            assert response.status_code == 422, layout

    def test_adding_into_a_section_goes_to_its_end(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        p1, p2 = _motion_play(app, coach["organization_id"], name="A"), _motion_play(app, coach["organization_id"], name="B")
        install = _install(client, headers)
        body = _add(client, headers, install["id"], "play", p1)
        laid = client.put(
            f"{URL}/{install['id']}/layout",
            json={"loose": [], "sections": [{"title": "Base", "item_ids": [body["items"][0]["id"]]}]},
            headers=headers,
        ).get_json()
        section = laid["sections"][0]["id"]
        body = _add(client, headers, install["id"], "play", p2, section_id=section)
        added = next(i for i in body["items"] if i["ref_id"] == p2)
        assert (added["section_id"], added["position"]) == (section, 1)


class TestDuplicate:
    def test_a_new_week_with_the_same_organization_and_no_football_copied(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        rep = _rep(client, headers)
        install = _install(client, headers, title="Week 7 - West Virginia")
        body = _add(client, headers, install["id"], "play", play_id)
        _add(client, headers, install["id"], "quiz", rep["id"])
        client.put(
            f"{URL}/{install['id']}/layout",
            json={"loose": [body["items"][0]["id"]], "sections": [{"title": "Third down", "item_ids": [i["id"] for i in client.get(f"{URL}/{install['id']}", headers=headers).get_json()["items"] if i["kind"] == "quiz"]}]},
            headers=headers,
        )
        with app.app_context():
            quizzes_before = Quiz.query.count()
            plays_before = MotionPlay.query.count()
        copy = client.post(f"{URL}/{install['id']}/duplicate", json={"title": "Week 8 - Baylor"}, headers=headers)
        assert copy.status_code == 201, copy.get_json()
        copy = copy.get_json()
        assert copy["id"] != install["id"]
        assert copy["title"] == "Week 8 - Baylor"
        assert [s["title"] for s in copy["sections"]] == ["Third down"]
        assert sorted((i["kind"], i["ref_id"]) for i in copy["items"]) == sorted([("play", play_id), ("quiz", rep["id"])])
        with app.app_context():
            assert Quiz.query.count() == quizzes_before
            assert MotionPlay.query.count() == plays_before
            assert Install.query.count() == 2


class TestWhatPeiraAlreadyKnows:
    def test_a_play_says_what_has_been_made_from_it(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        rep = _rep(client, headers)
        _decision(client, headers, rep["id"], "Your check?", ["A", "B"], play_id=play_id)
        install = _install(client, headers)
        body = _add(client, headers, install["id"], "play", play_id)
        assert body["items"][0]["status"] == {"made": {"quizzes": 0, "reps": 1}}

    def test_a_rep_says_its_open_problem(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids, code, _ = _built(client, headers, app, coach)
        _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: _option(first, "Stay boundary"), second["id"]: _option(second, "Inside")})
        install = _install(client, headers)
        status = _add(client, headers, install["id"], "quiz", rep["id"])["items"][0]["status"]
        assert status["live"] is True
        assert status["ran"] == 1
        assert status["open_problem"]["name"] == "Motion adjustment"
        assert status["open_problem"]["missed"] == 1
        assert status["open_problem"]["taught"] is False

    def test_a_quiz_says_out_turned_in_and_to_grade(self, client, coach_headers):
        quiz, _tf, written, code = build_ready_quiz(client, coach_headers)
        start_and_submit(client, code["id"], "Jordan Smith", [{"question_id": written["id"], "answer_text": "Edge."}])
        install = _install(client, coach_headers)
        status = _add(client, coach_headers, install["id"], "quiz", quiz["id"])["items"][0]["status"]
        assert status["live"] is True
        assert status["submitted"] == 1
        assert status["to_grade"] == 1
        assert status["weakest"] is None

    def test_a_concept_says_how_much_football_is_about_it(self, client, register_coach, app):
        coach, _, headers = register_coach()
        motion = _concept(client, headers, "Motion adjustment")
        rep = _rep(client, headers)
        _decision(client, headers, rep["id"], "Your check?", ["A", "B"], concept=motion)
        install = _install(client, headers)
        status = _add(client, headers, install["id"], "concept", motion["id"])["items"][0]["status"]
        assert status == {"in": {"quizzes": 0, "reps": 1}}


class TestWhereTheFootballIs:
    def test_which_active_installs_already_hold_it(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        play_id = _motion_play(app, coach["organization_id"])
        week7 = _install(client, headers, title="Week 7")
        week8 = _install(client, headers, title="Week 8")
        _add(client, headers, week7["id"], "play", play_id)
        found = client.get(f"{URL}/for?kind=play&ref_id={play_id}", headers=headers).get_json()
        assert {i["title"]: i["has"] for i in found} == {"Week 7": True, "Week 8": False}
        client.patch(f"{URL}/{week8['id']}", json={"archived": True}, headers=headers)
        assert [i["title"] for i in client.get(f"{URL}/for?kind=play&ref_id={play_id}", headers=headers).get_json()] == ["Week 7"]


class TestOwnOnly:
    def test_another_coachs_install_is_not_found_and_lists_are_his_own(self, client, register_coach, invite_teammate, app):
        coach, headers = _owner(app, register_coach)
        install = _install(client, headers)
        _, _, teammate = invite_teammate(headers)
        assert client.get(URL, headers=teammate).get_json() == []
        assert client.get(f"{URL}/{install['id']}", headers=teammate).status_code == 404
        assert client.patch(f"{URL}/{install['id']}", json={"title": "x"}, headers=teammate).status_code == 404
        _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert client.get(f"{URL}/{install['id']}", headers=rival).status_code == 404
        assert client.get(URL).status_code == 401

    def test_football_from_another_organization_cannot_be_added(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        rival, _, rival_headers = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        their_play = _motion_play(app, rival["organization_id"])
        their_rep = _rep(client, rival_headers)
        their_concept = _concept(client, rival_headers, "Theirs")
        install = _install(client, headers)
        for kind, ref in (("play", their_play), ("quiz", their_rep["id"]), ("concept", their_concept["id"])):
            response = client.post(f"{URL}/{install['id']}/items", json={"kind": kind, "ref_id": ref}, headers=headers)
            assert response.status_code == 404, (kind, response.get_json())

    def test_a_play_needs_a_motion_lab_coach(self, client, register_coach, app):
        coach, _, headers = register_coach()
        play_id = _motion_play(app, coach["organization_id"])
        install = _install(client, headers)
        response = client.post(f"{URL}/{install['id']}/items", json={"kind": "play", "ref_id": play_id}, headers=headers)
        assert response.status_code in (403, 404)

    def test_a_blank_name_is_refused(self, client, coach_headers):
        assert client.post(URL, json={"title": "   "}, headers=coach_headers).status_code == 422


def _current_ids(client, headers):
    """Which of his installs (active or archived) are current."""
    every = client.get(URL, headers=headers).get_json() + client.get(f"{URL}?archived=1", headers=headers).get_json()
    return [i["id"] for i in every if i["current"]]


class TestCurrentInstall:
    def test_the_first_install_is_current_and_the_next_one_is_not(self, client, coach_headers):
        week7 = _install(client, coach_headers, "Week 7")
        week8 = _install(client, coach_headers, "Week 8")
        assert week7["current"] is True
        assert week8["current"] is False
        # The current one leads the list, even though Week 8 is newer.
        assert [i["title"] for i in client.get(URL, headers=coach_headers).get_json()] == ["Week 7", "Week 8"]

    def test_set_as_current_moves_it_and_there_is_only_ever_one(self, client, coach_headers, app):
        week7 = _install(client, coach_headers, "Week 7")
        week8 = _install(client, coach_headers, "Week 8")
        body = client.patch(f"{URL}/{week8['id']}", json={"current": True}, headers=coach_headers).get_json()
        assert body["current"] is True
        assert _current_ids(client, coach_headers) == [week8["id"]]
        with app.app_context():
            assert Install.query.filter_by(is_current=True).count() == 1
        # Saying so again changes nothing; clearing it leaves none.
        client.patch(f"{URL}/{week8['id']}", json={"current": True}, headers=coach_headers)
        assert _current_ids(client, coach_headers) == [week8["id"]]
        client.patch(f"{URL}/{week8['id']}", json={"current": False}, headers=coach_headers)
        assert _current_ids(client, coach_headers) == []
        assert week7["id"]  # still there, simply not current

    def test_opening_teaching_or_editing_never_changes_which_is_current(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        week7 = _install(client, headers, "Week 7")
        old = _install(client, headers, "Spring install 4")
        motion = _concept(client, headers, "Motion adjustment")
        # Working on the old package: open it, rename it, add to it, reorder it.
        client.get(f"{URL}/{old['id']}", headers=headers)
        client.patch(f"{URL}/{old['id']}", json={"title": "Spring install 4 (v2)", "position_group": "family:Safeties"}, headers=headers)
        body = _add(client, headers, old["id"], "concept", motion["id"])
        client.put(f"{URL}/{old['id']}/layout", json={"loose": [body["items"][0]["id"]], "sections": []}, headers=headers)
        assert _current_ids(client, headers) == [week7["id"]]

    def test_archiving_the_current_install_clears_it_and_restoring_does_not_bring_it_back(self, client, coach_headers):
        week7 = _install(client, coach_headers, "Week 7")
        archived = client.patch(f"{URL}/{week7['id']}", json={"archived": True}, headers=coach_headers).get_json()
        assert archived["current"] is False
        assert _current_ids(client, coach_headers) == []
        # An archived install cannot be made current...
        refused = client.patch(f"{URL}/{week7['id']}", json={"current": True}, headers=coach_headers)
        assert refused.status_code == 422
        # ...and restoring it leaves it an ordinary install.
        restored = client.patch(f"{URL}/{week7['id']}", json={"archived": False}, headers=coach_headers).get_json()
        assert restored["current"] is False
        assert _current_ids(client, coach_headers) == []

    def test_deleting_the_current_install_clears_it_and_the_next_new_one_is_current(self, client, coach_headers):
        week7 = _install(client, coach_headers, "Week 7")
        spare = _install(client, coach_headers, "Spring install 4")
        assert client.delete(f"{URL}/{week7['id']}", headers=coach_headers).status_code == 204
        assert _current_ids(client, coach_headers) == []
        # With none current, a new install is - the old spare one is not promoted.
        week8 = _install(client, coach_headers, "Week 8")
        assert week8["current"] is True
        assert _current_ids(client, coach_headers) == [week8["id"]]
        assert spare["current"] is False

    def test_duplicating_for_a_new_week_replaces_current_only_when_asked(self, client, coach_headers):
        week7 = _install(client, coach_headers, "Week 7")
        quiet = client.post(f"{URL}/{week7['id']}/duplicate", json={"title": "Week 7 (copy)"}, headers=coach_headers).get_json()
        assert quiet["current"] is False
        assert _current_ids(client, coach_headers) == [week7["id"]]
        week8 = client.post(
            f"{URL}/{week7['id']}/duplicate", json={"title": "Week 8", "make_current": True}, headers=coach_headers
        ).get_json()
        assert week8["current"] is True
        assert _current_ids(client, coach_headers) == [week8["id"]]

    def test_each_coach_has_his_own_current_install(self, client, register_coach, invite_teammate, app):
        coach, headers = _owner(app, register_coach)
        mine = _install(client, headers, "Week 7")
        _, _, teammate = invite_teammate(headers)
        his = _install(client, teammate, "Safeties - Week 7")
        assert his["current"] is True
        assert _current_ids(client, headers) == [mine["id"]]
        assert _current_ids(client, teammate) == [his["id"]]
        # Another coach cannot make himself the owner of mine by setting it current.
        assert client.patch(f"{URL}/{mine['id']}", json={"current": True}, headers=teammate).status_code == 404



class TestEditsDoNotRebuildWhatPeiraKnows:
    def test_moving_renaming_or_taking_out_answers_without_statuses_and_a_read_still_has_them(self, client, register_coach, app):
        coach, headers = _owner(app, register_coach)
        rep = _rep(client, headers, title="Trips Jet - Boundary safety")
        motion = _concept(client, headers, "Motion adjustment")
        install = _install(client, headers)
        _add(client, headers, install["id"], "quiz", rep["id"])
        added = _add(client, headers, install["id"], "concept", motion["id"])
        # Adding: the new item says what PEIRA knows.
        assert all(i["status"] is not None for i in added["items"])
        first, second = (i["id"] for i in added["items"])
        moved = client.put(f"{URL}/{install['id']}/layout", json={"loose": [second, first], "sections": []}, headers=headers)
        assert moved.status_code == 200
        # The football did not change: no status rebuilt, the page keeps its own.
        assert [i["id"] for i in moved.get_json()["items"]] == [second, first]
        assert all(i["status"] is None for i in moved.get_json()["items"])
        renamed = client.patch(f"{URL}/{install['id']}", json={"title": "Week 8", "current": True}, headers=headers).get_json()
        assert all(i["status"] is None for i in renamed["items"])
        # A plain read always has them.
        read = client.get(f"{URL}/{install['id']}", headers=headers).get_json()
        assert all(i["status"] is not None for i in read["items"])
