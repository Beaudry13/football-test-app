"""Folder CRUD, quiz assignment, coach-scoped isolation, and simple
two-level nesting (root folder -> at most one level of subfolders)."""

from tests.test_quizzes import create_quiz


def create_folder(client, headers, name="Fall Camp", parent_folder_id=None):
    response = client.post(
        "/api/folders",
        json={"name": name, "parent_folder_id": parent_folder_id},
        headers=headers,
    )
    assert response.status_code == 201
    return response.get_json()


def test_create_and_list_folders(client, coach_headers):
    create_folder(client, coach_headers, name="Defense")
    create_folder(client, coach_headers, name="Offense")

    response = client.get("/api/folders", headers=coach_headers)
    assert response.status_code == 200
    names = {f["name"] for f in response.get_json()}
    assert names == {"Defense", "Offense"}


def test_folder_endpoints_require_auth(client):
    assert client.get("/api/folders").status_code == 401
    assert client.post("/api/folders", json={"name": "x"}).status_code == 401


def test_rename_folder(client, coach_headers):
    folder = create_folder(client, coach_headers, name="Defense")
    response = client.patch(
        f"/api/folders/{folder['id']}", json={"name": "Defense (2026)"}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["name"] == "Defense (2026)"


def test_assign_quiz_to_folder_and_back_to_uncategorized(client, coach_headers):
    folder = create_folder(client, coach_headers, name="Fall Camp")
    quiz = create_quiz(client, coach_headers)
    assert quiz["folder_id"] is None

    patch_response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": folder["id"]}, headers=coach_headers
    )
    assert patch_response.status_code == 200
    assert patch_response.get_json()["folder_id"] == folder["id"]

    folders = client.get("/api/folders", headers=coach_headers).get_json()
    assert next(f for f in folders if f["id"] == folder["id"])["quiz_count"] == 1

    back_response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": None}, headers=coach_headers
    )
    assert back_response.status_code == 200
    assert back_response.get_json()["folder_id"] is None


def test_deleting_a_folder_does_not_delete_its_quizzes(client, coach_headers):
    folder = create_folder(client, coach_headers, name="Fall Camp")
    quiz = create_quiz(client, coach_headers)
    client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": folder["id"]}, headers=coach_headers)

    delete_response = client.delete(f"/api/folders/{folder['id']}", headers=coach_headers)
    assert delete_response.status_code == 204

    get_response = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers)
    assert get_response.status_code == 200
    assert get_response.get_json()["folder_id"] is None


def test_cannot_assign_a_quiz_to_another_organizations_folder(client, coach_headers, register_coach):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_folder = create_folder(client, other_headers, name="Other Coach's Folder")
    quiz = create_quiz(client, coach_headers)

    response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": other_folder["id"]}, headers=coach_headers
    )
    assert response.status_code == 404


