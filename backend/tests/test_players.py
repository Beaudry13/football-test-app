"""Master-roster Player CRUD, canonical group/roster membership, and
organization isolation."""


def create_player(client, headers, first_name="Chris", last_name="Smith", **extra):
    response = client.post(
        "/api/players",
        json={"first_name": first_name, "last_name": last_name, **extra},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def create_group(client, headers, name="Defense"):
    response = client.post("/api/groups", json={"name": name}, headers=headers)
    assert response.status_code == 201
    return response.get_json()


# --- Player CRUD -------------------------------------------------------


def test_create_and_get_player(client, coach_headers):
    player = create_player(client, coach_headers, "Jordan", "Lee", jersey_number="12", position="WR")
    assert player["first_name"] == "Jordan"
    assert player["last_name"] == "Lee"
    assert player["full_name"] == "Jordan Lee"
    assert player["jersey_number"] == "12"
    assert player["position"] == "WR"
    assert player["is_active"] is True

    fetched = client.get(f"/api/players/{player['id']}", headers=coach_headers).get_json()
    assert fetched == player


def test_bulk_create_players(client, coach_headers):
    response = client.post(
        "/api/players/bulk",
        json={
            "players": [
                {"first_name": "A", "last_name": "One"},
                {"first_name": "B", "last_name": "Two", "jersey_number": "5"},
            ]
        },
        headers=coach_headers,
    )
    assert response.status_code == 201
    names = {p["full_name"] for p in response.get_json()}
    assert names == {"A One", "B Two"}


def test_edit_player_preserves_id(client, coach_headers):
    player = create_player(client, coach_headers, "Jordan", "Lee")
    response = client.patch(
        f"/api/players/{player['id']}",
        json={"first_name": "Jordan", "last_name": "Lee-Smith", "jersey_number": "99", "position": "DB"},
        headers=coach_headers,
    )
    assert response.status_code == 200
    updated = response.get_json()
    assert updated["id"] == player["id"]
    assert updated["last_name"] == "Lee-Smith"
    assert updated["jersey_number"] == "99"


def test_deactivate_and_reactivate_player(client, coach_headers):
    player = create_player(client, coach_headers)

    deactivated = client.post(f"/api/players/{player['id']}/deactivate", headers=coach_headers)
    assert deactivated.status_code == 200
    assert deactivated.get_json()["is_active"] is False

    # Default list excludes inactive players...
    active_list = client.get("/api/players", headers=coach_headers).get_json()
    assert player["id"] not in [p["id"] for p in active_list]
    # ...but the record itself, and an explicit inactive filter, still show it.
    assert client.get(f"/api/players/{player['id']}", headers=coach_headers).status_code == 200
    inactive_list = client.get("/api/players?active=false", headers=coach_headers).get_json()
    assert player["id"] in [p["id"] for p in inactive_list]

    reactivated = client.post(f"/api/players/{player['id']}/reactivate", headers=coach_headers)
    assert reactivated.get_json()["is_active"] is True


def test_two_players_with_the_same_name_remain_separate_records(client, coach_headers):
    a = create_player(client, coach_headers, "Chris", "Smith", jersey_number="2", position="WR")
    b = create_player(client, coach_headers, "Chris", "Smith", jersey_number="42", position="LB")

    assert a["id"] != b["id"]
    all_players = client.get("/api/players", headers=coach_headers).get_json()
    matching = [p for p in all_players if p["full_name"] == "Chris Smith"]
    assert len(matching) == 2


def test_blank_name_rejected(client, coach_headers):
    response = client.post(
        "/api/players", json={"first_name": "  ", "last_name": ""}, headers=coach_headers
    )
    assert response.status_code == 422


def test_search_and_position_filter(client, coach_headers):
    create_player(client, coach_headers, "Jordan", "Lee", position="WR")
    create_player(client, coach_headers, "Alex", "Rivera", position="DB")

    search = client.get("/api/players?q=jordan", headers=coach_headers).get_json()
    assert [p["full_name"] for p in search] == ["Jordan Lee"]

    by_position = client.get("/api/players?position=DB", headers=coach_headers).get_json()
    assert [p["full_name"] for p in by_position] == ["Alex Rivera"]


def test_player_endpoints_require_auth(client):
    assert client.get("/api/players").status_code == 401
    assert client.post("/api/players", json={"first_name": "A", "last_name": "B"}).status_code == 401


# --- Organization isolation ---------------------------------------------


def test_players_are_scoped_per_organization(client, coach_headers, register_coach):
    create_player(client, coach_headers, "Mine", "Player")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get("/api/players", headers=other_headers)
    assert response.get_json() == []


def test_cannot_view_or_edit_another_organizations_player(client, coach_headers, register_coach):
    player = create_player(client, coach_headers, "Mine", "Player")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    assert client.get(f"/api/players/{player['id']}", headers=other_headers).status_code == 404
    assert client.patch(
        f"/api/players/{player['id']}",
        json={"first_name": "Hijacked", "last_name": "Player"},
        headers=other_headers,
    ).status_code == 404
    assert client.post(
        f"/api/players/{player['id']}/deactivate", headers=other_headers
    ).status_code == 404


# --- Group membership by Player id --------------------------------------


def test_add_and_remove_group_member_by_player_id(client, coach_headers):
    group = create_group(client, coach_headers)
    player = create_player(client, coach_headers, "Jordan", "Lee")

    add = client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [player["id"]]},
        headers=coach_headers,
    )
    assert add.status_code == 201
    body = add.get_json()
    assert len(body["players"]) == 1
    assert body["players"][0]["player"]["id"] == player["id"]

    remove = client.delete(
        f"/api/groups/{group['id']}/members/{player['id']}", headers=coach_headers
    )
    assert remove.status_code == 204
    after = client.get(f"/api/groups/{group['id']}", headers=coach_headers).get_json()
    assert after["players"] == []


