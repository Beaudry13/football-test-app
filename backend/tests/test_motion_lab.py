"""Motion Lab plays, looks and Motion Lab folders.

What is pinned here:
  * the P2 pilot gate - only a platform owner reaches any of it, everyone else
    gets the same 404 a missing id gets;
  * organization ownership - every coach in the organization may edit, another
    organization's content does not exist;
  * revisions - a save from an older revision is refused, never merged;
  * structure - the server refuses what is not the authored model, and does
    not try to judge the football;
  * folder areas - Motion Lab folders are a separate tree, and quiz folders
    behave exactly as they did.
"""

import json

import pytest

from app.extensions import db
from app.models import Coach, Folder, MotionLook, MotionPlay
from app.services.motion_documents import MAX_PATH_ANCHORS, MAX_PLAYERS


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def make_player(i, side="offense", **overrides):
    player = {
        "id": f"{'O' if side == 'offense' else 'D'}{i}",
        "side": side,
        "label": "QB" if (side == "offense" and i == 6) else ("C" if side == "offense" and i == 2 else "X"),
        "x": 5.0 + i * 2,
        "y": -1.0 if side == "offense" else 3.0,
        "path": [],
        "timing": "on-snap",
        "delay": 0.5,
        "speed": "normal",
    }
    player.update(overrides)
    return player


def play_document(**overrides):
    """A structurally complete play, the shape the editor sends."""
    players = [make_player(i) for i in range(11)] + [make_player(i, "defense") for i in range(11)]
    players[8]["path"] = [{"x": 21.0, "y": -1.0}, {"x": 21.0, "y": 10.0}]
    players[8]["endBehavior"] = "settle"
    document = {
        "players": players,
        "ball": {"kind": "pass", "targetId": "O8", "catchPoint": {"x": 21.0, "y": 8.0}},
        "ballThen": None,
        "engagements": [{"id": "e1", "kind": "engage", "a": "O1", "b": "D1", "point": {"x": 7.0, "y": 1.0}, "release": "O1"}],
        "situation": {"losYard": 35, "hash": "middle", "down": 1, "distance": 10, "show": True},
        "filter": "all",
    }
    document.update(overrides)
    return document


def look_document():
    return {"players": [make_player(i) for i in range(11)]}


def make_owner(app, email):
    with app.app_context():
        coach = Coach.query.filter_by(email=email).one()
        coach.is_platform_owner = True
        db.session.commit()


@pytest.fixture
def owner(app, register_coach):
    coach, _token, headers = register_coach(username="owner", email="owner@example.com", organization="Peira HQ")
    make_owner(app, "owner@example.com")
    return {"coach": coach, "headers": headers}


@pytest.fixture
def teammate(app, invite_teammate, owner):
    """A second coach in the owner's organization, also in the pilot."""
    coach, _token, headers = invite_teammate(owner["headers"], username="dcoach", email="dc@example.com")
    make_owner(app, "dc@example.com")
    return {"coach": coach, "headers": headers}


@pytest.fixture
def member(invite_teammate, owner):
    """A coach in the owner's organization who is NOT in the pilot."""
    coach, _token, headers = invite_teammate(owner["headers"], username="lbcoach", email="lb@example.com")
    return {"coach": coach, "headers": headers}


@pytest.fixture
def rival(app, register_coach):
    """A pilot coach in a DIFFERENT organization."""
    coach, _token, headers = register_coach(username="rival", email="rival@example.com", organization="Rival HS")
    make_owner(app, "rival@example.com")
    return {"coach": coach, "headers": headers}


