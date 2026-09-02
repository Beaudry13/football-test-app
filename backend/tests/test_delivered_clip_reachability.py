"""A DELIVERED CLIP MUST STAY FETCHABLE, not merely stay recorded.

WHAT THE EXISTING TEST PROVED, AND WHAT IT MISSED
-------------------------------------------------
`test_clip_snapshot_integrity.py` proved that replacing a clip leaves the
snapshot naming the original `storage_key` and leaves those bytes in storage.
Both were true. The clip 404'd anyway.

The player's URL was minted from `clip_id`, and replacing a clip does
`db.session.delete(question.clip)` - so the row the token named no longer
existed. The evidence survived in two places and the delivery path could reach
neither. A test that reads JSON can pass while every past attempt is broken,
which is why everything here fetches the URL a player actually holds and
compares BYTES.

The fix follows the mask precedent: a `dclip` token names an
`attempt_question_snapshots` row and the route reads the key frozen inside it.
"""

import base64
import io
import json

import pytest

MP4_A = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBP_A = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128
MP4_B = b"\x00\x00\x00\x18ftypisom" + b"\x02" * 400
WEBP_B = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x02" * 100


@pytest.fixture
def question_with_clip(client, coach_headers):
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Clip reachability"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": "Read the leverage", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()["id"]
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(MP4_A), "clip.mp4"),
            "poster": (io.BytesIO(WEBP_A), "poster.webp"),
            "duration_ms": "9000",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    assert response.status_code == 201, response.get_json()
    return quiz_id, question_id


def start_attempt(client, coach_headers, quiz_id, player="Casey Fields"):
    """A real player, through the real join path."""
    client.put(
        f"/api/quizzes/{quiz_id}/roster",
        json={"players": [player]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = client.post(
        "/api/play/start",
        json={"access_code_id": code["id"], "player_name": player},
    )
    assert started.status_code in (200, 201), started.get_json()
    return started.get_json(), code


def clip_urls(payload):
    clipped = [q for q in payload["questions"] if q.get("clip")]
    assert clipped, "the delivered question should carry its clip"
    return clipped[0]["clip"]["url"], clipped[0]["clip"].get("poster_url")


def replace_clip(client, coach_headers, quiz_id, question_id):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(MP4_B), "clip-b.mp4"),
            "poster": (io.BytesIO(WEBP_B), "poster-b.webp"),
            "duration_ms": "4000",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    assert response.status_code == 201, response.get_json()


class TestTheDeliveredClipResolves:
    def test_it_is_fetchable_and_is_the_bytes_that_were_delivered(
        self, client, coach_headers, question_with_clip
    ):
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, poster_url = clip_urls(payload)

        served = client.get(url)
        assert served.status_code == 200
        assert served.data == MP4_A
        assert served.headers["Content-Type"].startswith("video/mp4")

        assert poster_url
        poster = client.get(poster_url)
        assert poster.status_code == 200
        assert poster.data == WEBP_A

    def test_it_still_answers_a_ranged_request(
        self, client, coach_headers, question_with_clip
    ):
        """iOS opens a video with `Range: bytes=0-1` and refuses to play at all
        if that is answered with a plain 200. The historical path must not be
        the one that forgets."""
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, _ = clip_urls(payload)

        probe = client.get(url, headers={"Range": "bytes=0-1"})
        assert probe.status_code == 206
        assert probe.headers["Content-Range"] == f"bytes 0-1/{len(MP4_A)}"
        assert probe.data == MP4_A[:2]


class TestACoachEditCannotReachBackwards:
    def test_replacing_does_not_break_a_url_the_player_already_holds(
        self, client, coach_headers, question_with_clip
    ):
        quiz_id, question_id = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, poster_url = clip_urls(payload)

        replace_clip(client, coach_headers, quiz_id, question_id)

        served = client.get(url)
        assert served.status_code == 200, "a replaced clip must not 404 a past attempt"
        assert served.data == MP4_A
        assert served.data != MP4_B, "the player must never be handed the new take"
        assert client.get(poster_url).data == WEBP_A

    def test_a_url_minted_after_the_replacement_still_resolves_the_old_clip(
        self, client, coach_headers, question_with_clip
    ):
        """Resuming re-enters /play/start and mints FRESH tokens.

        This is where resolving by the live row would hand over Clip B with a
        perfectly valid signature and a 200 - a wrong answer, not an error.
        """
        quiz_id, question_id = question_with_clip
        _, code = start_attempt(client, coach_headers, quiz_id)
        replace_clip(client, coach_headers, quiz_id, question_id)

        resumed = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Casey Fields"},
        )
        assert resumed.status_code in (200, 201)
        url, poster_url = clip_urls(resumed.get_json())

        assert client.get(url).data == MP4_A
        assert client.get(poster_url).data == WEBP_A

    def test_removing_the_clip_entirely_leaves_the_past_attempt_intact(
        self, client, coach_headers, question_with_clip
    ):
        quiz_id, question_id = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, poster_url = clip_urls(payload)

        assert (
            client.delete(
                f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
                headers=coach_headers,
            ).status_code
            == 204
        )

        assert client.get(url).data == MP4_A
        assert client.get(poster_url).data == WEBP_A

    def test_a_new_attempt_does_receive_the_new_take(
        self, client, coach_headers, question_with_clip
    ):
        """The other half of the invariant: freezing history must not freeze
        the coach. A correction has to reach the NEXT player."""
        quiz_id, question_id = question_with_clip
        replace_clip(client, coach_headers, quiz_id, question_id)

        payload, _ = start_attempt(client, coach_headers, quiz_id, player="Rowan Diaz")
        url, _ = clip_urls(payload)
        assert client.get(url).data == MP4_B


