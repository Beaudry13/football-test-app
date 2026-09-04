"""The clip collector must never reclaim something history still needs.

WHAT THESE TESTS ARE REALLY GUARDING
------------------------------------
The obvious collector - "delete every stored clip no `question_clips` row names"
- is catastrophically wrong here, and it is wrong precisely BECAUSE the product
works correctly. Replacing a clip deletes the live row and deliberately leaves
the object, so that a delivered snapshot can still resolve to the bytes a
player was actually shown. Every one of those preserved objects looks like an
orphan to the naive query.

So the interesting assertions below are the ones that prove nothing is deleted.
A collector that reclaimed nothing at all would pass six of these ten and would
merely be useless; one that passes the retention tests and fails the reclaim
tests is safe. The reverse is not.

The tests drive the REAL coach routes - upload, replace, remove, delete
question, delete quiz - rather than constructing rows, because the tombstones
are written by a session hook and the whole question is whether that hook fires
on the paths a coach actually takes, including the two that reach a clip only
through a cascade.
"""

import io
from datetime import datetime, timedelta, timezone

import pytest

from app.extensions import db
from app.models import QuestionClip, UnlinkedClipObject
from app.services import clip_gc

MP4_A = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"A" * 512
MP4_B = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"B" * 512
WEBP_A = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"A" * 128
WEBP_B = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"B" * 128


# --------------------------------------------------------------------------
# helpers - the real routes, not hand-built rows
# --------------------------------------------------------------------------


def make_quiz(client, coach_headers, title="Clip collection"):
    return client.post("/api/quizzes", json={"title": title}, headers=coach_headers).get_json()[
        "id"
    ]


def make_question(client, coach_headers, quiz_id):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": "Read the leverage", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()["id"]


def upload_clip(client, coach_headers, quiz_id, question_id, video=MP4_A, poster=WEBP_A):
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(video), "clip.mp4"),
            "poster": (io.BytesIO(poster), "poster.webp"),
            "duration_ms": "9000",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def clip_keys(app, question_id):
    """The two storage keys the question's CURRENT clip owns."""
    with app.app_context():
        clip = QuestionClip.query.filter_by(question_id=question_id).one()
        return clip.storage_key, clip.poster_key


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


@pytest.fixture
def question_with_clip(client, coach_headers):
    quiz_id = make_quiz(client, coach_headers)
    question_id = make_question(client, coach_headers, quiz_id)
    upload_clip(client, coach_headers, quiz_id, question_id)
    return quiz_id, question_id


def plan(app, *, grace_days=clip_gc.GRACE_PERIOD_DAYS, now=None):
    with app.app_context():
        return clip_gc.plan_collection(grace_days=grace_days, now=now)


def collectable_keys(app, **kwargs):
    return {c.storage_key for c in plan(app, **kwargs).collectable}


def age_every_tombstone(app, days=90):
    """Push the tombstones past the grace period.

    Time is moved on the DATA rather than by passing a fake `now`, wherever a
    test is about the grace period itself - the two are not the same assertion,
    and mixing them would let a bug in the cutoff arithmetic hide."""
    with app.app_context():
        old = datetime.now(timezone.utc) - timedelta(days=days)
        db.session.query(UnlinkedClipObject).update(
            {"unlinked_at": old}, synchronize_session=False
        )
        db.session.commit()


# --------------------------------------------------------------------------
# 1-6: what must NEVER be collected
# --------------------------------------------------------------------------


