"""WHAT A POSITION GROUP NEEDS: GET /api/players/needs?ids=...

"Show me my safeties. Show me what they are missing." This pins:

1. The same rows the profile's "What he knows" shows (services/player_learning):
   a concept is listed when at least one of the players is still WORKING ON it,
   with who, where each last missed it (so a retest can send it back), and how
   many of them have it.
2. Most missed first.
3. One player's profile reads exactly as before (the shared one-pass code).
4. Players outside the coach's organization are ignored; another coach's
   results never show (Coach View); bad input fails safely.
"""

from tests.test_reps import _built, _option, _play

URL = "/api/players/needs"


def _ran(client, headers, app, coach):
    """Ty and Bo miss the motion check; Cam gets both right; Dee never runs it."""
    rep, first, second, ids, code, _ = _built(client, headers, app, coach)
    stay, rotate = _option(first, "Stay boundary"), _option(first, "Rotate down")
    inside, outside = _option(second, "Inside"), _option(second, "Outside")
    _play(client, code, "Ty Adams", ids["Ty Adams"], {first["id"]: stay, second["id"]: inside})
    _play(client, code, "Bo Brown", ids["Bo Brown"], {first["id"]: stay, second["id"]: outside})
    _play(client, code, "Cam Cole", ids["Cam Cole"], {first["id"]: rotate, second["id"]: inside})
    return rep, first, second, ids


def _ask(client, headers, ids):
    return client.get(f"{URL}?ids={','.join(str(i) for i in ids)}", headers=headers)


class TestGroupNeeds:
    def test_what_the_safeties_are_missing_most_missed_first(self, client, register_coach, app):
        coach, _, headers = register_coach()
        rep, first, second, ids = _ran(client, headers, app, coach)
        body = _ask(client, headers, ids.values()).get_json()
        assert body["players"] == 4
        names = [c["name"] for c in body["concepts"]]
        assert names == ["Motion adjustment", "Leverage"]
        motion, leverage = body["concepts"]
        assert [m["name"] for m in motion["missing"]] == ["Bo Brown", "Ty Adams"]
        assert motion["got"] == 1
        assert {m["last"]["quiz_id"] for m in motion["missing"]} == {rep["id"]}
        assert all(m["last"]["question_ids"] == [first["id"]] for m in motion["missing"])
        assert [m["name"] for m in leverage["missing"]] == ["Bo Brown"]
        assert leverage["got"] == 2

    def test_a_concept_everyone_has_is_not_listed(self, client, register_coach, app):
        coach, _, headers = register_coach()
        _rep, _first, _second, ids = _ran(client, headers, app, coach)
        body = _ask(client, headers, [ids["Cam Cole"]]).get_json()
        assert body == {"players": 1, "concepts": []}

    def test_one_players_profile_reads_as_before(self, client, register_coach, app):
        coach, _, headers = register_coach()
        _rep, first, _second, ids = _ran(client, headers, app, coach)
        profile = client.get(f"/api/players/{ids['Ty Adams']}/learning", headers=headers).get_json()
        assert [c["name"] for c in profile["work_on"]] == ["Motion adjustment"]
        assert [c["name"] for c in profile["has"]] == ["Leverage"]
        assert profile["work_on"][0]["last"]["question_ids"] == [first["id"]]

    def test_other_organizations_players_are_ignored_and_results_are_coach_view(
        self, client, register_coach, app, invite_teammate
    ):
        coach, _, headers = register_coach()
        _rep, _first, _second, ids = _ran(client, headers, app, coach)
        _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
        assert _ask(client, rival, ids.values()).get_json() == {"players": 0, "concepts": []}
        _, _, teammate = invite_teammate(headers)
        seen = _ask(client, teammate, ids.values()).get_json()
        assert seen["players"] == 4
        assert seen["concepts"] == []

    def test_bad_input_fails_safely(self, client, coach_headers):
        assert client.get(f"{URL}?ids=", headers=coach_headers).get_json() == {"players": 0, "concepts": []}
        assert client.get(f"{URL}?ids=1,x", headers=coach_headers).status_code == 422
        too_many = ",".join(str(i) for i in range(1, 62))
        assert client.get(f"{URL}?ids={too_many}", headers=coach_headers).status_code == 422
        assert client.get(f"{URL}?ids=1").status_code == 401