class TestItFailsClosed:
    def test_a_tampered_signature_is_a_404(
        self, client, coach_headers, question_with_clip
    ):
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, _ = clip_urls(payload)

        head, _, token = url.rpartition("/")
        signature = token.rsplit(".", 1)[-1]
        forged = token[: -len(signature)] + "a" * len(signature)
        assert client.get(f"{head}/{forged}").status_code == 404

    def test_pointing_the_token_at_another_row_is_a_404(
        self, client, coach_headers, question_with_clip
    ):
        """One attempt cannot walk to another's media by editing an id.

        The id lives inside the SIGNED payload, so changing it invalidates the
        signature. Asserted as a consequence rather than trusted as a property.
        """
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, _ = clip_urls(payload)

        head, _, token = url.rpartition("/")
        version, body, signature = token.split(".", 2)
        claim = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        claim["i"] = claim["i"] + 1000
        rebuilt = (
            base64.urlsafe_b64encode(json.dumps(claim, sort_keys=True).encode())
            .decode()
            .rstrip("=")
        )
        assert client.get(f"{head}/{version}.{rebuilt}.{signature}").status_code == 404

    def test_an_expired_token_is_a_404(self, app, client, coach_headers, question_with_clip):
        from app.extensions import db
        from app.models import AttemptQuestionSnapshot
        from app.services.signed_media import KIND_DELIVERED_CLIP, sign_media_token

        quiz_id, _ = question_with_clip
        start_attempt(client, coach_headers, quiz_id)

        with app.app_context():
            snapshot_id = db.session.query(AttemptQuestionSnapshot.id).first()[0]
            stale = sign_media_token(KIND_DELIVERED_CLIP, snapshot_id, ttl_seconds=-1)
        assert client.get(f"/api/media/{stale}").status_code == 404

    def test_a_snapshot_with_no_clip_serves_nothing(
        self, app, client, coach_headers, question_with_clip
    ):
        """A snapshot recorded before clips existed has no `clip` key at all.

        Reaching for the live question there would be the same defect wearing
        the opposite coat - inventing history instead of losing it.
        """
        from app.extensions import db
        from app.models import AttemptQuestionSnapshot
        from app.services.signed_media import KIND_DELIVERED_CLIP, sign_media_token

        quiz_id, _ = question_with_clip
        start_attempt(client, coach_headers, quiz_id)

        with app.app_context():
            row = db.session.query(AttemptQuestionSnapshot).first()
            blob = dict(row.snapshot)
            blob.pop("clip", None)
            row.snapshot = blob
            db.session.commit()
            token = sign_media_token(KIND_DELIVERED_CLIP, row.id)

        assert client.get(f"/api/media/{token}").status_code == 404


class TestNothingOpaqueLeaves:
    def test_the_player_payload_carries_no_storage_key(
        self, client, coach_headers, question_with_clip
    ):
        """Greps the RAW body rather than the parsed shape - a key nested
        somewhere unexpected is exactly the leak worth catching."""
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)

        raw = json.dumps(payload)
        assert "storage_key" not in raw
        assert "poster_key" not in raw
        # And the answer boundary has not regressed on the way past.
        assert "is_correct_answer" not in raw
        assert "expected_answers" not in raw


class TestAttemptMediaOutlivesALongQuiz:
    """P0-B. Every URL is minted at /play/start for a quiz taken over time.

    At the ten-minute default a player reaching question fourteen forty minutes
    in was handed a URL that expired half an hour earlier - and the poster died
    on the same clock, so even the still-frame fallback was gone.
    """

    def test_a_clip_url_is_valid_well_past_the_old_ten_minute_default(
        self, client, coach_headers, question_with_clip
    ):
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, poster_url = clip_urls(payload)

        token = url.rsplit("/", 1)[-1]
        body = token.split(".")[1]
        claim = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))

        import time

        remaining = claim["e"] - int(time.time())
        # A 30 minute quiz is ordinary; 10 minutes was not enough for one.
        assert remaining > 30 * 60, f"only {remaining}s of validity"

        # The poster must not expire first - it is the fallback.
        pbody = poster_url.rsplit("/", 1)[-1].split(".")[1]
        pclaim = json.loads(base64.urlsafe_b64decode(pbody + "=" * (-len(pbody) % 4)))
        assert pclaim["e"] >= claim["e"] - 5

    def test_media_needed_late_in_an_attempt_is_still_obtainable(
        self, app, client, coach_headers, question_with_clip
    ):
        """Not a clock test - an obtainability test.

        Freezes time forward past the old default and fetches, rather than
        asserting something about the token's arithmetic.
        """
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, poster_url = clip_urls(payload)

        import time as _time

        from app.services import signed_media

        real = _time.time
        try:
            # Forty minutes into the quiz - four times the old TTL.
            signed_media.time.time = lambda: real() + 40 * 60
            assert client.get(url).status_code == 200
            assert client.get(poster_url).status_code == 200
        finally:
            signed_media.time.time = real

    def test_it_does_eventually_expire(
        self, client, coach_headers, question_with_clip
    ):
        """Bounded, not unlimited. A URL that never expired would be a
        permanent bearer credential for private football."""
        quiz_id, _ = question_with_clip
        payload, _ = start_attempt(client, coach_headers, quiz_id)
        url, _ = clip_urls(payload)

        import time as _time

        from app.services import signed_media

        real = _time.time
        try:
            signed_media.time.time = lambda: real() + 24 * 60 * 60
            assert client.get(url).status_code == 404
        finally:
            signed_media.time.time = real
