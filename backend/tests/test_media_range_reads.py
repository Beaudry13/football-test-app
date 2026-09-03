"""Only the requested bytes leave object storage.

THE BUG THIS FIXES, measured before it was written: `media.py` loaded the
ENTIRE object from R2 and then sliced it. iOS Safari opens a video with
`Range: bytes=0-1`, so answering that two-byte probe meant downloading the
whole multi-megabyte MP4 - and then downloading it again for the real
request. Every player waited through both before the first frame.

The load-bearing test here is the FIRST one: it counts what the storage layer
was actually asked for. A test that only checked the response body would pass
just as happily against the old implementation, because the old one returned
the right bytes - expensively.
"""

import io

import pytest

from app.services import private_storage as storage_module

MP4 = b"\x00\x00\x00\x18ftypisom" + bytes(range(256)) * 40  # ~10 KB, deterministic
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128


class RecordingStorage:
    """Wraps the real storage and records how it was asked for bytes."""

    def __init__(self, inner):
        self.inner = inner
        self.full_reads: list[str] = []
        self.range_reads: list[tuple[str, int, int]] = []
        self.size_calls: list[str] = []

    def save_private(self, data, *, content_type, extension):
        return self.inner.save_private(data, content_type=content_type, extension=extension)

    def load_private(self, key):
        self.full_reads.append(key)
        return self.inner.load_private(key)

    def load_private_range(self, key, start, end):
        self.range_reads.append((key, start, end))
        return self.inner.load_private_range(key, start, end)

    def private_size(self, key):
        self.size_calls.append(key)
        return self.inner.private_size(key)

    def delete_private(self, key):
        return self.inner.delete_private(key)

    @property
    def bytes_read_from_storage(self) -> int:
        """Everything this wrapper actually moved, full reads included."""
        total = 0
        for key in self.full_reads:
            data = self.inner.load_private(key)
            total += len(data or b"")
        for _key, start, end in self.range_reads:
            total += end - start + 1
        return total


@pytest.fixture
def recorder(app, monkeypatch):
    """Swaps in a recording wrapper around whatever storage the app uses."""
    inner = storage_module.get_private_storage.__wrapped__() if hasattr(
        storage_module.get_private_storage, "__wrapped__"
    ) else None
    with app.app_context():
        real = storage_module.get_private_storage()
    wrapper = RecordingStorage(inner or real)
    monkeypatch.setattr(storage_module, "get_private_storage", lambda: wrapper)
    import app.routes.media as media_module

    monkeypatch.setattr(media_module, "get_private_storage", lambda: wrapper)
    return wrapper


@pytest.fixture
def clip_url(client, coach_headers):
    """A real question with a real clip, and a player's signed URL for it."""
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Range"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": "Read it", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()["id"]
    assert (
        client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={
                "clip": (io.BytesIO(MP4), "clip.mp4"),
                "poster": (io.BytesIO(WEBP), "poster.webp"),
                "duration_ms": "8000",
            },
            content_type="multipart/form-data",
            headers=coach_headers,
        ).status_code
        == 201
    )
    client.put(
        f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey"]}, headers=coach_headers
    )
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": "Casey"}
    )
    assert started.status_code in (200, 201)
    clip = [q for q in started.get_json()["questions"] if q.get("clip")][0]["clip"]
    return clip["url"], clip.get("poster_url")