def create_play(client, headers, name="Mesh", **extra):
    body = {"name": name, "document": play_document(), "schema_version": 1, **extra}
    response = client.post("/api/motion-lab/plays", json=body, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def save_play(client, headers, play, **overrides):
    body = {
        "name": play["name"],
        "document": play["document"],
        "schema_version": 1,
        "base_revision": play["revision"],
        **overrides,
    }
    return client.put(f"/api/motion-lab/plays/{play['id']}", json=body, headers=headers)


def create_motion_folder(client, headers, name="Defense", parent=None):
    body = {"name": name, "area": "motion"}
    if parent is not None:
        body["parent_folder_id"] = parent
    response = client.post("/api/folders", json=body, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()


# ---------------------------------------------------------------------------
# The P2 pilot gate
# ---------------------------------------------------------------------------


class TestPilotGate:
    def test_signed_out_is_refused(self, client):
        assert client.get("/api/motion-lab/plays").status_code == 401

    def test_a_coach_outside_the_pilot_finds_nothing_there(self, client, owner, member):
        play = create_play(client, owner["headers"])
        look = client.post(
            "/api/motion-lab/looks",
            json={"name": "Trips", "document": look_document(), "schema_version": 1},
            headers=owner["headers"],
        ).get_json()
        folder = create_motion_folder(client, owner["headers"])
        h = member["headers"]
        attempts = [
            client.get("/api/motion-lab/plays", headers=h),
            client.post("/api/motion-lab/plays", json={"name": "x", "document": play_document(), "schema_version": 1}, headers=h),
            client.get(f"/api/motion-lab/plays/{play['id']}", headers=h),
            save_play(client, h, play),
            client.patch(f"/api/motion-lab/plays/{play['id']}", json={"name": "x"}, headers=h),
            client.post(f"/api/motion-lab/plays/{play['id']}/copy", headers=h),
            client.delete(f"/api/motion-lab/plays/{play['id']}", headers=h),
            client.get("/api/motion-lab/looks", headers=h),
            client.get(f"/api/motion-lab/looks/{look['id']}", headers=h),
            client.delete(f"/api/motion-lab/looks/{look['id']}", headers=h),
            client.get("/api/folders?area=motion", headers=h),
            client.post("/api/folders", json={"name": "x", "area": "motion"}, headers=h),
            client.patch(f"/api/folders/{folder['id']}", json={"name": "x"}, headers=h),
            client.delete(f"/api/folders/{folder['id']}", headers=h),
        ]
        assert [r.status_code for r in attempts] == [404] * len(attempts)
        # And nothing changed.
        assert client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).get_json()["revision"] == 1

    def test_a_coach_outside_the_pilot_keeps_their_quiz_folders(self, client, owner, member):
        response = client.post("/api/folders", json={"name": "Week 1"}, headers=member["headers"])
        assert response.status_code == 201
        assert response.get_json()["area"] == "quizzes"
        assert [f["name"] for f in client.get("/api/folders", headers=member["headers"]).get_json()] == ["Week 1"]


# ---------------------------------------------------------------------------
# Plays
# ---------------------------------------------------------------------------


class TestPlays:
    def test_create_stores_the_authored_document_exactly(self, client, owner, app):
        play = create_play(client, owner["headers"], name="  Mesh vs Cover 3  ")
        assert play["name"] == "Mesh vs Cover 3"
        assert play["revision"] == 1
        assert play["schema_version"] == 1
        assert play["document"] == play_document()
        assert play["created_by_coach_id"] == owner["coach"]["id"]
        assert play["folder_id"] is None
        assert play["copied_from_play_id"] is None
        with app.app_context():
            row = db.session.get(MotionPlay, play["id"])
            assert row.organization_id == Coach.query.filter_by(email="owner@example.com").one().organization_id

    def test_list_is_the_whole_organization_newest_first(self, client, owner, teammate):
        a = create_play(client, owner["headers"], name="A")
        b = create_play(client, teammate["headers"], name="B")
        assert [p["id"] for p in client.get("/api/motion-lab/plays", headers=owner["headers"]).get_json()] == [b["id"], a["id"]]
        save_play(client, owner["headers"], a)
        assert [p["name"] for p in client.get("/api/motion-lab/plays", headers=teammate["headers"]).get_json()] == ["A", "B"]

    def test_get_save_and_delete(self, client, owner):
        play = create_play(client, owner["headers"])
        document = play_document(filter="offense")
        saved = save_play(client, owner["headers"], play, name="Mesh 2", document=document)
        assert saved.status_code == 200
        body = saved.get_json()
        assert (body["revision"], body["name"], body["document"]) == (2, "Mesh 2", document)
        assert client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).get_json() == body
        assert client.delete(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).status_code == 204
        assert client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).status_code == 404

    def test_any_coach_in_the_organization_may_edit(self, client, owner, teammate):
        play = create_play(client, owner["headers"])
        response = save_play(client, teammate["headers"], play, name="DC's version")
        assert response.status_code == 200
        assert response.get_json()["created_by_coach_id"] == owner["coach"]["id"]
        assert client.delete(f"/api/motion-lab/plays/{play['id']}", headers=teammate["headers"]).status_code == 204

    def test_rename_bumps_the_revision_but_filing_does_not(self, client, owner):
        play = create_play(client, owner["headers"])
        folder = create_motion_folder(client, owner["headers"])
        filed = client.patch(f"/api/motion-lab/plays/{play['id']}", json={"folder_id": folder["id"]}, headers=owner["headers"]).get_json()
        assert (filed["folder_id"], filed["revision"]) == (folder["id"], 1)
        renamed = client.patch(f"/api/motion-lab/plays/{play['id']}", json={"name": "Mesh Rt"}, headers=owner["headers"]).get_json()
        assert (renamed["name"], renamed["revision"]) == ("Mesh Rt", 2)
        unfiled = client.patch(f"/api/motion-lab/plays/{play['id']}", json={"folder_id": None}, headers=owner["headers"]).get_json()
        assert (unfiled["folder_id"], unfiled["revision"]) == (None, 2)
        assert client.patch(f"/api/motion-lab/plays/{play['id']}", json={}, headers=owner["headers"]).status_code == 422


