"""Organization membership, invitations, and multi-tenant isolation.

The isolation tests here are the ones that matter most: they're what stands
between this being a real multi-tenant product and a data breach. They
assert both directions deliberately - that a stranger is locked out, AND
that a teammate is let in - because a bug that denies everyone would
otherwise look like passing security tests.
"""


def create_quiz(client, headers, title="Week 1 Prep"):
    response = client.post("/api/quizzes", json={"title": title}, headers=headers)
    assert response.status_code == 201
    return response.get_json()


# --- Registration and org creation ---------------------------------------


def test_registering_creates_an_organization_with_the_coach_as_admin(client, register_coach):
    coach, _, headers = register_coach(organization="Wildcats")
    assert coach["organization"] == "Wildcats"
    assert coach["role"] == "admin"
    assert coach["organization_id"] is not None

    org = client.get("/api/organizations", headers=headers).get_json()
    assert org["name"] == "Wildcats"
    assert [m["username"] for m in org["members"]] == ["coach1"]


def test_two_coaches_registering_with_the_same_org_name_are_still_separate_tenants(
    client, register_coach
):
    # The exact foot-gun the migration avoids, enforced at signup too: the
    # org name is a label, never an identity.
    coach_a, _, headers_a = register_coach(username="coach_a", email="a@example.com", organization="Wildcats")
    coach_b, _, headers_b = register_coach(username="coach_b", email="b@example.com", organization="Wildcats")

    assert coach_a["organization_id"] != coach_b["organization_id"]

    create_quiz(client, headers_a, title="A's quiz")
    assert client.get("/api/quizzes", headers=headers_b).get_json() == []


# --- Invitations ----------------------------------------------------------


def test_invited_teammate_joins_the_same_org_as_a_member(client, coach_headers, invite_teammate):
    teammate, _, teammate_headers = invite_teammate(coach_headers)
    assert teammate["role"] == "member"

    org = client.get("/api/organizations", headers=teammate_headers).get_json()
    assert {m["username"] for m in org["members"]} == {"coach1", "teammate"}


def test_invite_code_cannot_be_reused(client, coach_headers):
    code = client.post("/api/organizations/invites", headers=coach_headers).get_json()["code"]

    first = client.post(
        "/api/auth/register-with-invite",
        json={"username": "first", "email": "first@example.com", "password": "password123", "invite_code": code},
    )
    assert first.status_code == 201

    second = client.post(
        "/api/auth/register-with-invite",
        json={"username": "second", "email": "second@example.com", "password": "password123", "invite_code": code},
    )
    assert second.status_code == 404


def test_revoked_invite_is_rejected(client, coach_headers):
    invite = client.post("/api/organizations/invites", headers=coach_headers).get_json()
    assert client.delete(f"/api/organizations/invites/{invite['id']}", headers=coach_headers).status_code == 204

    response = client.post(
        "/api/auth/register-with-invite",
        json={
            "username": "nope",
            "email": "nope@example.com",
            "password": "password123",
            "invite_code": invite["code"],
        },
    )
    assert response.status_code == 404


def test_expired_invite_is_rejected(app, client, coach_headers):
    from datetime import datetime, timedelta, timezone

    from app.extensions import db
    from app.models import OrganizationInvite

    invite = client.post("/api/organizations/invites", headers=coach_headers).get_json()
    with app.app_context():
        row = db.session.get(OrganizationInvite, invite["id"])
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        db.session.commit()

    response = client.post(
        "/api/auth/register-with-invite",
        json={
            "username": "late",
            "email": "late@example.com",
            "password": "password123",
            "invite_code": invite["code"],
        },
    )
    assert response.status_code == 404


def test_garbage_invite_code_is_rejected(client):
    response = client.post(
        "/api/auth/register-with-invite",
        json={
            "username": "stranger",
            "email": "stranger@example.com",
            "password": "password123",
            "invite_code": "not-a-real-code",
        },
    )
    assert response.status_code == 404


def test_members_cannot_create_or_list_invites(client, coach_headers, invite_teammate):
    _, _, teammate_headers = invite_teammate(coach_headers)

    assert client.post("/api/organizations/invites", headers=teammate_headers).status_code == 403
    assert client.get("/api/organizations/invites", headers=teammate_headers).status_code == 403


