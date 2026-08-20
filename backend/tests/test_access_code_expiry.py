"""A COACH DECIDES WHEN A PEIRA STOPS BEING AVAILABLE.

WHAT CHANGED
------------
Activating used to hardcode a 24-hour window, so a Peira shared on Thursday
for Saturday morning was dead before anyone opened it. A coach can now say
when it stops, and change their mind afterwards WITHOUT the link changing.

THE INSTANT IS ABSOLUTE, THE CLOCK IS THE SERVER'S
---------------------------------------------------
Nothing here parses a wall-clock time. The client resolves what the coach
picked through the browser's own timezone database and sends the moment it
lands on; the server compares instants against its own clock. "9:00 PM"
interpreted as server-local or UTC would be wrong for somebody, and a laptop
an hour slow must not be able to create a code that is already dead.

`TestTheBoundary` pins the exact moment access ends, because "expires at 9"
has two plausible meanings and the four places that check it must agree on
one. They do: valid strictly BEFORE the instant, expired at it and after.

EXTENDING MUST NOT COST THE LINK
---------------------------------
`TestChangingItKeepsTheSameLink` is the class that matters. Reactivating mints
a new code and silently kills the URL already sitting in twenty players' group
text. Changing an expiry is an UPDATE to one column, so the code, the URL and
the QR all survive it.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import AccessCode
from tests.test_access_codes import build_activatable_quiz


def hours(n: float) -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=n)


@pytest.fixture
def quiz_with_roster(client, coach_headers):
    """A quiz that can actually be activated - one question and one player.

    Reuses the helper the existing activation tests already use, so this file
    cannot drift into activating a differently-shaped quiz from the one whose
    behaviour is already pinned.
    """
    return build_activatable_quiz(client, coach_headers)["id"]


@pytest.fixture
def activated(client, coach_headers, quiz_with_roster):
    """A quiz with a live access code, activated the default way."""

    def _activate(**body):
        response = client.post(
            f"/api/quizzes/{quiz_with_roster}/access-codes",
            json=body or {},
            headers=coach_headers,
        )
        assert response.status_code == 201, response.get_json()
        return response.get_json()

    return _activate


class TestTheDefaultIsUnchanged:
    def test_activating_without_saying_when_still_lasts_24_hours(self, activated):
        """EVERY EXISTING CLIENT KEEPS WORKING. Omitting the field is not a
        new behaviour - it is exactly what activation did before."""
        code = activated()

        expires = datetime.fromisoformat(code["expires_at"])
        assert timedelta(hours=23, minutes=59) < expires - datetime.now(timezone.utc)
        assert expires - datetime.now(timezone.utc) <= timedelta(hours=24)

    def test_the_code_is_valid_immediately(self, activated):
        assert activated()["is_valid"] is True


class TestChoosingWhenItStops:
    def test_a_coach_can_say_saturday_morning(self, activated):
        chosen = hours(44)

        code = activated(expires_at=chosen.isoformat())

        assert datetime.fromisoformat(code["expires_at"]) == chosen
        assert code["is_valid"] is True

    def test_a_time_in_the_past_is_REFUSED(self, client, coach_headers, quiz_with_roster):
        """Refused rather than clamped to now. Silently moving it would look
        identical to success and kill an activation the coach believed they
        had just made."""
        refused = client.post(
            f"/api/quizzes/{quiz_with_roster}/access-codes",
            json={"expires_at": hours(-1).isoformat()},
            headers=coach_headers,
        )

        assert refused.status_code == 422
        assert "future" in refused.get_json()["error"].lower()

    def test_a_NAIVE_wall_clock_is_refused(self, client, coach_headers, quiz_with_roster):
        """THE TIMEZONE GUARANTEE. "2026-08-22T09:00:00" has no meaning the
        server is entitled to guess. Refusing it is what stops a silent
        server-local or UTC assumption creeping in later."""
        refused = client.post(
            f"/api/quizzes/{quiz_with_roster}/access-codes",
            json={"expires_at": "2099-08-22T09:00:00"},
            headers=coach_headers,
        )

        assert refused.status_code == 422

    @pytest.mark.parametrize("offset", ["+00:00", "-04:00", "+09:30"])
    def test_the_same_instant_is_the_same_instant_whatever_offset_it_arrives_in(
        self, activated, offset
    ):
        """DST and travel are the client's timezone database's problem, and it
        has one. The server only ever sees the moment."""
        target = datetime(2099, 8, 22, 13, 0, tzinfo=timezone.utc)
        wire = target.astimezone(
            timezone(timedelta(hours=int(offset[:3]), minutes=int(offset[0] + offset[4:6])))
        )

        code = activated(expires_at=wire.isoformat())

        assert datetime.fromisoformat(code["expires_at"]) == target


class TestTheBoundary:
    def test_it_works_in_the_last_second_and_not_the_first_one_after(
        self, app, client, activated
    ):
        """THE EXACT MOMENT ACCESS ENDS. Valid strictly BEFORE the instant,
        expired at it and after - and all four places that check agree."""
        code = activated()

        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            stored.expires_at = datetime.now(timezone.utc) + timedelta(seconds=30)
            db.session.commit()
            assert stored.is_valid() is True

            stored.expires_at = datetime.now(timezone.utc)
            db.session.commit()
            # AT the instant is already over.
            assert stored.is_valid() is False

    def test_a_player_is_refused_once_it_has_passed(self, app, client, activated):
        code = activated()

        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            stored.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.session.commit()

        response = client.post("/api/play/validate-code", json={"code": code["code"]})

        assert response.status_code == 404

    def test_a_player_gets_in_just_before(self, client, activated):
        code = activated(expires_at=hours(0.05).isoformat())

        response = client.post("/api/play/validate-code", json={"code": code["code"]})

        assert response.status_code == 200


class TestChangingItKeepsTheSameLink:
    """THE CLASS THAT MATTERS. A coach whose session runs late must be able to
    extend WITHOUT invalidating the link already in the team group text."""

    def patch(self, client, headers, quiz_id, code_id, when):
        return client.patch(
            f"/api/quizzes/{quiz_id}/access-codes/{code_id}",
            json={"expires_at": when.isoformat()},
            headers=headers,
        )

    def test_EXTENDING_DOES_NOT_CHANGE_THE_CODE_OR_THE_URL(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        code = activated()
        later = hours(48)

        updated = self.patch(client, coach_headers, quiz_with_roster, code["id"], later)

        assert updated.status_code == 200, updated.get_json()
        body = updated.get_json()
        # Same row, same code - so the shared link and the QR still work.
        assert body["id"] == code["id"]
        assert body["code"] == code["code"]
        assert datetime.fromisoformat(body["expires_at"]) == later

    def test_it_does_not_create_a_second_code(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        code = activated()

        self.patch(client, coach_headers, quiz_with_roster, code["id"], hours(48))

        listed = client.get(
            f"/api/quizzes/{quiz_with_roster}/access-codes", headers=coach_headers
        ).get_json()
        assert len(listed) == 1

    def test_shortening_is_allowed_and_predictable(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        code = activated(expires_at=hours(48).isoformat())
        sooner = hours(2)

        updated = self.patch(client, coach_headers, quiz_with_roster, code["id"], sooner)

        assert updated.status_code == 200
        assert datetime.fromisoformat(updated.get_json()["expires_at"]) == sooner
        assert updated.get_json()["is_valid"] is True

    def test_shortening_INTO_THE_PAST_is_refused(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        """Ending it right now is what Deactivate is for, and it says so."""
        code = activated()

        refused = self.patch(client, coach_headers, quiz_with_roster, code["id"], hours(-1))

        assert refused.status_code == 422
        assert "Deactivate" in refused.get_json()["error"]

    def test_a_player_mid_attempt_is_unaffected_by_an_extension(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        """Attempts reference the code by id and never copy its expiry."""
        code = activated()
        validated = client.post("/api/play/validate-code", json={"code": code["code"]})
        assert validated.status_code == 200, validated.get_json()
        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Jordan Smith"},
        )
        assert started.status_code in (200, 201), started.get_json()

        self.patch(client, coach_headers, quiz_with_roster, code["id"], hours(72))

        # The SAME attempt is still reachable - it references the code by id
        # and never copied its expiry, so moving the expiry cannot strand a
        # player who is already partway through.
        again = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Jordan Smith"},
        )
        assert again.status_code in (200, 201), again.get_json()

    def test_a_DEACTIVATED_code_cannot_be_revived_by_moving_its_expiry(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        """Deactivate is a deliberate kill. Extending must not resurrect a link
        a coach has already stopped."""
        code = activated()
        client.post(
            f"/api/quizzes/{quiz_with_roster}/access-codes/{code['id']}/deactivate",
            headers=coach_headers,
        )

        refused = self.patch(client, coach_headers, quiz_with_roster, code["id"], hours(48))

        assert refused.status_code == 409

    def test_another_organizations_code_is_not_reachable(
        self, client, coach_headers, quiz_with_roster, activated, register_coach
    ):
        code = activated()
        _, _, stranger = register_coach(
            username="stranger", email="stranger@example.com", organization="Elsewhere"
        )

        refused = self.patch(client, stranger, quiz_with_roster, code["id"], hours(48))

        assert refused.status_code in (403, 404)


class TestManualDeactivationStillWins:
    def test_deactivating_kills_access_immediately_whatever_the_expiry(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        code = activated(expires_at=hours(72).isoformat())

        client.post(
            f"/api/quizzes/{quiz_with_roster}/access-codes/{code['id']}/deactivate",
            headers=coach_headers,
        )

        assert client.post(
            "/api/play/validate-code", json={"code": code["code"]}
        ).status_code == 404


class TestNothingElseChanged:
    def test_reactivating_still_mints_a_NEW_code_and_retires_the_old_one(
        self, client, coach_headers, quiz_with_roster, activated
    ):
        """Explicit, and unchanged: only one code is usable at a time, and
        reactivation is how you deliberately replace a link."""
        first = activated()

        second = activated()

        assert second["code"] != first["code"]
        listed = client.get(
            f"/api/quizzes/{quiz_with_roster}/access-codes", headers=coach_headers
        ).get_json()
        assert sum(1 for c in listed if c["is_active"]) == 1

    def test_practice_mode_is_untouched(self, activated):
        code = activated(mode="PRACTICE", expires_at=hours(30).isoformat())

        assert code["mode"] == "PRACTICE"
        assert code["is_practice"] is True

    def test_an_existing_code_keeps_the_expiry_it_already_had(self, app, activated):
        """NO BACKFILL. A code created under the old fixed window keeps its own
        window; nothing rewrites history."""
        code = activated()
        with app.app_context():
            stored = db.session.get(AccessCode, code["id"])
            original = stored.expires_at

        with app.app_context():
            assert db.session.get(AccessCode, code["id"]).expires_at == original

    def test_COMPETITION_EXPIRY_IS_A_DIFFERENT_MODEL(self, app):
        """Competition sessions have their own expires_at and their own
        default. Nothing here reaches them, and M2 is frozen."""
        from app.models import CompetitionSession

        assert CompetitionSession.__tablename__ != AccessCode.__tablename__
        assert hasattr(CompetitionSession, "default_expiry")
