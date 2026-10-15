"""Concept cleanup: one "Motion adjustment", not five spellings of it.

Find concepts that look like one idea; merge them into the one a coach keeps -
questions retagged, merged concepts archived (never deleted). Admins only.
"""


def _concept(client, headers, name):
    return client.post("/api/concepts", json={"name": name}, headers=headers).get_json()


def _question(client, headers, quiz_id, concept_id):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": "Your check?",
            "question_type": "multiple_choice",
            "options": [{"option_text": "A", "is_correct_answer": True}, {"option_text": "B"}],
            "concept_id": concept_id,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def test_finds_spellings_of_one_idea_and_suggests_the_most_used(client, coach_headers):
    a = _concept(client, coach_headers, "Motion adjustment")
    b = _concept(client, coach_headers, "Motion-Adjust")
    c = _concept(client, coach_headers, "Motion Ajdustment")
    _concept(client, coach_headers, "Leverage")
    quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
    _question(client, coach_headers, quiz["id"], b["id"])
    _question(client, coach_headers, quiz["id"], b["id"])
    _question(client, coach_headers, quiz["id"], a["id"])
    groups = client.get("/api/concepts/duplicates", headers=coach_headers).get_json()
    assert len(groups) == 1
    assert {e["id"] for e in groups[0]["concepts"]} == {a["id"], b["id"], c["id"]}
    assert groups[0]["suggested_keep"] == b["id"]


def test_merging_retags_questions_and_archives_the_spellings(client, coach_headers):
    keep = _concept(client, coach_headers, "Motion adjustment")
    dupe = _concept(client, coach_headers, "Motion-Adjust")
    quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
    q = _question(client, coach_headers, quiz["id"], dupe["id"])
    response = client.post(
        "/api/concepts/merge", json={"keep_id": keep["id"], "merge_ids": [dupe["id"]]}, headers=coach_headers
    )
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["retagged"] == 1
    full = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
    assert full["questions"][0]["id"] == q["id"]
    assert full["questions"][0]["concept"]["id"] == keep["id"]
    names = [c["name"] for c in client.get("/api/concepts", headers=coach_headers).get_json()]
    assert names == ["Motion adjustment"]
    assert client.get("/api/concepts/duplicates", headers=coach_headers).get_json() == []


def test_only_an_admin_merges_and_only_within_the_organization(client, register_coach, invite_teammate):
    _, _, admin = register_coach()
    keep = _concept(client, admin, "Motion adjustment")
    dupe = _concept(client, admin, "Motion-Adjust")
    _, _, member = invite_teammate(admin)
    refused = client.post("/api/concepts/merge", json={"keep_id": keep["id"], "merge_ids": [dupe["id"]]}, headers=member)
    assert refused.status_code == 403
    _, _, rival = register_coach(username="coach2", email="coach2@example.com", organization="Rivals")
    theirs = _concept(client, rival, "Motion adjust")
    cross = client.post("/api/concepts/merge", json={"keep_id": keep["id"], "merge_ids": [theirs["id"]]}, headers=admin)
    assert cross.status_code == 422