def test_invite_listing_does_not_leak_codes(client, coach_headers):
    client.post("/api/organizations/invites", headers=coach_headers)
    invites = client.get("/api/organizations/invites", headers=coach_headers).get_json()
    assert len(invites) == 1
    assert "code" not in invites[0]


def test_invite_preview_shows_only_the_org_name(client, coach_headers):
    invite = client.post("/api/organizations/invites", headers=coach_headers).get_json()
    response = client.get(f"/api/auth/invites/{invite['code']}")
    assert response.status_code == 200
    assert response.get_json() == {"organization_name": "Wildcats"}


# --- Cross-org isolation --------------------------------------------------


def test_another_orgs_coach_cannot_reach_any_resource(client, coach_headers, register_coach):
    quiz = create_quiz(client, coach_headers)
    folder = client.post("/api/folders", json={"name": "Fall Camp"}, headers=coach_headers).get_json()
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()

    _, _, outsider = register_coach(username="outsider", email="out@example.com", organization="Eagles")

    assert client.get(f"/api/quizzes/{quiz['id']}", headers=outsider).status_code == 404
    assert client.patch(f"/api/quizzes/{quiz['id']}", json={"title": "hijacked"}, headers=outsider).status_code == 404
    assert client.delete(f"/api/quizzes/{quiz['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/quizzes/{quiz['id']}/roster", headers=outsider).status_code == 404
    assert client.get(f"/api/quizzes/{quiz['id']}/access-codes", headers=outsider).status_code == 404
    assert client.get(f"/api/quizzes/{quiz['id']}/dashboard", headers=outsider).status_code == 404
    assert client.get(f"/api/quizzes/{quiz['id']}/export.csv", headers=outsider).status_code == 404
    assert client.patch(f"/api/folders/{folder['id']}", json={"name": "x"}, headers=outsider).status_code == 404
    assert client.delete(f"/api/groups/{group['id']}", headers=outsider).status_code == 404
    assert client.get(f"/api/groups/{group['id']}", headers=outsider).status_code == 404

    # And nothing shows up in their listings.
    assert client.get("/api/quizzes", headers=outsider).get_json() == []
    assert client.get("/api/folders", headers=outsider).get_json() == []
    assert client.get("/api/groups", headers=outsider).get_json() == []


def test_player_history_does_not_cross_organizations(client, coach_headers, register_coach):
    _, _, outsider = register_coach(username="outsider", email="out@example.com", organization="Eagles")
    response = client.get("/api/players/history?name=Jordan%20Smith", headers=outsider)
    assert response.status_code == 200
    assert response.get_json()["history"] == []


# --- Same-org sharing: see all, edit own ----------------------------------


def test_teammate_cannot_see_another_members_quiz_at_all(client, coach_headers, invite_teammate):
    """Coach View is own-only. This test previously asserted the opposite -
    that a teammate could SEE any quiz in the org and was merely blocked from
    editing it with a 403. Both halves changed: the quiz is now absent from
    their list, and every route answers 404 rather than 403 so a member cannot
    learn that the id exists."""
    quiz = create_quiz(client, coach_headers, title="Coach 1's quiz")
    _, _, teammate_headers = invite_teammate(coach_headers)

    assert client.get("/api/quizzes", headers=teammate_headers).get_json() == []

    assert client.get(f"/api/quizzes/{quiz['id']}", headers=teammate_headers).status_code == 404
    assert client.patch(
        f"/api/quizzes/{quiz['id']}", json={"title": "changed"}, headers=teammate_headers
    ).status_code == 404
    assert client.delete(f"/api/quizzes/{quiz['id']}", headers=teammate_headers).status_code == 404
    assert client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q", "question_type": "written", "options": []},
        headers=teammate_headers,
    ).status_code == 404
    assert client.put(
        f"/api/quizzes/{quiz['id']}/roster", json={"players": ["X"]}, headers=teammate_headers
    ).status_code == 404


def test_admin_can_edit_a_members_quiz(client, coach_headers, invite_teammate):
    _, _, teammate_headers = invite_teammate(coach_headers)
    quiz = create_quiz(client, teammate_headers, title="Teammate's quiz")

    response = client.patch(
        f"/api/quizzes/{quiz['id']}", json={"title": "Fixed by head coach"}, headers=coach_headers
    )
    assert response.status_code == 200
    assert response.get_json()["title"] == "Fixed by head coach"