class TestOrganizationBoundary:
    def test_another_organization_s_play_does_not_exist(self, client, owner, rival):
        play = create_play(client, owner["headers"])
        h = rival["headers"]
        responses = [
            client.get(f"/api/motion-lab/plays/{play['id']}", headers=h),
            save_play(client, h, play),
            client.patch(f"/api/motion-lab/plays/{play['id']}", json={"name": "stolen"}, headers=h),
            client.post(f"/api/motion-lab/plays/{play['id']}/copy", headers=h),
            client.delete(f"/api/motion-lab/plays/{play['id']}", headers=h),
        ]
        assert [r.status_code for r in responses] == [404] * 5
        assert client.get(f"/api/motion-lab/plays/999999", headers=h).get_json() == responses[0].get_json()
        assert client.get("/api/motion-lab/plays", headers=h).get_json() == []
        assert client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).get_json()["name"] == "Mesh"

    def test_another_organization_s_folder_cannot_hold_a_play(self, client, owner, rival):
        their_folder = create_motion_folder(client, rival["headers"])
        response = client.post(
            "/api/motion-lab/plays",
            json={"name": "x", "document": play_document(), "schema_version": 1, "folder_id": their_folder["id"]},
            headers=owner["headers"],
        )
        assert response.status_code == 404
        mine = create_play(client, owner["headers"])
        assert client.patch(f"/api/motion-lab/plays/{mine['id']}", json={"folder_id": their_folder["id"]}, headers=owner["headers"]).status_code == 404
        assert client.get("/api/folders?area=motion", headers=owner["headers"]).get_json() == []

    def test_another_organization_s_look_does_not_exist(self, client, owner, rival):
        look = client.post("/api/motion-lab/looks", json={"name": "Trips", "document": look_document(), "schema_version": 1}, headers=owner["headers"]).get_json()
        assert client.get(f"/api/motion-lab/looks/{look['id']}", headers=rival["headers"]).status_code == 404
        assert client.delete(f"/api/motion-lab/looks/{look['id']}", headers=rival["headers"]).status_code == 404
        assert client.get("/api/motion-lab/looks", headers=rival["headers"]).get_json() == []


class TestRevisions:
    def test_a_save_from_an_older_revision_is_refused_and_changes_nothing(self, client, owner, teammate):
        play = create_play(client, owner["headers"])
        # The DC saves first from revision 1.
        assert save_play(client, teammate["headers"], play, name="DC").status_code == 200
        # The head coach's editor still believes revision 1.
        stale = save_play(client, owner["headers"], play, name="HC", document=play_document(filter="none"))
        assert stale.status_code == 409
        assert stale.get_json()["reason"] == "revision_conflict"
        current = client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).get_json()
        assert (current["name"], current["revision"], current["document"]) == ("DC", 2, play_document())

    def test_revisions_increment_one_save_at_a_time(self, client, owner):
        play = create_play(client, owner["headers"])
        for expected in (2, 3, 4):
            response = save_play(client, owner["headers"], play)
            assert response.get_json()["revision"] == expected
            play = response.get_json()
        assert save_play(client, owner["headers"], {**play, "revision": 2}).status_code == 409

    def test_a_rename_makes_an_open_editor_s_next_save_stale(self, client, owner):
        play = create_play(client, owner["headers"])
        client.patch(f"/api/motion-lab/plays/{play['id']}", json={"name": "Renamed in Library"}, headers=owner["headers"])
        assert save_play(client, owner["headers"], play).status_code == 409

    def test_base_revision_is_required(self, client, owner):
        play = create_play(client, owner["headers"])
        response = client.put(
            f"/api/motion-lab/plays/{play['id']}",
            json={"name": "x", "document": play_document(), "schema_version": 1},
            headers=owner["headers"],
        )
        assert response.status_code == 422


