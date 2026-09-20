"""PHASE 3C - the activation PIN gate.

With enforcement on, a code activated now is secured from its first second, so
an active player without a PIN could never start it. Activation refuses up
front, names who is missing, and changes nothing. Off - as in production -
activation is exactly what it was.

The gate and the /start fence read ONE roster (services/access_codes.
roster_entries), so they cannot disagree about who a quiz is for.
"""

from datetime import timedelta

from app.extensions import db
from app.models import AccessCode, GroupPlayer
from tests.test_attempt_tokens import claim, give_pin, make_player, make_quiz
from tests.test_play_and_grading import build_ready_quiz
from tests.test_player_enforcement import NOW, enforce, reason, secured, set_activated_at  # noqa: F401


def group_of(client, headers, player_ids, name="Defense"):
    group = client.post("/api/groups", json={"name": name}, headers=headers).get_json()
    r = client.post(f"/api/groups/{group['id']}/members", json={"player_ids": player_ids}, headers=headers)
    assert r.status_code in (200, 201), r.get_json()
    return group


def activate(client, headers, quiz, group_ids=()):
    return client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={"group_ids": list(group_ids)}, headers=headers
    )


def codes_for(quiz):
    return AccessCode.query.filter_by(quiz_id=quiz["id"]).order_by(AccessCode.id).all()


class TestGateOff:
    def test_enforcement_off_activates_players_without_pins_exactly_as_before(self, client, coach_headers):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        nopin = make_player(client, coach_headers, "No", "Pin")
        group = group_of(client, coach_headers, [nopin["id"]])

        r = activate(client, coach_headers, quiz, [group["id"]])

        assert r.status_code == 201, r.get_json()


class TestGateOn:
    def test_it_refuses_names_who_is_missing_and_changes_nothing(self, client, coach_headers, enforce):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        ready = make_player(client, coach_headers, "Has", "Pin")
        give_pin(client, coach_headers, ready["id"])
        missing_a = make_player(client, coach_headers, "Ava", "Zulu", jersey_number="9")
        missing_b = make_player(client, coach_headers, "Ben", "Adams")
        group = group_of(client, coach_headers, [ready["id"], missing_a["id"], missing_b["id"]])
        # Activated while off, so there is a live code the refusal must leave alone.
        first = activate(client, coach_headers, quiz, [group["id"]]).get_json()
        enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))

        r = activate(client, coach_headers, quiz, [group["id"]])

        assert r.status_code == 422, r.get_json()
        assert reason(r) == "players_need_pins"
        assert r.get_json()["error"] == (
            "2 players don't have a PIN yet, so they couldn't start this quiz. "
            "Give them PINs, then activate it."
        )
        assert r.get_json()["details"] == {"players_without_pins": [
            {"player_id": missing_b["id"], "name": "Ben Adams", "jersey_number": None},
            {"player_id": missing_a["id"], "name": "Ava Zulu", "jersey_number": "9"},
        ]}
        raw = r.get_data(as_text=True).lower()
        assert "pin_hash" not in raw and "$2b$" not in raw
        codes = codes_for(quiz)
        assert [c.id for c in codes] == [first["id"]] and codes[0].is_active

    def test_one_missing_player_reads_as_one(self, client, coach_headers, secured):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        solo = make_player(client, coach_headers, "Solo", "Player")
        group = group_of(client, coach_headers, [solo["id"]])

        r = activate(client, coach_headers, quiz, [group["id"]])

        assert r.get_json()["error"].startswith("1 player doesn't have a PIN yet")

    def test_generating_the_pins_lets_it_through_and_the_code_is_secured(self, client, coach_headers, secured):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        player = make_player(client, coach_headers, "Soon", "Ready")
        group = group_of(client, coach_headers, [player["id"]])
        assert activate(client, coach_headers, quiz, [group["id"]]).status_code == 422

        generated = client.post("/api/players/pins/generate-missing", headers=coach_headers).get_json()
        pin = next(p["pin"] for p in generated["issued"] if p["player_id"] == player["id"])
        r = activate(client, coach_headers, quiz, [group["id"]])

        assert r.status_code == 201, r.get_json()
        code = r.get_json()
        # Secured from its first second: a name is not enough, the PIN is.
        start = client.post("/api/play/start", json={
            "access_code_id": code["id"], "player_name": "Soon Ready", "player_id": player["id"]})
        assert (start.status_code, reason(start)) == (401, "pin_required")
        assert claim(client, code, player["id"], pin).status_code == 201

    def test_inactive_players_and_free_text_entries_do_not_block(self, client, coach_headers, secured):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        ready = make_player(client, coach_headers, "Has", "Pin")
        give_pin(client, coach_headers, ready["id"])
        retired = make_player(client, coach_headers, "Gone", "Now")
        group = group_of(client, coach_headers, [ready["id"], retired["id"]])
        assert client.post(f"/api/players/{retired['id']}/deactivate", headers=coach_headers).status_code == 200
        db.session.add(GroupPlayer(group_id=group["id"], player_name="Walk On", player_id=None))
        db.session.commit()

        assert activate(client, coach_headers, quiz, [group["id"]]).status_code == 201

    def test_a_free_text_quiz_roster_activates(self, client, coach_headers, secured):
        # build_ready_quiz activates a roster of free-text names; with the gate
        # on it must still go through - there is nobody to give a PIN to.
        _quiz, _tf, _written, code = build_ready_quiz(client, coach_headers)
        assert "code" in code, code

    def test_two_players_who_share_a_name_are_both_named(self, client, coach_headers, secured):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        wr = make_player(client, coach_headers, "Chris", "Smith", jersey_number="2")
        lb = make_player(client, coach_headers, "Chris", "Smith", jersey_number="44")
        group = group_of(client, coach_headers, [wr["id"], lb["id"]])

        r = activate(client, coach_headers, quiz, [group["id"]])

        listed = r.get_json()["details"]["players_without_pins"]
        assert sorted(p["player_id"] for p in listed) == sorted([wr["id"], lb["id"]])

    def test_only_the_selected_groups_count(self, client, coach_headers, secured):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        ready = make_player(client, coach_headers, "Has", "Pin")
        give_pin(client, coach_headers, ready["id"])
        elsewhere = make_player(client, coach_headers, "Other", "Unit")
        mine = group_of(client, coach_headers, [ready["id"]], "Mine")
        group_of(client, coach_headers, [elsewhere["id"]], "Theirs")

        assert activate(client, coach_headers, quiz, [mine["id"]]).status_code == 201