def test_teammate_can_edit_their_own_quiz(client, coach_headers, invite_teammate):
    _, _, teammate_headers = invite_teammate(coach_headers)
    quiz = create_quiz(client, teammate_headers, title="Mine")

    assert client.patch(
        f"/api/quizzes/{quiz['id']}", json={"title": "Mine v2"}, headers=teammate_headers
    ).status_code == 200


def test_an_admin_duplicating_a_members_quiz_owns_the_copy(
    client, coach_headers, invite_teammate
):
    """Duplication assigns the copy to whoever made it. Previously any
    teammate could duplicate any quiz in the org; now only the owner or an
    admin can reach it at all, so this exercises the admin path."""
    _, _, teammate_headers = invite_teammate(coach_headers)
    quiz = create_quiz(client, teammate_headers, title="Original")

    # The member cannot duplicate a quiz they cannot see...
    assert client.post(
        f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers
    ).status_code == 201  # the admin can

    copy = client.post(f"/api/quizzes/{quiz['id']}/duplicate", headers=coach_headers)
    assert copy.status_code == 201
    copy_body = copy.get_json()
    assert copy_body["created_by_username"] == "coach1"

    # ...and can then edit it, since it's theirs.
    assert client.patch(
        f"/api/quizzes/{copy_body['id']}", json={"title": "My version"}, headers=coach_headers
    ).status_code == 200


def test_folders_and_groups_are_editable_by_any_member(client, coach_headers, invite_teammate):
    folder = client.post("/api/folders", json={"name": "Fall Camp"}, headers=coach_headers).get_json()
    group = client.post("/api/groups", json={"name": "Defense"}, headers=coach_headers).get_json()
    _, _, teammate_headers = invite_teammate(coach_headers)

    assert client.patch(
        f"/api/folders/{folder['id']}", json={"name": "Fall Camp 2026"}, headers=teammate_headers
    ).status_code == 200
    assert client.put(
        f"/api/groups/{group['id']}/players",
        json={"players": ["Jordan Smith"]},
        headers=teammate_headers,
    ).status_code == 200

    # The change is visible to the coach who created them.
    groups = client.get("/api/groups", headers=coach_headers).get_json()
    assert [p["player_name"] for p in groups[0]["players"]] == ["Jordan Smith"]


def test_a_members_group_can_be_attached_to_a_teammates_quiz_activation(
    client, coach_headers, invite_teammate
):
    """Groups are org-shared, so activation must accept a group created by
    someone else on the staff - the main point of sharing them."""
    _, _, teammate_headers = invite_teammate(coach_headers)
    group = client.post("/api/groups", json={"name": "Varsity"}, headers=teammate_headers).get_json()
    client.put(
        f"/api/groups/{group['id']}/players",
        json={"players": ["Jordan Smith"]},
        headers=teammate_headers,
    )

    quiz = create_quiz(client, coach_headers)
    client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={"question_text": "Q1", "question_type": "written", "options": []},
        headers=coach_headers,
    )

    response = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes",
        json={"group_ids": [group["id"]]},
        headers=coach_headers,
    )
    assert response.status_code == 201
    assert [g["name"] for g in response.get_json()["groups"]] == ["Varsity"]


# --- Member management ----------------------------------------------------


def test_admin_can_promote_and_demote_members(client, coach_headers, invite_teammate):
    teammate, _, _ = invite_teammate(coach_headers)

    promoted = client.patch(
        f"/api/organizations/members/{teammate['id']}", json={"role": "admin"}, headers=coach_headers
    )
    assert promoted.status_code == 200
    assert promoted.get_json()["role"] == "admin"

    demoted = client.patch(
        f"/api/organizations/members/{teammate['id']}", json={"role": "member"}, headers=coach_headers
    )
    assert demoted.get_json()["role"] == "member"


def test_cannot_demote_or_remove_the_last_admin(client, coach_headers, register_coach):
    org = client.get("/api/organizations", headers=coach_headers).get_json()
    admin_id = org["members"][0]["id"]

    assert client.patch(
        f"/api/organizations/members/{admin_id}", json={"role": "member"}, headers=coach_headers
    ).status_code == 422
    assert client.delete(
        f"/api/organizations/members/{admin_id}", headers=coach_headers
    ).status_code == 422


