"""Where the film stops so the player can decide.

Football recognition is tested BEFORE the outcome exists - identify the
coverage, the fit, the leverage - and a clip that plays through to the whistle
answers its own question. `decision_point_ms` stops the film on the frame the
coach chose.

REAL-DEVICE EVIDENCE BEHIND THIS FEATURE (Phase 0, 2 Sep 2026):

    iPhone, Safari:  10 / 10 attempts stopped in time
                     MAXIMUM observed overshoot 41ms
                     acceptance threshold was 100ms MAX, not average

That is the only device evidence we have. No broader Safari, iPad or Android
guarantee is implied by it, and none should be written into a docstring later.

The rules these tests hold down:

  * NULL is an ordinary Record Clip, unchanged in every respect.
  * A delivered attempt keeps the decision point it was given, whatever the
    coach does to the live question afterwards.
  * Replacing the film CLEARS the decision point - a frame chosen by looking at
    one clip is an arbitrary moment in a different one.
  * Duplicating CARRIES it - the copy is byte-identical film, so the frame is
    the same frame, and a duplicate that silently played the whole play would
    hand the outcome to the next squad.
"""

import io

import pytest

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128
MP4_B = b"\x00\x00\x00\x18ftypisom" + b"\x07" * 400


@pytest.fixture
def clipped(client, coach_headers):
    """A question with a 12-second clip and no decision point yet."""
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Decision point"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": "What is your responsibility?", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()["id"]
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(MP4), "clip.mp4"),
            "poster": (io.BytesIO(WEBP), "poster.webp"),
            "duration_ms": "12000",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    assert response.status_code == 201, response.get_json()
    return quiz_id, question_id


def set_point(client, headers, quiz_id, question_id, ms):
    return client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip/decision-point",
        json={"decision_point_ms": ms},
        headers=headers,
    )


def start_attempt(client, coach_headers, quiz_id, player="Casey Fields"):
    client.put(
        f"/api/quizzes/{quiz_id}/roster", json={"players": [player]}, headers=coach_headers
    )
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )
    assert started.status_code in (200, 201), started.get_json()
    return started.get_json(), code


def delivered_clip(payload):
    clipped_qs = [q for q in payload["questions"] if q.get("clip")]
    assert clipped_qs, "the delivered question should carry its clip"
    return clipped_qs[0]["clip"]


class TestAnOrdinaryClipIsUnchanged:
    def test_a_clip_starts_with_no_decision_point(self, client, coach_headers, clipped):
        quiz_id, question_id = clipped
        quiz = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()
        assert quiz["questions"][0]["clip"]["decision_point_ms"] is None

    def test_the_player_receives_none(self, client, coach_headers, clipped):
        quiz_id, _ = clipped
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        assert delivered_clip(payload)["decision_point_ms"] is None


class TestSettingAndClearing:
    def test_a_valid_point_is_stored(self, client, coach_headers, clipped):
        quiz_id, question_id = clipped
        response = set_point(client, coach_headers, quiz_id, question_id, 6000)
        assert response.status_code == 200, response.get_json()
        assert response.get_json()["decision_point_ms"] == 6000

    def test_clearing_returns_it_to_an_ordinary_clip(self, client, coach_headers, clipped):
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        response = set_point(client, coach_headers, quiz_id, question_id, None)
        assert response.status_code == 200
        assert response.get_json()["decision_point_ms"] is None
        # And the clip itself survives - clearing is not deleting.
        quiz = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()
        assert quiz["questions"][0]["clip"] is not None

    @pytest.mark.parametrize("bad", [0, -1, -6000])
    def test_a_point_at_or_before_the_start_is_refused(
        self, bad, client, coach_headers, clipped
    ):
        quiz_id, question_id = clipped
        assert set_point(client, coach_headers, quiz_id, question_id, bad).status_code == 400

    def test_a_point_past_the_end_is_refused(self, client, coach_headers, clipped):
        # It would never stop anything, so the player would watch the whole
        # play and the question would answer itself.
        quiz_id, question_id = clipped
        assert set_point(client, coach_headers, quiz_id, question_id, 12000).status_code == 400
        assert set_point(client, coach_headers, quiz_id, question_id, 99000).status_code == 400

    def test_nonsense_is_refused_rather_than_coerced(self, client, coach_headers, clipped):
        quiz_id, question_id = clipped
        assert (
            set_point(client, coach_headers, quiz_id, question_id, "half past six").status_code
            == 400
        )

    def test_a_question_with_no_clip_is_a_404(self, client, coach_headers):
        quiz_id = client.post(
            "/api/quizzes", json={"title": "No clip"}, headers=coach_headers
        ).get_json()["id"]
        question_id = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Plain", "question_type": "written", "options": []},
            headers=coach_headers,
        ).get_json()["id"]
        assert set_point(client, coach_headers, quiz_id, question_id, 3000).status_code == 404