class TestCopies:
    def test_a_copy_is_independent_and_remembers_its_source(self, client, owner):
        folder = create_motion_folder(client, owner["headers"])
        original = create_play(client, owner["headers"], name="Opponent Mesh", folder_id=folder["id"])
        copy = client.post(f"/api/motion-lab/plays/{original['id']}/copy", headers=owner["headers"]).get_json()
        assert copy["name"] == "Opponent Mesh (copy)"
        assert copy["copied_from_play_id"] == original["id"]
        assert copy["folder_id"] == folder["id"]
        assert copy["revision"] == 1
        assert copy["document"] == original["document"]

        edited = play_document(filter="defense")
        save_play(client, owner["headers"], copy, document=edited)
        assert client.get(f"/api/motion-lab/plays/{original['id']}", headers=owner["headers"]).get_json()["document"] == play_document()

        save_play(client, owner["headers"], original, name="Opponent Mesh v2")
        assert client.get(f"/api/motion-lab/plays/{copy['id']}", headers=owner["headers"]).get_json()["document"] == edited

        client.delete(f"/api/motion-lab/plays/{original['id']}", headers=owner["headers"])
        survivor = client.get(f"/api/motion-lab/plays/{copy['id']}", headers=owner["headers"]).get_json()
        assert survivor["copied_from_play_id"] is None
        assert survivor["document"] == edited

    def test_a_copy_can_be_named_and_filed(self, client, owner):
        folder = create_motion_folder(client, owner["headers"], name="Cover 3")
        original = create_play(client, owner["headers"])
        copy = client.post(
            f"/api/motion-lab/plays/{original['id']}/copy",
            json={"name": "Mesh vs Cover 3", "folder_id": folder["id"]},
            headers=owner["headers"],
        ).get_json()
        assert (copy["name"], copy["folder_id"]) == ("Mesh vs Cover 3", folder["id"])


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


