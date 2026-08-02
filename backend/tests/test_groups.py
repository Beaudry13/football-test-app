"""Group CRUD, player-list management, and coach-scoped isolation."""


def create_group(client, headers, name="Defense", players=None):
    response = client.post("/api/groups", json={"name": name}, headers=headers)
    assert response.status_code == 201
    group = response.get_json()
    if players is not None:
        set_response = client.put(
            f"/api/groups/{group['id']}/players", json={"players": players}, headers=headers
        )
        assert set_response.status_code == 200
        group = set_response.get_json()
    return group


def test_create_and_list_groups(client, coach_headers):
    create_group(client, coach_headers, name="Defense")
    create_group(client, coach_headers, name="Offense")

    response = client.get("/api/groups", headers=coach_headers)
    assert response.status_code == 200
    names = {g["name"] for g in response.get_json()}
    assert names == {"Defense", "Offense"}


def test_group_endpoints_require_auth(client):
    assert client.get("/api/groups").status_code == 401
    assert client.post("/api/groups", json={"name": "x"}).status_code == 401


def test_set_group_players_full_replace(client, coach_headers):
    group = create_group(client, coach_headers, name="Defense", players=["Jordan Smith", "Alex Lee"])
    assert [p["player_name"] for p in group["players"]] == ["Jordan Smith", "Alex Lee"]

    replaced = client.put(
        f"/api/groups/{group['id']}/players", json={"players": ["Sam Rivera"]}, headers=coach_headers
    ).get_json()
    assert [p["player_name"] for p in replaced["players"]] == ["Sam Rivera"]


def test_setting_group_players_rejects_case_insensitive_duplicates(client, coach_headers):
    group = create_group(client, coach_headers, name="Defense")
    response = client.put(
        f"/api/groups/{group['id']}/players",
        json={"players": ["Jordan Smith", "jordan smith"]},
        headers=coach_headers,
    )
    assert response.status_code == 422


def test_rename_group(client, coach_headers):
    group = create_group(client, coach_headers, name="Defense")
    response = client.patch(
        f"/api/groups/{group['id']}", json={"name": "Defense (Varsity)"}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["name"] == "Defense (Varsity)"


def test_delete_group(client, coach_headers):
    group = create_group(client, coach_headers, name="Defense")
    delete_response = client.delete(f"/api/groups/{group['id']}", headers=coach_headers)
    assert delete_response.status_code == 204
    assert client.get(f"/api/groups/{group['id']}", headers=coach_headers).status_code == 404


def test_groups_are_scoped_per_organization(client, coach_headers, register_coach):
    create_group(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get("/api/groups", headers=other_headers)
    assert response.status_code == 200
    assert response.get_json() == []


def test_cannot_view_rename_or_delete_another_organizations_group(client, coach_headers, register_coach):
    group = create_group(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    assert client.get(f"/api/groups/{group['id']}", headers=other_headers).status_code == 404
    assert client.patch(
        f"/api/groups/{group['id']}", json={"name": "Hijacked"}, headers=other_headers
    ).status_code == 404
    assert client.delete(f"/api/groups/{group['id']}", headers=other_headers).status_code == 404