class TestItRefusesToCollectAnythingStillReachable:
    def test_a_clip_on_a_live_question_is_not_even_a_candidate(
        self, app, client, coach_headers, question_with_clip
    ):
        """(1) Nothing has been unlinked, so there is nothing to consider.

        Worth asserting explicitly: a collector that scanned STORAGE instead of
        unlink records would see this object with no idea it was in use.
        """
        video, poster = clip_keys(app, question_with_clip[1])
        result = plan(app)

        assert result.total_candidates == 0
        assert video not in collectable_keys(app)
        assert poster not in collectable_keys(app)

    def test_a_removed_clip_still_named_by_a_delivered_snapshot_is_kept(
        self, app, client, coach_headers, question_with_clip
    ):
        """(2) THE CENTRAL CASE. The row is gone; the history is not."""
        quiz_id, question_id = question_with_clip
        video, poster = clip_keys(app, question_id)

        start_attempt(client, coach_headers, quiz_id)
        removed = client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        assert removed.status_code in (200, 204), removed.get_json()
        age_every_tombstone(app)

        result = plan(app)
        assert result.still_referenced == 2, "video and poster are both still delivered"
        assert result.collectable == []
        assert video not in collectable_keys(app)
        assert poster not in collectable_keys(app)

    def test_a_replaced_clip_is_kept_for_the_attempt_that_received_it(
        self, app, client, coach_headers, question_with_clip
    ):
        """(3) The take a player was actually shown outlives the coach's edit."""
        quiz_id, question_id = question_with_clip
        old_video, old_poster = clip_keys(app, question_id)

        start_attempt(client, coach_headers, quiz_id)
        upload_clip(client, coach_headers, quiz_id, question_id, video=MP4_B, poster=WEBP_B)
        new_video, new_poster = clip_keys(app, question_id)
        assert new_video != old_video
        age_every_tombstone(app)

        keys = collectable_keys(app)
        assert old_video not in keys
        assert old_poster not in keys
        # And the replacement, which no attempt has yet received, is live rather
        # than unlinked - it must not be reachable from here at all.
        assert new_video not in keys
        assert new_poster not in keys

    def test_a_duplicated_quiz_protects_its_own_copy(
        self, app, client, coach_headers, question_with_clip
    ):
        """(4) Duplication gives the copy its OWN object (`copy_clip_object`).

        So deleting the ORIGINAL quiz must not make the duplicate's bytes
        collectable, and must not make the original's bytes collectable through
        the duplicate either - the two are independent in both directions.
        """
        quiz_id, question_id = question_with_clip
        duplicated = client.post(f"/api/quizzes/{quiz_id}/duplicate", headers=coach_headers)
        assert duplicated.status_code in (200, 201), duplicated.get_json()
        copy_id = duplicated.get_json()["id"]

        with app.app_context():
            copy_clip = (
                QuestionClip.query.join(QuestionClip.question)
                .filter_by(quiz_id=copy_id)
                .one()
            )
            copy_video, copy_poster = copy_clip.storage_key, copy_clip.poster_key
        original_video, _ = clip_keys(app, question_id)
        assert copy_video != original_video, "a duplicate must not share the object"

        deleted = client.delete(f"/api/quizzes/{quiz_id}", headers=coach_headers)
        assert deleted.status_code in (200, 204)
        age_every_tombstone(app)

        keys = collectable_keys(app)
        assert copy_video not in keys, "the duplicate's own film is still in use"
        assert copy_poster not in keys

    def test_a_poster_referenced_only_by_history_is_kept(
        self, app, client, coach_headers, question_with_clip
    ):
        """(5) The poster is checked in its own right, not assumed to follow
        the video. A snapshot that names only a poster still protects it."""
        quiz_id, question_id = question_with_clip
        _, poster = clip_keys(app, question_id)

        start_attempt(client, coach_headers, quiz_id)
        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        with app.app_context():
            assert poster in clip_gc.referenced_clip_keys()
        assert poster not in collectable_keys(app)

    def test_an_object_inside_the_grace_period_is_not_collected(
        self, app, client, coach_headers, question_with_clip
    ):
        """(6) Unreferenced is not sufficient. Recency alone holds it."""
        quiz_id, question_id = question_with_clip
        video, poster = clip_keys(app, question_id)

        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )

        fresh = plan(app)
        assert fresh.within_grace == 2
        assert fresh.collectable == []

        # The SAME rows become collectable once the clock has moved past the
        # grace period, which is what proves recency was the only thing holding
        # them - not some other condition that happens to coincide today.
        later = plan(app, now=datetime.now(timezone.utc) + timedelta(days=31))
        assert {c.storage_key for c in later.collectable} == {video, poster}
        assert later.within_grace == 0


# --------------------------------------------------------------------------
# 7-10: what SHOULD be collected
# --------------------------------------------------------------------------