class TestStructuralValidation:
    def post(self, client, owner, document, schema_version=1, **raw):
        body = {"name": "x", "document": document, "schema_version": schema_version, **raw}
        return client.post("/api/motion-lab/plays", json=body, headers=owner["headers"])

    @pytest.mark.parametrize(
        "mutate, fragment",
        [
            (lambda d: {**d, "schedule": {"O8": [0, 1]}}, "unknown field(s) schedule"),
            (lambda d: {**d, "players": "everyone"}, "players: must be a list"),
            (lambda d: {k: v for k, v in d.items() if k != "players"}, "missing field(s) players"),
            (lambda d: {**d, "players": [{**d["players"][0], "positionAt": [1, 2]}] + d["players"][1:]}, "unknown field(s) positionAt"),
            (lambda d: {**d, "players": [{**d["players"][0], "x": True}] + d["players"][1:]}, "players[0].x: must be a number"),
            (lambda d: {**d, "players": [{**d["players"][0], "x": 99999}] + d["players"][1:]}, "players[0].x: must be between"),
            (lambda d: {**d, "players": [{**d["players"][0], "side": "special"}] + d["players"][1:]}, "players[0].side: must be one of"),
            (lambda d: {**d, "players": [{**d["players"][0], "label": "L" * 40}] + d["players"][1:]}, "players[0].label: must be at most"),
            (lambda d: {**d, "players": d["players"] + [d["players"][0]]}, "is used by more than one player"),
            (lambda d: {**d, "players": [make_player(i) for i in range(MAX_PLAYERS + 1)]}, f"at most {MAX_PLAYERS} players"),
            (lambda d: {**d, "players": [{**d["players"][0], "path": [{"x": 1, "y": 1}] * (MAX_PATH_ANCHORS + 1)}] + d["players"][1:]}, f"at most {MAX_PATH_ANCHORS} anchors"),
            (lambda d: {**d, "ball": {"kind": "teleport"}}, "ball.kind: must be one of"),
            (lambda d: {**d, "ball": {"kind": "pass", "targetId": "O8", "catchPoint": {"x": 1}}}, "ball.catchPoint: missing field(s) y"),
            (lambda d: {**d, "engagements": [{"a": "O1", "b": "D1"}]}, "missing field(s) point"),
            (lambda d: {**d, "engagements": [{**d["engagements"][0], "auto": "true"}]}, "engagements[0].auto: must be true or false"),
            # 1 and 0 are the trap: Python would take both for integers and
            # JavaScript would take both for truthiness. `auto` is a boolean.
            (lambda d: {**d, "engagements": [{**d["engagements"][0], "auto": 1}]}, "engagements[0].auto: must be true or false"),
            (lambda d: {**d, "engagements": [{**d["engagements"][0], "auto": 0}]}, "engagements[0].auto: must be true or false"),
            # `null` is not "false". Absence is how a legacy engagement says
            # the coach owns its point; an explicit null says nothing at all.
            (lambda d: {**d, "engagements": [{**d["engagements"][0], "auto": None}]}, "engagements[0].auto: must be true or false"),
            (lambda d: {**d, "situation": {**d["situation"], "hash": "center"}}, "situation.hash: must be one of"),
            (lambda d: {**d, "filter": "special teams"}, "filter: must be one of"),
        ],
    )
    def test_refuses_what_is_not_the_authored_model(self, client, owner, mutate, fragment):
        response = self.post(client, owner, mutate(play_document()))
        assert response.status_code == 422, response.get_json()
        assert fragment in response.get_json()["details"]["document"][0]

    def test_refuses_non_finite_numbers_sent_as_raw_json(self, client, owner):
        raw = json.dumps({"name": "x", "document": play_document(), "schema_version": 1}).replace('"x": 5.0', '"x": NaN', 1)
        response = client.post(
            "/api/motion-lab/plays", data=raw, content_type="application/json", headers=owner["headers"]
        )
        assert response.status_code == 422
        assert "finite" in response.get_json()["details"]["document"][0]

    def test_refuses_an_unsupported_schema_version(self, client, owner):
        response = self.post(client, owner, play_document(), schema_version=2)
        assert response.status_code == 422
        assert "schema_version" in response.get_json()["details"]

    def test_refuses_a_document_that_is_not_an_object(self, client, owner):
        assert self.post(client, owner, ["players"]).status_code == 422

    def test_refuses_a_document_over_the_size_ceiling(self, client, owner):
        """Every count within its limit, the whole over the byte ceiling - and
        the request itself still under the transport ceiling, so it is the
        DOCUMENT check that refuses it."""
        from app.routes.motion_lab import MAX_REQUEST_BYTES
        from app.services.motion_documents import MAX_PLAY_DOCUMENT_BYTES

        anchor = {"x": 12.3456789012345, "y": -9.8765432109876}
        document = play_document(players=[])
        i = 0
        while len(json.dumps(document, separators=(",", ":"))) <= MAX_PLAY_DOCUMENT_BYTES:
            document["players"].append(make_player(i, path=[anchor] * MAX_PATH_ANCHORS))
            i += 1
        assert len(document["players"]) <= MAX_PLAYERS
        raw = json.dumps({"name": "x", "document": document, "schema_version": 1}, separators=(",", ":"))
        assert len(raw) < MAX_REQUEST_BYTES
        response = client.post("/api/motion-lab/plays", data=raw, content_type="application/json", headers=owner["headers"])
        assert (response.status_code, response.get_json()["reason"]) == (413, "document_too_large")

    def test_refuses_a_request_body_over_the_transport_ceiling_before_parsing(self, client, owner):
        from app.routes.motion_lab import MAX_REQUEST_BYTES

        raw = '{"name": "x", "schema_version": 1, "document": {"players": []}, "pad": "' + "a" * MAX_REQUEST_BYTES + '"}'
        response = client.post("/api/motion-lab/plays", data=raw, content_type="application/json", headers=owner["headers"])
        assert (response.status_code, response.get_json()["reason"]) == (413, "document_too_large")

    def test_refuses_a_blank_name(self, client, owner):
        response = client.post(
            "/api/motion-lab/plays",
            json={"name": "   ", "document": play_document(), "schema_version": 1},
            headers=owner["headers"],
        )
        assert response.status_code == 422

    def test_does_not_judge_the_football(self, client, owner):
        """A pass to nobody, an engagement between strangers: structurally fine,
        so stored. The engine drops dangling intent when the play is opened."""
        document = play_document(
            ball={"kind": "handoff", "carrierId": "NOBODY"},
            engagements=[{"id": "e", "kind": "engage", "a": "GHOST", "b": "D1", "point": {"x": 0, "y": 0}}],
        )
        assert self.post(client, owner, document).status_code == 201


# ---------------------------------------------------------------------------
# Engagement.auto - the one additive field (ML-UX-5)
# ---------------------------------------------------------------------------


def engagement(**overrides):
    """The engagement the editor sends, with `auto` set or left off."""
    return {"id": "e1", "kind": "engage", "a": "O1", "b": "D1", "point": {"x": 7.0, "y": 1.0}, "release": "O1", **overrides}


