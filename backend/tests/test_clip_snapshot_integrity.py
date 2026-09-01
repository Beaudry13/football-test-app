"""A player must keep seeing the clip they were delivered.

The rule this protects is the one the whole snapshot architecture exists for:
an attempt records what it RECEIVED, and a coach editing the live question
afterwards must not change what a finished attempt claims to have contained.

For a clip the mechanism is specific and worth stating: the snapshot freezes
the STORAGE KEY, not the clip row's id. Replacing a clip writes a new row and
leaves the old object in storage untouched, so a frozen key still resolves to
the exact bytes that were shown. Freezing the row id instead would follow the
coach's edit, which is the failure.
"""

import io

import pytest

from app.models import QuestionClip
from app.services.delivered_questions import delivered_questions
from app.services.question_snapshots import build_snapshot

MP4_BYTES = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBP_BYTES = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128


@pytest.fixture
def question_with_clip(client, coach_headers, app):
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Clip history"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={"question_text": "Read the leverage", "question_type": "written", "options": []},
        headers=coach_headers,
    ).get_json()["id"]
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(MP4_BYTES), "clip.mp4"),
            "poster": (io.BytesIO(WEBP_BYTES), "poster.webp"),
            "duration_ms": "9000",
            "width": "1280",
            "height": "720",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )
    assert response.status_code == 201, response.get_json()
    return quiz_id, question_id


def test_snapshot_records_the_delivered_clip(app, question_with_clip):
    _, question_id = question_with_clip
    with app.app_context():
        from app.extensions import db
        from app.models import Question

        question = db.session.get(Question, question_id)
        snapshot = build_snapshot(question)

    assert snapshot["clip"] is not None
    # The KEY is what makes this evidence. An id would follow a later edit.
    assert snapshot["clip"]["storage_key"] == question.clip.storage_key
    assert snapshot["clip"]["content_type"] == "video/mp4"
    assert snapshot["clip"]["poster_key"]


def test_a_snapshot_survives_the_coach_replacing_the_clip(
    app, client, coach_headers, question_with_clip
):
    quiz_id, question_id = question_with_clip
    with app.app_context():
        from app.extensions import db
        from app.models import Question

        delivered_snapshot = build_snapshot(db.session.get(Question, question_id))
        original_key = delivered_snapshot["clip"]["storage_key"]

    # The coach records a different clip over it.
    client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data={
            "clip": (io.BytesIO(MP4_BYTES + b"\x01" * 32), "clip.mp4"),
            "duration_ms": "5000",
        },
        content_type="multipart/form-data",
        headers=coach_headers,
    )

    with app.app_context():
        from app.extensions import db
        from app.services.private_storage import get_private_storage

        live = db.session.query(QuestionClip).filter_by(question_id=question_id).one()
        # The live question moved on...
        assert live.storage_key != original_key
        # ...and the delivered snapshot did not, and still resolves.
        assert delivered_snapshot["clip"]["storage_key"] == original_key
        assert get_private_storage().load_private(original_key) is not None


def test_a_snapshot_without_a_clip_reads_as_no_clip(app, question_with_clip):
    """Every attempt recorded before this feature existed has no `clip` key.

    That is the honest record - those attempts were delivered no clip - so it
    must read as None rather than reaching for whatever the live question
    happens to hold today.
    """
    from app.services.delivered_questions import _clip_from_snapshot

    assert _clip_from_snapshot(None) is None
    assert _clip_from_snapshot({}) is None
    # A malformed row is also not a licence to invent one.
    assert _clip_from_snapshot({"storage_key": ""}) is None
    assert _clip_from_snapshot("nonsense") is None


def test_delivered_questions_reads_the_clip_back(app, client, coach_headers, question_with_clip):
    """The single reader - the one every surface goes through - must surface
    the clip, or Results, exports and the coach's expanded view would disagree
    about what a player was shown."""
    quiz_id, question_id = question_with_clip
    with app.app_context():
        from app.extensions import db
        from app.models import Question, Quiz

        quiz = db.session.get(Quiz, quiz_id)

        # An attempt with no snapshots falls back to the live quiz, which is
        # the documented legacy path.
        class _AttemptWithoutSnapshots:
            question_snapshots: list = []

        delivered = delivered_questions(_AttemptWithoutSnapshots(), quiz)
        assert len(delivered) == 1
        assert delivered[0].clip is not None
        assert delivered[0].clip.storage_key == db.session.get(Question, question_id).clip.storage_key
        assert delivered[0].clip.content_type == "video/mp4"


def test_play_start_gives_the_player_an_access_code_scoped_clip_url(
    client, coach_headers, question_with_clip
):
    """The player's own URL, audienced to the code they are using.

    A leaked media URL should be traceable to the access code it was issued
    for. Serving a player a `coach` token would break that - and it played
    perfectly when it happened, which is why this is asserted rather than
    looked at.
    """
    import base64
    import json

    quiz_id, _ = question_with_clip
    client.put(
        f"/api/quizzes/{quiz_id}/roster",
        json={"players": ["Casey Fields"]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
    )
    assert code.status_code == 201, code.get_json()
    access_code = code.get_json()

    started = client.post(
        "/api/play/start",
        json={"access_code_id": access_code["id"], "player_name": "Casey Fields"},
    )
    assert started.status_code in (200, 201), started.get_json()

    questions = started.get_json()["questions"]
    clipped = [q for q in questions if q.get("clip")]
    assert clipped, "the delivered question should carry its clip"
    clip = clipped[0]["clip"]

    assert clip["url"].startswith("/api/media/")
    assert clip["content_type"] == "video/mp4"

    token = clip["url"].rsplit("/", 1)[-1]
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    # Audienced to this access code, not to a coach.
    assert payload["a"] == f"ac:{access_code['id']}"
    assert payload["k"] == "clip"

    # And the player payload still leaks nothing about the answer.
    raw = started.get_data(as_text=True)
    assert "is_correct_answer" not in raw
    assert "expected_answers" not in raw