class TestNoOlderPathAround:
    """What a coach might try so players without PINs keep working."""

    def test_an_old_code_cannot_be_revived_by_moving_its_expiry(self, client, coach_headers, enforce):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        player = make_player(client, coach_headers, "Old", "Code")
        group = group_of(client, coach_headers, [player["id"]])
        old = activate(client, coach_headers, quiz, [group["id"]]).get_json()
        set_activated_at(old["id"], NOW - timedelta(days=2))
        client.post(f"/api/quizzes/{quiz['id']}/access-codes/{old['id']}/deactivate", headers=coach_headers)
        enforce(NOW - timedelta(days=1), NOW + timedelta(days=5))

        r = client.patch(
            f"/api/quizzes/{quiz['id']}/access-codes/{old['id']}",
            json={"expires_at": (NOW + timedelta(days=3)).isoformat()},
            headers=coach_headers,
        )

        assert r.status_code == 409
        assert not db.session.get(AccessCode, old["id"]).is_active

    def test_an_old_live_codes_exemption_ends_on_the_hard_date_however_far_it_is_extended(
        self, client, coach_headers, enforce
    ):
        quiz, _tf, _draw = make_quiz(client, coach_headers)
        player = make_player(client, coach_headers, "Long", "Tail")
        group = group_of(client, coach_headers, [player["id"]])
        old = activate(client, coach_headers, quiz, [group["id"]]).get_json()
        set_activated_at(old["id"], NOW - timedelta(days=10))
        client.patch(
            f"/api/quizzes/{quiz['id']}/access-codes/{old['id']}",
            json={"expires_at": (NOW + timedelta(days=60)).isoformat()},
            headers=coach_headers,
        )
        # The compatibility window has already closed.
        enforce(NOW - timedelta(days=8), NOW - timedelta(days=1))

        start = client.post("/api/play/start", json={
            "access_code_id": old["id"], "player_name": "Long Tail", "player_id": player["id"]})

        assert (start.status_code, reason(start)) == (401, "pin_required")