class TestEngagementAuto:
    """`auto` says PEIRA chose the meeting point rather than the coach, so the
    editor can keep an inferred point on the end of a blocker's path as that
    path is redrawn. The server's whole job here is to carry it - including
    carrying its ABSENCE, which is what a play written before the field
    existed uses to mean "the coach owns this point".

    Written after the audit found the frontend persisting `auto` into a
    validator that refused it: every editor test uses the local repository, so
    nothing in either suite had ever sent the real document to the real route.
    """

    def round_trip(self, client, owner, eng):
        created = create_play(client, owner["headers"], document=play_document(engagements=[eng]))
        fetched = client.get(f"/api/motion-lab/plays/{created['id']}", headers=owner["headers"])
        assert fetched.status_code == 200, fetched.get_json()
        return created, fetched.get_json()

    @pytest.mark.parametrize("value", [True, False])
    def test_the_server_accepts_and_returns_it_unchanged(self, client, owner, value):
        created, fetched = self.round_trip(client, owner, engagement(auto=value))
        assert created["document"]["engagements"][0]["auto"] is value
        assert fetched["document"]["engagements"][0]["auto"] is value

    def test_a_legacy_engagement_has_no_auto_and_still_has_none_afterwards(self, client, owner):
        # THE POINT OF THE WHOLE EXERCISE. Accepting the field is easy; not
        # inventing it is the part that keeps old plays honest.
        created, fetched = self.round_trip(client, owner, engagement())
        assert "auto" not in created["document"]["engagements"][0]
        assert "auto" not in fetched["document"]["engagements"][0]

    def test_saving_an_existing_play_neither_adds_nor_drops_it(self, client, owner):
        play = create_play(client, owner["headers"], document=play_document(engagements=[engagement(auto=True)]))
        document = play_document(engagements=[engagement(auto=True), engagement(id="e2", b="D2")])
        saved = save_play(client, owner["headers"], play, document=document)
        assert saved.status_code == 200, saved.get_json()
        stored = saved.get_json()["document"]["engagements"]
        assert stored[0]["auto"] is True
        assert "auto" not in stored[1]

    def test_it_reaches_the_jsonb_column_without_a_schema_bump(self, client, owner, app):
        """What lands in JSONB is what the editor sent, `auto` included."""
        play = create_play(client, owner["headers"], document=play_document(engagements=[engagement(auto=True)]))
        with app.app_context():
            row = db.session.get(MotionPlay, play["id"])
            assert row.document["engagements"][0]["auto"] is True
            assert row.schema_version == 1

    def test_the_rest_of_the_engagement_contract_is_untouched(self, client, owner):
        # Adding a key must not have loosened the object: everything the
        # validator refused before it, it still refuses beside it.
        for bad, fragment in [
            ({**engagement(auto=True), "nudge": 1}, "unknown field(s) nudge"),
            ({k: v for k, v in engagement(auto=True).items() if k != "point"}, "missing field(s) point"),
            ({**engagement(auto=True), "kind": "tackle"}, "kind: must be one of"),
            ({**engagement(auto=True), "a": 7}, "a: must be a string"),
            ({**engagement(auto=True), "point": {"x": 1}}, "point: missing field(s) y"),
        ]:
            response = client.post(
                "/api/motion-lab/plays",
                json={"name": "x", "document": play_document(engagements=[bad]), "schema_version": 1},
                headers=owner["headers"],
            )
            assert response.status_code == 422, response.get_json()
            assert fragment in response.get_json()["details"]["document"][0]


# ---------------------------------------------------------------------------
# Looks
# ---------------------------------------------------------------------------


class TestLooks:
    def test_create_list_save_and_delete(self, client, owner, teammate):
        created = client.post(
            "/api/motion-lab/looks",
            json={"name": "Trips Rt", "document": look_document(), "schema_version": 1},
            headers=owner["headers"],
        )
        assert created.status_code == 201
        look = created.get_json()
        assert (look["revision"], look["document"]) == (1, look_document())
        assert [row["id"] for row in client.get("/api/motion-lab/looks", headers=teammate["headers"]).get_json()] == [look["id"]]

        moved = look_document()
        moved["players"][0]["x"] = 30.0
        saved = client.put(
            f"/api/motion-lab/looks/{look['id']}",
            json={"name": "Trips Lt", "document": moved, "schema_version": 1, "base_revision": 1},
            headers=teammate["headers"],
        )
        assert (saved.status_code, saved.get_json()["revision"]) == (200, 2)
        stale = client.put(
            f"/api/motion-lab/looks/{look['id']}",
            json={"name": "x", "document": look_document(), "schema_version": 1, "base_revision": 1},
            headers=owner["headers"],
        )
        assert (stale.status_code, stale.get_json()["reason"]) == (409, "revision_conflict")
        assert client.delete(f"/api/motion-lab/looks/{look['id']}", headers=owner["headers"]).status_code == 204
        assert client.get("/api/motion-lab/looks", headers=owner["headers"]).get_json() == []

    def test_a_look_is_not_a_play(self, client, owner):
        """Looks hold an arrangement only - never a ball, engagements or situation."""
        for extra in ({"ball": None}, {"engagements": []}, {"situation": {}}):
            response = client.post(
                "/api/motion-lab/looks",
                json={"name": "x", "document": {**look_document(), **extra}, "schema_version": 1},
                headers=owner["headers"],
            )
            assert response.status_code == 422