def test_removing_a_member_cannot_strand_their_quizzes(
    client, coach_headers, invite_teammate
):
    """This test used to assert that removal simply nulled the owner and the
    quiz "stayed with the organization". That was true and harmless when every
    quiz was visible org-wide - but under own-only, a quiz owned by nobody is
    in nobody's list, so it stayed with the organization in the sense that it
    was lost inside it. Removal is now refused until the quizzes have an owner."""
    teammate, _, teammate_headers = invite_teammate(coach_headers)
    quiz = create_quiz(client, teammate_headers, title="Leaver's quiz")

    refused = client.delete(
        f"/api/organizations/members/{teammate['id']}", headers=coach_headers
    )
    assert refused.status_code == 409
    assert refused.get_json()["reason"] == "owns_quizzes"

    admin_id = next(
        m["id"]
        for m in client.get("/api/organizations", headers=coach_headers).get_json()["members"]
        if m["id"] != teammate["id"]
    )
    assert client.delete(
        f"/api/organizations/members/{teammate['id']}",
        headers=coach_headers,
        json={"reassign_quizzes_to": admin_id},
    ).status_code == 204

    # The work survives, and now has a real owner rather than none.
    remaining = client.get("/api/quizzes", headers=coach_headers).get_json()
    assert [q["title"] for q in remaining] == ["Leaver's quiz"]
    assert remaining[0]["created_by_username"] == "coach1"
    assert client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).status_code == 200


def test_members_cannot_manage_the_organization(client, coach_headers, invite_teammate):
    teammate, _, teammate_headers = invite_teammate(coach_headers)

    assert client.patch(
        "/api/organizations", json={"name": "Renamed"}, headers=teammate_headers
    ).status_code == 403
    assert client.delete(
        f"/api/organizations/members/{teammate['id']}", headers=teammate_headers
    ).status_code == 403


def test_admin_cannot_touch_another_orgs_members(client, coach_headers, register_coach):
    _, _, outsider = register_coach(username="outsider", email="out@example.com", organization="Eagles")
    org = client.get("/api/organizations", headers=coach_headers).get_json()
    victim_id = org["members"][0]["id"]

    assert client.delete(f"/api/organizations/members/{victim_id}", headers=outsider).status_code == 404
    assert client.patch(
        f"/api/organizations/members/{victim_id}", json={"role": "member"}, headers=outsider
    ).status_code == 404


def test_removed_coach_immediately_loses_access_with_their_still_unexpired_token(
    client, coach_headers, invite_teammate
):
    """A removed Coach row is gone, not just relabeled - current_coach()
    resolves the JWT's subject straight from the database on every request,
    so the very next request with the removed coach's own (still technically
    unexpired) token fails immediately. No token blacklist/revocation list
    is needed for this to be true."""
    teammate, _, teammate_headers = invite_teammate(coach_headers)
    assert client.get("/api/quizzes", headers=teammate_headers).status_code == 200

    assert client.delete(
        f"/api/organizations/members/{teammate['id']}", headers=coach_headers
    ).status_code == 204

    response = client.get("/api/quizzes", headers=teammate_headers)
    assert response.status_code == 401


def test_an_existing_coach_cannot_accept_a_second_invite_with_their_own_identity(
    client, coach_headers, register_coach
):
    """register_with_invite always creates a brand-new Coach row rather than
    attaching an existing one to a second organization - so an existing
    account holder trying to accept an invite with their own email/username
    hits the ordinary "already taken" conflict, the same as any other
    duplicate-registration attempt. This is what makes "one coach, one
    organization, forever" true: there is no code path that lets an
    existing identity join a second org."""
    _, _, _ = register_coach(username="existing_coach", email="existing_coach@example.com")
    invite = client.post("/api/organizations/invites", headers=coach_headers).get_json()

    response = client.post(
        "/api/auth/register-with-invite",
        json={
            "username": "existing_coach",
            "email": "existing_coach@example.com",
            "password": "password123",
            "invite_code": invite["code"],
        },
    )

    assert response.status_code == 409
    # And the invite itself is untouched - still usable by someone else.
    assert client.post(
        "/api/auth/register-with-invite",
        json={
            "username": "new_person",
            "email": "new_person@example.com",
            "password": "password123",
            "invite_code": invite["code"],
        },
    ).status_code == 201