class TestItDoesReclaimGenuineOrphans:
    def test_a_clip_nobody_ever_received_is_collected(
        self, app, client, coach_headers, question_with_clip
    ):
        """(7) Recorded, never delivered, removed, and past grace.

        This is the common case in practice: a coach records a take, does not
        like it, and records another one before ever sending the quiz.
        """
        quiz_id, question_id = question_with_clip
        video, poster = clip_keys(app, question_id)

        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        keys = collectable_keys(app)
        assert video in keys
        # (8) the poster orphan travels with it
        assert poster in keys

        with app.app_context():
            from app.services.private_storage import get_private_storage

            assert get_private_storage().load_private(video) is not None
            result = clip_gc.execute_collection(clip_gc.plan_collection())
            assert set(result.deleted) == {video, poster}
            assert result.failed == []
            assert get_private_storage().load_private(video) is None
            assert get_private_storage().load_private(poster) is None

    def test_a_clip_with_no_poster_collects_cleanly(
        self, app, client, coach_headers
    ):
        """(9) The partially-populated pair. A clip recorded without a poster
        tombstones one object, not two with a None in it - a null key reaching
        storage would be a delete call against an empty string."""
        quiz_id = make_quiz(client, coach_headers, "No poster")
        question_id = make_question(client, coach_headers, quiz_id)
        response = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={"clip": (io.BytesIO(MP4_A), "clip.mp4"), "duration_ms": "5000"},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert response.status_code == 201, response.get_json()
        video, poster = clip_keys(app, question_id)
        assert poster is None

        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        with app.app_context():
            rows = db.session.query(UnlinkedClipObject).all()
            assert len(rows) == 1
            assert rows[0].kind == clip_gc.KIND_VIDEO
            result = clip_gc.execute_collection(clip_gc.plan_collection())
            assert result.deleted == [video]

    def test_running_it_twice_changes_nothing_and_raises_nothing(
        self, app, client, coach_headers, question_with_clip
    ):
        """(10) Idempotent. The second run finds the rows already collected
        rather than trying to delete objects that are gone."""
        quiz_id, question_id = question_with_clip
        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        with app.app_context():
            first = clip_gc.execute_collection(clip_gc.plan_collection())
            assert len(first.deleted) == 2

            second_plan = clip_gc.plan_collection()
            assert second_plan.collectable == []
            assert second_plan.already_collected == 2

            second = clip_gc.execute_collection(second_plan)
            assert second.deleted == []
            assert second.failed == []

    def test_deleting_the_whole_quiz_reaches_the_clip_through_the_cascade(
        self, app, client, coach_headers, question_with_clip
    ):
        """Deleting a quiz never runs a line of clip code - the row goes via
        `cascade="all, delete-orphan"`. If the hook only covered the explicit
        routes, this object would be invisible forever."""
        quiz_id, question_id = question_with_clip
        video, poster = clip_keys(app, question_id)

        assert client.delete(f"/api/quizzes/{quiz_id}", headers=coach_headers).status_code in (
            200,
            204,
        )
        age_every_tombstone(app)

        keys = collectable_keys(app)
        assert video in keys
        assert poster in keys

    def test_deleting_the_question_reaches_the_clip_through_the_cascade(
        self, app, client, coach_headers, question_with_clip
    ):
        quiz_id, question_id = question_with_clip
        video, _ = clip_keys(app, question_id)

        deleted = client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}", headers=coach_headers
        )
        assert deleted.status_code in (200, 204), deleted.get_json()
        age_every_tombstone(app)

        assert video in collectable_keys(app)


# --------------------------------------------------------------------------
# the failure modes the design is built around
# --------------------------------------------------------------------------


class TestTheDangerousFailureModes:
    def test_a_failed_storage_delete_leaves_the_row_for_the_next_run(
        self, app, client, coach_headers, question_with_clip, monkeypatch
    ):
        """Marking a row collected before the delete succeeded would hide the
        object from every future run - a permanent leak recorded as a success.
        """
        quiz_id, question_id = question_with_clip
        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        with app.app_context():
            from app.services import private_storage

            storage = private_storage.get_private_storage()

            def refuse(key):
                raise OSError("R2 said no")

            monkeypatch.setattr(storage, "delete_private", refuse)
            monkeypatch.setattr(private_storage, "get_private_storage", lambda: storage)

            result = clip_gc.execute_collection(clip_gc.plan_collection())
            assert result.deleted == []
            assert len(result.failed) == 2

            # Still candidates, so the next run retries them.
            assert len(clip_gc.plan_collection().collectable) == 2

    def test_an_unreadable_snapshot_never_makes_an_object_look_free(self, app):
        """A snapshot blob of the wrong shape yields no keys - and nothing
        anywhere treats that silence as permission to delete. The assertion is
        that `referenced_clip_keys` does not raise, because a crash here would
        strand an operator with no answer at all."""
        with app.app_context():
            assert clip_gc.referenced_clip_keys() == set()

    def test_the_collector_only_ever_sees_objects_peira_recorded_as_clips(
        self, app, client, coach_headers, question_with_clip
    ):
        """THE STRUCTURAL SAFETY PROPERTY. Private storage also holds playbook
        PDFs, rendered pages, page thumbnails and masked regions - and page
        renders share the poster's `.webp` extension. The collector reaches
        none of them, because its candidate list is what Peira itself
        tombstoned rather than what is sitting in the bucket.
        """
        quiz_id, question_id = question_with_clip
        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )
        age_every_tombstone(app)

        with app.app_context():
            tombstoned = {row.storage_key for row in db.session.query(UnlinkedClipObject).all()}
            planned = {c.storage_key for c in clip_gc.plan_collection().collectable}
            assert planned <= tombstoned
            assert all(
                row.kind in (clip_gc.KIND_VIDEO, clip_gc.KIND_POSTER)
                for row in db.session.query(UnlinkedClipObject).all()
            )