# ---------------------------------------------------------------------------
# Folder areas
# ---------------------------------------------------------------------------


class TestFolderAreas:
    def test_existing_and_default_folders_are_quiz_folders(self, client, owner, app):
        quiz_folder = client.post("/api/folders", json={"name": "2026 Season"}, headers=owner["headers"]).get_json()
        assert quiz_folder["area"] == "quizzes"
        with app.app_context():
            assert db.session.get(Folder, quiz_folder["id"]).area == "quizzes"

    def test_the_two_trees_never_appear_in_each_other(self, client, owner):
        quiz_folder = client.post("/api/folders", json={"name": "Week 3"}, headers=owner["headers"]).get_json()
        motion_folder = create_motion_folder(client, owner["headers"], name="Defense")
        assert [f["id"] for f in client.get("/api/folders", headers=owner["headers"]).get_json()] == [quiz_folder["id"]]
        assert [f["id"] for f in client.get("/api/folders?area=quizzes", headers=owner["headers"]).get_json()] == [quiz_folder["id"]]
        assert [f["id"] for f in client.get("/api/folders?area=motion", headers=owner["headers"]).get_json()] == [motion_folder["id"]]
        assert client.get("/api/folders?area=plays", headers=owner["headers"]).status_code == 422

    def test_a_quiz_cannot_be_filed_in_a_motion_folder(self, client, owner):
        motion_folder = create_motion_folder(client, owner["headers"])
        quiz = client.post("/api/quizzes", json={"title": "Week 3 Test"}, headers=owner["headers"]).get_json()
        response = client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": motion_folder["id"]}, headers=owner["headers"])
        assert response.status_code == 404
        quiz_folder = client.post("/api/folders", json={"name": "Week 3"}, headers=owner["headers"]).get_json()
        assert client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": quiz_folder["id"]}, headers=owner["headers"]).status_code == 200

    def test_a_play_cannot_be_filed_in_a_quiz_folder(self, client, owner):
        quiz_folder = client.post("/api/folders", json={"name": "Week 3"}, headers=owner["headers"]).get_json()
        response = client.post(
            "/api/motion-lab/plays",
            json={"name": "x", "document": play_document(), "schema_version": 1, "folder_id": quiz_folder["id"]},
            headers=owner["headers"],
        )
        assert response.status_code == 404

    def test_a_subfolder_stays_in_its_parent_s_area(self, client, owner):
        quiz_folder = client.post("/api/folders", json={"name": "Season"}, headers=owner["headers"]).get_json()
        motion_folder = create_motion_folder(client, owner["headers"])
        assert client.post("/api/folders", json={"name": "x", "area": "motion", "parent_folder_id": quiz_folder["id"]}, headers=owner["headers"]).status_code == 404
        assert client.post("/api/folders", json={"name": "x", "parent_folder_id": motion_folder["id"]}, headers=owner["headers"]).status_code == 404
        nested = create_motion_folder(client, owner["headers"], name="Coverages", parent=motion_folder["id"])
        deeper = create_motion_folder(client, owner["headers"], name="Cover 3", parent=nested["id"])
        assert deeper["parent_folder_id"] == nested["id"]

    def test_motion_folders_are_the_organization_s_not_the_creator_s(self, client, owner, teammate):
        folder = create_motion_folder(client, owner["headers"])
        assert [f["id"] for f in client.get("/api/folders?area=motion", headers=teammate["headers"]).get_json()] == [folder["id"]]
        assert client.patch(f"/api/folders/{folder['id']}", json={"name": "Defense Library"}, headers=teammate["headers"]).status_code == 200

    def test_deleting_a_motion_folder_returns_its_plays_to_the_library_root(self, client, owner):
        folder = create_motion_folder(client, owner["headers"])
        play = create_play(client, owner["headers"], folder_id=folder["id"])
        assert client.delete(f"/api/folders/{folder['id']}", headers=owner["headers"]).status_code == 204
        after = client.get(f"/api/motion-lab/plays/{play['id']}", headers=owner["headers"]).get_json()
        assert (after["folder_id"], after["revision"], after["document"]) == (None, 1, play_document())

    def test_a_motion_folder_with_subfolders_cannot_be_deleted(self, client, owner):
        folder = create_motion_folder(client, owner["headers"])
        create_motion_folder(client, owner["headers"], name="Child", parent=folder["id"])
        assert client.delete(f"/api/folders/{folder['id']}", headers=owner["headers"]).status_code == 422

    def test_quiz_folder_visibility_is_unchanged_by_motion_folders(self, client, owner, teammate):
        """visible_folders is the Quizzes rule. A motion folder a coach created
        must not make it into their quiz tree, and the quiz tree's own rules
        (own folders, folders holding own quizzes, their ancestors) hold."""
        create_motion_folder(client, owner["headers"], name="Motion Only")
        parent = client.post("/api/folders", json={"name": "Season"}, headers=owner["headers"]).get_json()
        child = client.post("/api/folders", json={"name": "Week 1", "parent_folder_id": parent["id"]}, headers=teammate["headers"]).get_json()
        quiz = client.post("/api/quizzes", json={"title": "DC test"}, headers=teammate["headers"]).get_json()
        client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": child["id"]}, headers=teammate["headers"])
        assert sorted(f["name"] for f in client.get("/api/folders", headers=owner["headers"]).get_json()) == ["Season"]
        assert sorted(f["name"] for f in client.get("/api/folders", headers=teammate["headers"]).get_json()) == ["Season", "Week 1"]

    def test_admin_view_lists_quiz_folders_only(self, client, owner):
        client.post("/api/folders", json={"name": "Week 3"}, headers=owner["headers"])
        create_motion_folder(client, owner["headers"], name="Defense")
        body = client.get("/api/organizations/quizzes", headers=owner["headers"]).get_json()
        assert [f["name"] for f in body["folders"]] == ["Week 3"]