def test_player_can_belong_to_multiple_groups(client, coach_headers):
    player = create_player(client, coach_headers, "Jordan", "Lee")
    group_a = create_group(client, coach_headers, "Safeties")
    group_b = create_group(client, coach_headers, "Special Teams")

    for group in (group_a, group_b):
        response = client.post(
            f"/api/groups/{group['id']}/members",
            json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        assert response.status_code == 201

    for group in (group_a, group_b):
        fetched = client.get(f"/api/groups/{group['id']}", headers=coach_headers).get_json()
        assert fetched["players"][0]["player"]["id"] == player["id"]


def test_adding_same_player_twice_is_idempotent_not_duplicated(client, coach_headers):
    group = create_group(client, coach_headers)
    player = create_player(client, coach_headers)

    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)
    second = client.post(
        f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers
    )
    assert second.status_code == 201
    assert len(second.get_json()["players"]) == 1


def test_removing_from_group_does_not_delete_player(client, coach_headers):
    group = create_group(client, coach_headers)
    player = create_player(client, coach_headers)
    client.post(f"/api/groups/{group['id']}/members", json={"player_ids": [player["id"]]}, headers=coach_headers)

    client.delete(f"/api/groups/{group['id']}/members/{player['id']}", headers=coach_headers)

    assert client.get(f"/api/players/{player['id']}", headers=coach_headers).status_code == 200


def test_cannot_add_another_organizations_player_to_a_group(client, coach_headers, register_coach):
    group = create_group(client, coach_headers)
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_player = create_player(client, other_headers, "Other", "Org")

    response = client.post(
        f"/api/groups/{group['id']}/members",
        json={"player_ids": [other_player["id"]]},
        headers=coach_headers,
    )
    assert response.status_code == 404


def test_cannot_add_player_to_another_organizations_group(client, coach_headers, register_coach):
    player = create_player(client, coach_headers)
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_group = create_group(client, other_headers, "Other Org Group")

    response = client.post(
        f"/api/groups/{other_group['id']}/members",
        json={"player_ids": [player["id"]]},
        headers=coach_headers,
    )
    assert response.status_code == 404