def test_folders_are_scoped_per_organization(client, coach_headers, register_coach):
    create_folder(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get("/api/folders", headers=other_headers)
    assert response.status_code == 200
    assert response.get_json() == []


def test_cannot_rename_or_delete_another_organizations_folder(client, coach_headers, register_coach):
    folder = create_folder(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    assert client.patch(
        f"/api/folders/{folder['id']}", json={"name": "Hijacked"}, headers=other_headers
    ).status_code == 404
    assert client.delete(f"/api/folders/{folder['id']}", headers=other_headers).status_code == 404


# --- Simple two-level nesting -------------------------------------------


def test_create_subfolder_inside_a_root_folder(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])

    assert sub["parent_folder_id"] == root["id"]


def test_listing_folders_reports_subfolder_and_quiz_counts(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    create_folder(client, coach_headers, name="Week 2", parent_folder_id=root["id"])

    folders = client.get("/api/folders", headers=coach_headers).get_json()
    root_listed = next(f for f in folders if f["id"] == root["id"])
    subfolders = [f for f in folders if f["parent_folder_id"] == root["id"]]

    assert root_listed["subfolder_count"] == 2
    assert {f["name"] for f in subfolders} == {"Week 1", "Week 2"}


def test_assign_quiz_directly_to_a_subfolder(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    quiz = create_quiz(client, coach_headers)

    response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": sub["id"]}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["folder_id"] == sub["id"]

    folders = client.get("/api/folders", headers=coach_headers).get_json()
    assert next(f for f in folders if f["id"] == sub["id"])["quiz_count"] == 1
    # It counts against the subfolder only, not its parent.
    assert next(f for f in folders if f["id"] == root["id"])["quiz_count"] == 0


def test_move_quiz_between_root_folder_and_subfolder(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    quiz = create_quiz(client, coach_headers)
    client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": root["id"]}, headers=coach_headers)

    response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": sub["id"]}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["folder_id"] == sub["id"]

    back_to_root = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": root["id"]}, headers=coach_headers
    )
    assert back_to_root.status_code == 200
    assert back_to_root.get_json()["folder_id"] == root["id"]


def test_rename_a_subfolder(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])

    response = client.patch(
        f"/api/folders/{sub['id']}", json={"name": "Week 1 - Install"}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["name"] == "Week 1 - Install"
    # Renaming the child never touches the parent link.
    assert response.get_json()["parent_folder_id"] == root["id"]


def test_renaming_a_root_folder_does_not_affect_its_subfolders(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])

    client.patch(f"/api/folders/{root['id']}", json={"name": "2026 Season (Renamed)"}, headers=coach_headers)

    folders = client.get("/api/folders", headers=coach_headers).get_json()
    still_there = next(f for f in folders if f["id"] == sub["id"])
    assert still_there["name"] == "Week 1"
    assert still_there["parent_folder_id"] == root["id"]


def test_rename_route_cannot_be_used_to_change_or_self_assign_a_parent(client, coach_headers):
    """There is no way to change parent_folder_id after creation - the
    rename schema simply doesn't have the field - which is what makes a
    folder becoming its own parent (or any parent change/cycle) structurally
    impossible rather than something this route has to separately guard."""
    root = create_folder(client, coach_headers, name="2026 Season")

    response = client.patch(
        f"/api/folders/{root['id']}",
        json={"name": "2026 Season", "parent_folder_id": root["id"]},
        headers=coach_headers,
    )
    assert response.status_code == 422

    unchanged = client.get("/api/folders", headers=coach_headers).get_json()
    assert next(f for f in unchanged if f["id"] == root["id"])["parent_folder_id"] is None


def test_cannot_nest_a_folder_under_another_organizations_folder(client, coach_headers, register_coach):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_root = create_folder(client, other_headers, name="Other Org's Season")

    response = client.post(
        "/api/folders",
        json={"name": "Sneaky Subfolder", "parent_folder_id": other_root["id"]},
        headers=coach_headers,
    )
    assert response.status_code == 404


def test_cannot_nest_more_than_two_levels_deep(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])

    response = client.post(
        "/api/folders",
        json={"name": "Too Deep", "parent_folder_id": sub["id"]},
        headers=coach_headers,
    )
    assert response.status_code == 422


def test_creating_a_folder_under_a_nonexistent_parent_is_rejected(client, coach_headers):
    response = client.post(
        "/api/folders", json={"name": "Orphan", "parent_folder_id": 999999}, headers=coach_headers
    )
    assert response.status_code == 404


def test_subfolders_are_scoped_per_organization(client, coach_headers, register_coach):
    root = create_folder(client, coach_headers, name="2026 Season")
    create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    assert client.get("/api/folders", headers=other_headers).get_json() == []


def test_duplicate_folder_names_are_allowed_under_different_parents(client, coach_headers):
    """No uniqueness rule exists on folder name today - nesting shouldn't
    add one. Two different root folders can each have an identically-named
    subfolder."""
    root_a = create_folder(client, coach_headers, name="2026 Season")
    root_b = create_folder(client, coach_headers, name="2027 Season")

    sub_a = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root_a["id"])
    sub_b = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root_b["id"])

    assert sub_a["id"] != sub_b["id"]
    assert sub_a["parent_folder_id"] != sub_b["parent_folder_id"]


def test_deleting_a_subfolder_does_not_affect_its_parent_or_its_quizzes(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    quiz = create_quiz(client, coach_headers)
    client.patch(f"/api/quizzes/{quiz['id']}", json={"folder_id": sub["id"]}, headers=coach_headers)

    response = client.delete(f"/api/folders/{sub['id']}", headers=coach_headers)
    assert response.status_code == 204

    # The quiz falls back to Uncategorized, same as today's flat behavior.
    quiz_after = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
    assert quiz_after["folder_id"] is None

    # The parent root folder is completely unaffected.
    folders = client.get("/api/folders", headers=coach_headers).get_json()
    assert next(f for f in folders if f["id"] == root["id"])["subfolder_count"] == 0


def test_deleting_a_root_folder_with_subfolders_is_blocked(client, coach_headers):
    """The lower-risk choice: block deletion until subfolders are moved or
    deleted first, rather than silently destroying an entire folder tree."""
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])

    response = client.delete(f"/api/folders/{root['id']}", headers=coach_headers)
    assert response.status_code == 422

    # Both folders still exist afterward.
    folders = client.get("/api/folders", headers=coach_headers).get_json()
    assert {f["id"] for f in folders} == {root["id"], sub["id"]}


def test_deleting_a_root_folder_after_its_subfolders_are_gone_succeeds(client, coach_headers):
    root = create_folder(client, coach_headers, name="2026 Season")
    sub = create_folder(client, coach_headers, name="Week 1", parent_folder_id=root["id"])
    client.delete(f"/api/folders/{sub['id']}", headers=coach_headers)

    response = client.delete(f"/api/folders/{root['id']}", headers=coach_headers)
    assert response.status_code == 204


def test_existing_flat_folders_are_unaffected_by_nesting(client, coach_headers):
    """A folder created the old way (no parent_folder_id at all in the
    request) behaves exactly as it always has."""
    response = client.post("/api/folders", json={"name": "Defense"}, headers=coach_headers)
    assert response.status_code == 201
    body = response.get_json()
    assert body["parent_folder_id"] is None
    assert body["subfolder_count"] == 0