# ---------------------------------------------------------------------------
# Organization merge carries Motion Lab content whole
# ---------------------------------------------------------------------------


class TestMerge:
    def test_plays_looks_and_their_folders_move_together(self, app, client, register_coach):
        from app.services import organization_merge as merge

        _dest, _t1, dest_headers = register_coach(username="dest", email="dest@example.com", organization="Dest")
        _src, _t2, src_headers = register_coach(username="src", email="src@example.com", organization="Src")
        make_owner(app, "dest@example.com")
        make_owner(app, "src@example.com")
        folder = create_motion_folder(client, src_headers, name="Opponent")
        original = create_play(client, src_headers, name="Mesh", folder_id=folder["id"])
        copy = client.post(f"/api/motion-lab/plays/{original['id']}/copy", headers=src_headers).get_json()
        look = client.post("/api/motion-lab/looks", json={"name": "Trips", "document": look_document(), "schema_version": 1}, headers=src_headers).get_json()

        with app.app_context():
            source_id = Coach.query.filter_by(email="src@example.com").one().organization_id
            destination_id = Coach.query.filter_by(email="dest@example.com").one().organization_id
            plan = merge.preview(source_id, destination_id)
            assert plan["source"]["counts"]["motion_plays"] == 2
            assert plan["source"]["counts"]["motion_looks"] == 1
            coach_id = plan["coaches"][0]["coach_id"]
            merge.execute(
                source_id,
                destination_id,
                expected_fingerprint=plan["fingerprint"],
                performed_by=Coach.query.filter_by(email="dest@example.com").one(),
                decisions={str(coach_id): "MEMBER"},
                acknowledge_collisions=True,
                acknowledge_duplicate_players=True,
            )
            moved = db.session.get(MotionPlay, copy["id"])
            assert moved.organization_id == destination_id
            assert moved.folder_id == folder["id"]
            assert moved.copied_from_play_id == original["id"]
            assert db.session.get(MotionLook, look["id"]).organization_id == destination_id
            assert db.session.get(Folder, folder["id"]).organization_id == destination_id

        titles = sorted(p["name"] for p in client.get("/api/motion-lab/plays", headers=dest_headers).get_json())
        assert titles == ["Mesh", "Mesh (copy)"]