class TestOnlyTheRequestedBytesAreFetched:
    def test_a_two_byte_probe_reads_two_bytes_from_storage(
        self, client, recorder, clip_url
    ):
        """THE WHOLE POINT. This is what iOS sends first.

        Before the fix, storage was asked for the entire object here.
        """
        url, _ = clip_url
        response = client.get(url, headers={"Range": "bytes=0-1"})

        assert response.status_code == 206
        assert response.data == MP4[:2]
        assert response.headers["Content-Range"] == f"bytes 0-1/{len(MP4)}"
        assert response.headers["Content-Length"] == "2"

        # The measurement that matters: a ranged read, and NO full read.
        assert recorder.range_reads == [(recorder.range_reads[0][0], 0, 1)]
        assert recorder.full_reads == [], "the whole object was downloaded to serve 2 bytes"
        assert recorder.bytes_read_from_storage == 2

    def test_a_bounded_range_reads_only_that_range(self, client, recorder, clip_url):
        url, _ = clip_url
        response = client.get(url, headers={"Range": "bytes=100-199"})

        assert response.status_code == 206
        assert response.data == MP4[100:200]
        assert response.headers["Content-Range"] == f"bytes 100-199/{len(MP4)}"
        assert recorder.full_reads == []
        assert recorder.bytes_read_from_storage == 100

    def test_an_open_ended_range_runs_to_the_end(self, client, recorder, clip_url):
        url, _ = clip_url
        start = len(MP4) - 50
        response = client.get(url, headers={"Range": f"bytes={start}-"})

        assert response.status_code == 206
        assert response.data == MP4[start:]
        assert response.headers["Content-Range"] == f"bytes {start}-{len(MP4) - 1}/{len(MP4)}"
        assert recorder.full_reads == []

    def test_a_suffix_range_still_works(self, client, recorder, clip_url):
        url, _ = clip_url
        response = client.get(url, headers={"Range": "bytes=-64"})

        assert response.status_code == 206
        assert response.data == MP4[-64:]
        assert response.headers["Content-Range"] == f"bytes {len(MP4) - 64}-{len(MP4) - 1}/{len(MP4)}"

    def test_a_range_past_the_end_is_clamped_not_refused(self, client, clip_url):
        # A client may legitimately ask for more than exists; the spec says
        # clamp to what is there.
        url, _ = clip_url
        response = client.get(url, headers={"Range": "bytes=0-999999"})
        assert response.status_code == 206
        assert response.data == MP4
        assert response.headers["Content-Range"] == f"bytes 0-{len(MP4) - 1}/{len(MP4)}"


class TestTheDangerousEdges:
    def test_a_start_beyond_the_object_is_a_416(self, client, clip_url):
        url, _ = clip_url
        response = client.get(url, headers={"Range": f"bytes={len(MP4) + 10}-"})

        assert response.status_code == 416
        # The total, so a confused client can correct itself rather than guess.
        assert response.headers["Content-Range"] == f"bytes */{len(MP4)}"

    def test_a_backwards_range_is_a_416(self, client, clip_url):
        url, _ = clip_url
        assert client.get(url, headers={"Range": "bytes=500-100"}).status_code == 416

    def test_unparseable_range_falls_back_to_the_whole_body(self, client, clip_url):
        # Garbage is not a boundary error. A client sending nonsense should get
        # the object, not a refusal.
        url, _ = clip_url
        response = client.get(url, headers={"Range": "bytes=abc-def"})
        assert response.status_code == 200
        assert response.data == MP4

    def test_a_non_bytes_unit_is_ignored(self, client, clip_url):
        url, _ = clip_url
        response = client.get(url, headers={"Range": "items=0-1"})
        assert response.status_code == 200
        assert response.data == MP4


class TestNothingElseChanged:
    def test_an_ordinary_get_still_returns_the_whole_clip(self, client, clip_url):
        url, _ = clip_url
        response = client.get(url)

        assert response.status_code == 200
        assert response.data == MP4
        assert response.headers["Content-Type"].startswith("video/mp4")
        # Advertised so a player's browser knows it may seek at all.
        assert response.headers["Accept-Ranges"] == "bytes"
        assert response.headers["Cache-Control"].startswith("private")
        assert response.headers["X-Content-Type-Options"] == "nosniff"

    def test_the_poster_is_unaffected(self, client, clip_url):
        _, poster_url = clip_url
        assert poster_url
        response = client.get(poster_url)
        assert response.status_code == 200
        assert response.data == WEBP
        assert response.headers["Content-Type"].startswith("image/webp")

    def test_a_poster_ignores_ranges_entirely(self, client, clip_url):
        # Small, always fetched whole, and must not pay for a HEAD it cannot use.
        _, poster_url = clip_url
        response = client.get(poster_url, headers={"Range": "bytes=0-1"})
        assert response.status_code == 200
        assert response.data == WEBP

    def test_a_live_coach_clip_still_serves(self, client, coach_headers):
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Live"}, headers=coach_headers
        ).get_json()["id"]
        question_id = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Q", "question_type": "written", "options": []},
            headers=coach_headers,
        ).get_json()["id"]
        client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={"clip": (io.BytesIO(MP4), "c.mp4"), "duration_ms": "8000"},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        quiz = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()
        url = quiz["questions"][0]["clip"]["url"]

        whole = client.get(url)
        assert whole.status_code == 200
        assert whole.data == MP4

        probe = client.get(url, headers={"Range": "bytes=0-1"})
        assert probe.status_code == 206
        assert probe.data == MP4[:2]


