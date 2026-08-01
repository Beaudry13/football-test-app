"""Folder CRUD, quiz assignment, and coach-scoped isolation."""

from tests.test_quizzes import create_quiz


def create_folder(client, headers, name="Fall Camp"):
    response = client.post("/api/folders", json={"name": name}, headers=headers)
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


def test_cannot_assign_a_quiz_to_another_coachs_folder(client, coach_headers, register_coach):
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")
    other_folder = create_folder(client, other_headers, name="Other Coach's Folder")
    quiz = create_quiz(client, coach_headers)

    response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"folder_id": other_folder["id"]}, headers=coach_headers
    )
    assert response.status_code == 404


def test_folders_are_scoped_per_coach(client, coach_headers, register_coach):
    create_folder(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    response = client.get("/api/folders", headers=other_headers)
    assert response.status_code == 200
    assert response.get_json() == []


def test_cannot_rename_or_delete_another_coachs_folder(client, coach_headers, register_coach):
    folder = create_folder(client, coach_headers, name="Mine")
    _, _, other_headers = register_coach(username="coach2", email="coach2@example.com")

    assert client.patch(
        f"/api/folders/{folder['id']}", json={"name": "Hijacked"}, headers=other_headers
    ).status_code == 404
    assert client.delete(f"/api/folders/{folder['id']}", headers=other_headers).status_code == 404