class TestTheDeliveredDecisionPointIsFrozen:
    """THE INVARIANT THAT MATTERS MOST HERE.

    A coach moving the freeze - or removing it - must not change how much of
    the play an attempt already in progress is able to show. Same discipline as
    the delivered clip itself.
    """

    def test_the_player_receives_the_point_that_was_set(
        self, client, coach_headers, clipped
    ):
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        assert delivered_clip(payload)["decision_point_ms"] == 6000

    def test_moving_the_live_point_does_not_move_a_delivered_one(
        self, client, coach_headers, clipped
    ):
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        _, code = start_attempt(client, coach_headers, quiz_id)

        # The coach changes their mind, well after the player started.
        set_point(client, coach_headers, quiz_id, question_id, 4000)

        resumed = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Casey Fields"},
        )
        assert delivered_clip(resumed.get_json())["decision_point_ms"] == 6000

    def test_clearing_the_live_point_does_not_clear_a_delivered_one(
        self, client, coach_headers, clipped
    ):
        # The dangerous direction: if this followed the live row, a finished
        # attempt would suddenly be able to play the whole play.
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        _, code = start_attempt(client, coach_headers, quiz_id)

        set_point(client, coach_headers, quiz_id, question_id, None)

        resumed = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Casey Fields"},
        )
        assert delivered_clip(resumed.get_json())["decision_point_ms"] == 6000

    def test_a_new_attempt_does_get_the_coach_correction(
        self, client, coach_headers, clipped
    ):
        """The other half: freezing history must not freeze the coach."""
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        start_attempt(client, coach_headers, quiz_id)
        set_point(client, coach_headers, quiz_id, question_id, 3000)

        payload, _ = start_attempt(client, coach_headers, quiz_id, player="Rowan Diaz")
        assert delivered_clip(payload)["decision_point_ms"] == 3000

    def test_a_snapshot_written_before_this_feature_reads_as_ordinary(self):
        """No backfill, ever. An attempt delivered before decision points
        existed received an ordinary looping clip, and must read as one."""
        from app.services.delivered_questions import _clip_from_snapshot

        old = {"storage_key": "k", "content_type": "video/mp4", "clip_id": 1}
        assert _clip_from_snapshot(old) is not None
        assert _clip_from_snapshot(old).decision_point_ms is None


class TestReplacingTheFilm:
    def test_replacing_the_clip_clears_the_decision_point(
        self, client, coach_headers, clipped
    ):
        """A frame chosen by looking at ONE clip is an arbitrary moment in a
        different one - and on new football, 6.0s may be exactly the outcome
        the coach meant to hide. Carrying it silently is the one way this
        feature fails without anybody noticing."""
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)

        replaced = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={"clip": (io.BytesIO(MP4_B), "new.mp4"), "duration_ms": "9000"},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert replaced.status_code == 201
        assert replaced.get_json()["decision_point_ms"] is None

    def test_a_replacement_may_set_its_own_point_in_the_same_request(
        self, client, coach_headers, clipped
    ):
        quiz_id, question_id = clipped
        replaced = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={
                "clip": (io.BytesIO(MP4_B), "new.mp4"),
                "duration_ms": "9000",
                "decision_point_ms": "4000",
            },
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert replaced.status_code == 201
        assert replaced.get_json()["decision_point_ms"] == 4000

    def test_a_past_attempt_keeps_both_the_old_film_and_the_old_point(
        self, client, coach_headers, clipped
    ):
        """Both halves of history at once: the bytes AND the freeze."""
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)
        payload, code = start_attempt(client, coach_headers, quiz_id)
        url = delivered_clip(payload)["url"]

        client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={"clip": (io.BytesIO(MP4_B), "new.mp4"), "duration_ms": "9000"},
            content_type="multipart/form-data",
            headers=coach_headers,
        )

        # P0-A: the delivered bytes are still reachable and are the OLD film.
        served = client.get(url)
        assert served.status_code == 200
        assert served.data == MP4

        # And that attempt still stops where its player was told it would,
        # even though replacing the clip cleared the live decision point.
        resumed = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Casey Fields"},
        )
        assert resumed.status_code in (200, 201)
        assert delivered_clip(resumed.get_json())["decision_point_ms"] == 6000


class TestDuplication:
    def test_a_duplicated_quiz_keeps_the_decision_point(
        self, client, coach_headers, clipped
    ):
        quiz_id, question_id = clipped
        set_point(client, coach_headers, quiz_id, question_id, 6000)

        copy = client.post(f"/api/quizzes/{quiz_id}/duplicate", json={}, headers=coach_headers)
        assert copy.status_code in (200, 201), copy.get_json()
        copy_id = copy.get_json()["id"]

        copied = client.get(f"/api/quizzes/{copy_id}", headers=coach_headers).get_json()
        assert copied["questions"][0]["clip"]["decision_point_ms"] == 6000

    def test_a_duplicate_of_an_ordinary_clip_stays_ordinary(
        self, client, coach_headers, clipped
    ):
        quiz_id, _ = clipped
        copy = client.post(f"/api/quizzes/{quiz_id}/duplicate", json={}, headers=coach_headers)
        copy_id = copy.get_json()["id"]
        copied = client.get(f"/api/quizzes/{copy_id}", headers=coach_headers).get_json()
        assert copied["questions"][0]["clip"]["decision_point_ms"] is None


class TestOwnership:
    def test_another_organization_cannot_set_a_decision_point(
        self, client, coach_headers, clipped, register_via_invite_other=None
    ):
        from tests.conftest import register_via_invite

        quiz_id, question_id = clipped
        other = register_via_invite(
            client,
            username="rival",
            email="rival@example.com",
            organization="Rivals",
        )
        token = other.get_json()["access_token"]
        response = set_point(
            client, {"Authorization": f"Bearer {token}"}, quiz_id, question_id, 5000
        )
        assert response.status_code in (403, 404)