class TestAuthorizationIsUnchanged:
    def test_a_ranged_request_with_a_tampered_token_is_still_a_404(self, client, clip_url):
        """A Range header is not a way around the signature."""
        url, _ = clip_url
        head, _, token = url.rpartition("/")
        signature = token.rsplit(".", 1)[-1]
        forged = token[: -len(signature)] + "a" * len(signature)

        assert client.get(f"{head}/{forged}", headers={"Range": "bytes=0-1"}).status_code == 404

    def test_no_bytes_leave_storage_for_an_unauthorized_request(
        self, client, recorder, clip_url
    ):
        """Authorization happens BEFORE the object is touched, ranged or not."""
        url, _ = clip_url
        head, _, token = url.rpartition("/")
        signature = token.rsplit(".", 1)[-1]
        forged = token[: -len(signature)] + "b" * len(signature)

        client.get(f"{head}/{forged}", headers={"Range": "bytes=0-1"})

        assert recorder.range_reads == []
        assert recorder.full_reads == []
        assert recorder.size_calls == []

    def test_an_expired_token_is_still_a_404_with_a_range(self, app, client, clip_url):
        from app.models import AttemptQuestionSnapshot
        from app.extensions import db
        from app.services.signed_media import KIND_DELIVERED_CLIP, sign_media_token

        with app.app_context():
            snapshot_id = db.session.query(AttemptQuestionSnapshot.id).first()[0]
            stale = sign_media_token(KIND_DELIVERED_CLIP, snapshot_id, ttl_seconds=-1)

        assert client.get(f"/api/media/{stale}", headers={"Range": "bytes=0-1"}).status_code == 404


class TestTheBackendsReallyRangeRead:
    """The route calling `load_private_range` proves nothing on its own.

    An earlier version of this file asserted only that, and it passed happily
    against a backend that fetched everything and sliced - because the default
    implementation on the base class does exactly that. These go at the two
    real backends and check what they actually do with the object.
    """

    def test_local_storage_seeks_instead_of_reading_the_whole_file(self, tmp_path):
        from app.services.private_storage import LocalPrivateStorage

        store = LocalPrivateStorage(str(tmp_path))
        key = store.save_private(MP4, content_type="video/mp4", extension="mp4")

        slurped = []
        original = type(tmp_path).read_bytes

        def spy(self):
            slurped.append(str(self))
            return original(self)

        type(tmp_path).read_bytes = spy
        try:
            chunk = store.load_private_range(key, 0, 1)
        finally:
            type(tmp_path).read_bytes = original

        assert chunk == MP4[:2]
        # The whole-file read must never happen on the ranged path.
        assert slurped == [], "the local backend read the entire file to serve 2 bytes"

    def test_local_storage_reports_size_without_reading(self, tmp_path):
        from app.services.private_storage import LocalPrivateStorage

        store = LocalPrivateStorage(str(tmp_path))
        key = store.save_private(MP4, content_type="video/mp4", extension="mp4")
        assert store.private_size(key) == len(MP4)

    def test_r2_sends_a_real_range_header(self):
        """The production path. R2/S3 take an HTTP Range on get_object, and
        this is the call that stops several megabytes crossing the network to
        answer a two-byte probe."""
        from app.services.private_storage import S3PrivateStorage

        calls = []

        class FakeClient:
            def get_object(self, **kwargs):
                calls.append(kwargs)
                rng = kwargs.get("Range")
                assert rng is not None, "no Range sent - the whole object would be fetched"
                start, end = rng.removeprefix("bytes=").split("-")
                body = MP4[int(start) : int(end) + 1]

                class Body:
                    def read(self_inner):
                        return body

                return {"Body": Body()}

            def head_object(self, **kwargs):
                calls.append(kwargs)
                return {"ContentLength": len(MP4)}

        store = S3PrivateStorage.__new__(S3PrivateStorage)
        store.bucket_name = "peira"
        store.client = FakeClient()

        assert store.load_private_range("k", 0, 1) == MP4[:2]
        assert calls[0]["Range"] == "bytes=0-1"

    def test_r2_reports_size_with_head_not_get(self):
        from app.services.private_storage import S3PrivateStorage

        used = []

        class FakeClient:
            def head_object(self, **kwargs):
                used.append("head")
                return {"ContentLength": len(MP4)}

            def get_object(self, **kwargs):
                used.append("get")
                raise AssertionError("private_size must not download the object")

        store = S3PrivateStorage.__new__(S3PrivateStorage)
        store.bucket_name = "peira"
        store.client = FakeClient()

        assert store.private_size("k") == len(MP4)
        assert used == ["head"]
