"""Record Clip: storage, validation, exclusivity and history.

THE RULE THESE TESTS EXIST FOR
------------------------------
A clip that is not really an H.264 MP4 fails on somebody's phone as a blank
rectangle, with no error anywhere and no way for the coach to find out. The
frontend refuses to record anything else; this is the half that refuses to
STORE anything else, because a browser we have not measured, an older build,
or a hand-rolled request would otherwise get through.
"""

import io

import pytest

from app.models import Question, QuestionClip, QuestionType, Quiz
from app.services.clip_storage import looks_like_mp4

# A minimal but structurally honest MP4 header: size, `ftyp`, brand, then
# padding. Enough for the container check, which is all the server does - it
# deliberately does not decode video.
MP4_BYTES = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBM_BYTES = b"\x1a\x45\xdf\xa3" + b"\x00" * 512
WEBP_BYTES = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128


@pytest.fixture
def quiz_with_question(client, coach_headers, app):
    created = client.post(
        "/api/quizzes", json={"title": "Clip quiz"}, headers=coach_headers
    )
    assert created.status_code == 201, created.get_json()
    quiz_id = created.get_json()["id"]
    question = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": "What happens next?",
            "question_type": "written",
            "options": [],
        },
        headers=coach_headers,
    )
    assert question.status_code == 201, question.get_json()
    return quiz_id, question.get_json()["id"]


def upload_clip(client, headers, quiz_id, question_id, *, clip=MP4_BYTES, poster=WEBP_BYTES):
    data = {"clip": (io.BytesIO(clip), "clip.mp4")}
    if poster is not None:
        data["poster"] = (io.BytesIO(poster), "poster.webp")
    data["duration_ms"] = "9000"
    data["width"] = "1280"
    data["height"] = "720"
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
        data=data,
        content_type="multipart/form-data",
        headers=headers,
    )


class TestContainerValidation:
    def test_accepts_a_real_mp4(self, client, coach_headers, quiz_with_question):
        quiz_id, question_id = quiz_with_question
        response = upload_clip(client, coach_headers, quiz_id, question_id)
        assert response.status_code == 201, response.get_json()
        body = response.get_json()
        assert body["content_type"] == "video/mp4"
        assert body["has_poster"] is True

    def test_refuses_webm_even_though_a_browser_would_record_it(
        self, client, coach_headers, quiz_with_question
    ):
        # The measured default of Chrome and Edge. Storing it would produce a
        # question that plays for the coach and not for the squad.
        quiz_id, question_id = quiz_with_question
        response = upload_clip(client, coach_headers, quiz_id, question_id, clip=WEBM_BYTES)
        assert response.status_code == 400
        assert "MP4" in response.get_json()["error"]

    def test_refuses_a_renamed_file(self, client, coach_headers, quiz_with_question):
        # The filename and the multipart content type are both client claims.
        # The `ftyp` box is not.
        quiz_id, question_id = quiz_with_question
        response = upload_clip(client, coach_headers, quiz_id, question_id, clip=b"not a video")
        assert response.status_code == 400

    def test_refuses_an_oversize_clip(self, client, coach_headers, quiz_with_question, app):
        quiz_id, question_id = quiz_with_question
        app.config["CLIP_MAX_UPLOAD_BYTES"] = 1024
        response = upload_clip(
            client, coach_headers, quiz_id, question_id, clip=MP4_BYTES + b"\x00" * 4096
        )
        assert response.status_code == 413

    def test_magic_byte_check_is_positional(self):
        # A WebM whose metadata happens to contain the letters "ftyp" must not
        # pass, which is why the check reads bytes 4-8 rather than searching.
        assert looks_like_mp4(MP4_BYTES)
        assert not looks_like_mp4(WEBM_BYTES)
        assert not looks_like_mp4(b"ftyp" + b"\x00" * 32)


class TestOneSourceOfVisualMaterial:
    """A question shows a still, OR a playbook region, OR a clip."""

    def test_clip_refused_when_the_question_already_has_an_image(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        with app.app_context():
            from app.extensions import db
            from app.models import QuestionImage

            db.session.add(
                QuestionImage(question_id=question_id, image_url="/uploads/x.jpg", annotations=[])
            )
            db.session.commit()
        response = upload_clip(client, coach_headers, quiz_id, question_id)
        assert response.status_code == 422
        assert "image" in response.get_json()["error"].lower()

    def test_image_refused_when_the_question_already_has_a_clip(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        assert upload_clip(client, coach_headers, quiz_id, question_id).status_code == 201
        response = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/image",
            data={"image": (io.BytesIO(b"\xff\xd8\xff\xe0" + b"\x00" * 64), "x.jpg")},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert response.status_code == 422
        assert "clip" in response.get_json()["error"].lower()


class TestDrawResponseIsProtected:
    """A drawing binds to a still's coordinate space. Over moving pictures
    there is no answer to "which frame was this drawn against", so both doors
    into that state are shut - and on the server, not just in the editor."""

    def test_clip_refused_on_a_draw_response_question(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        with app.app_context():
            from app.extensions import db

            question = db.session.get(Question, question_id)
            question.question_type = QuestionType.DRAW_RESPONSE
            db.session.commit()
        response = upload_clip(client, coach_headers, quiz_id, question_id)
        assert response.status_code == 422
        assert "draw" in response.get_json()["error"].lower()

    def test_type_cannot_be_changed_to_draw_response_while_a_clip_exists(
        self, client, coach_headers, quiz_with_question
    ):
        # The other direction: record first, then switch the type.
        quiz_id, question_id = quiz_with_question
        assert upload_clip(client, coach_headers, quiz_id, question_id).status_code == 201
        response = client.patch(
            f"/api/quizzes/{quiz_id}/questions/{question_id}",
            json={
                "question_text": "What happens next?",
                "question_type": "draw_response",
                "options": [],
            },
            headers=coach_headers,
        )
        assert response.status_code == 422
        assert "clip" in response.get_json()["error"].lower()


class TestOwnership:
    def test_another_organization_cannot_upload_a_clip(
        self, client, register_coach, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        _, _, other = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        response = upload_clip(client, other, quiz_id, question_id)
        assert response.status_code in (403, 404)

    def test_anonymous_cannot_upload_a_clip(self, client, quiz_with_question):
        quiz_id, question_id = quiz_with_question
        response = upload_clip(client, {}, quiz_id, question_id)
        assert response.status_code == 401


class TestReplaceAndRemove:
    def test_replacing_keeps_the_old_object_for_history(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        with app.app_context():
            from app.extensions import db
            from app.services.private_storage import get_private_storage

            first_key = db.session.query(QuestionClip).filter_by(question_id=question_id).one().storage_key

        upload_clip(client, coach_headers, quiz_id, question_id)

        with app.app_context():
            from app.extensions import db
            from app.services.private_storage import get_private_storage

            second_key = db.session.query(QuestionClip).filter_by(question_id=question_id).one().storage_key
            assert second_key != first_key
            # HISTORICAL INTEGRITY OVER STORAGE TIDINESS. A delivered snapshot
            # may name the old key; deleting the object would blank a finished
            # attempt's evidence. Recorded as cleanup debt instead.
            assert get_private_storage().load_private(first_key) is not None

    def test_removing_a_clip_leaves_the_question(self, client, coach_headers, quiz_with_question):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        assert (
            client.delete(
                f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
            ).status_code
            == 204
        )
        quiz = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers)
        assert quiz.get_json()["questions"][0]["clip"] is None

    def test_removing_a_clip_that_is_not_there(self, client, coach_headers, quiz_with_question):
        quiz_id, question_id = quiz_with_question
        assert (
            client.delete(
                f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
            ).status_code
            == 404
        )


class TestDuplication:
    def test_a_duplicated_quiz_gets_its_own_clip_object(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)

        duplicated = client.post(f"/api/quizzes/{quiz_id}/duplicate", headers=coach_headers)
        assert duplicated.status_code == 201, duplicated.get_json()
        copy_id = duplicated.get_json()["id"]

        with app.app_context():
            from app.extensions import db
            from app.services.private_storage import get_private_storage

            original = db.session.query(QuestionClip).filter_by(question_id=question_id).one()
            copy_quiz = db.session.get(Quiz, copy_id)
            copied = copy_quiz.questions[0].clip
            assert copied is not None
            # ITS OWN OBJECT. A shared key means the first destructive edit on
            # either side blanks the other - proven in both directions for
            # images before it was fixed.
            assert copied.storage_key != original.storage_key
            assert copied.poster_key != original.poster_key
            assert get_private_storage().load_private(copied.storage_key) is not None

    def test_deleting_the_original_leaves_the_copy_playable(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        copy_id = client.post(
            f"/api/quizzes/{quiz_id}/duplicate", headers=coach_headers
        ).get_json()["id"]

        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip", headers=coach_headers
        )

        with app.app_context():
            from app.extensions import db
            from app.services.private_storage import get_private_storage

            copied = db.session.get(Quiz, copy_id).questions[0].clip
            assert copied is not None
            assert get_private_storage().load_private(copied.storage_key) is not None


class TestSignedDelivery:
    """Serving is where the real-device test succeeds or fails.

    iOS Safari opens a video with `Range: bytes=0-1` and treats a server that
    answers 200-with-everything as unable to serve media at all. That failure
    looks exactly like a codec problem from the outside, so it would send a
    real-device test chasing the wrong thing. These assert the transport.
    """

    def _token(self, app, clip_id, kind):
        from app.services.signed_media import AUDIENCE_COACH, sign_media_token

        with app.app_context():
            return sign_media_token(kind, clip_id, audience=AUDIENCE_COACH)

    def _clip_id(self, app, question_id):
        with app.app_context():
            from app.extensions import db

            return db.session.query(QuestionClip).filter_by(question_id=question_id).one().id

    def test_serves_the_clip_with_the_right_content_type(
        self, client, coach_headers, quiz_with_question, app
    ):
        from app.services.signed_media import KIND_CLIP

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        response = client.get(f"/api/media/{self._token(app, clip_id, KIND_CLIP)}")
        assert response.status_code == 200
        assert response.headers["Content-Type"].startswith("video/mp4")
        assert response.headers["Accept-Ranges"] == "bytes"
        assert response.data == MP4_BYTES

    def test_answers_the_opening_probe_with_206(
        self, client, coach_headers, quiz_with_question, app
    ):
        from app.services.signed_media import KIND_CLIP

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        response = client.get(
            f"/api/media/{self._token(app, clip_id, KIND_CLIP)}",
            headers={"Range": "bytes=0-1"},
        )
        assert response.status_code == 206
        assert response.data == MP4_BYTES[:2]
        assert response.headers["Content-Range"] == f"bytes 0-1/{len(MP4_BYTES)}"

    def test_handles_an_open_ended_range(self, client, coach_headers, quiz_with_question, app):
        from app.services.signed_media import KIND_CLIP

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        response = client.get(
            f"/api/media/{self._token(app, clip_id, KIND_CLIP)}",
            headers={"Range": "bytes=10-"},
        )
        assert response.status_code == 206
        assert response.data == MP4_BYTES[10:]

    def test_a_nonsense_range_falls_back_to_the_whole_body(
        self, client, coach_headers, quiz_with_question, app
    ):
        from app.services.signed_media import KIND_CLIP

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        response = client.get(
            f"/api/media/{self._token(app, clip_id, KIND_CLIP)}",
            headers={"Range": "bytes=abc-def"},
        )
        assert response.status_code == 200
        assert response.data == MP4_BYTES

    def test_the_poster_is_served_as_an_image(
        self, client, coach_headers, quiz_with_question, app
    ):
        from app.services.signed_media import KIND_CLIP_POSTER

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        response = client.get(f"/api/media/{self._token(app, clip_id, KIND_CLIP_POSTER)}")
        assert response.status_code == 200
        assert response.headers["Content-Type"].startswith("image/webp")

    def test_an_unsigned_or_tampered_token_is_a_404(
        self, client, coach_headers, quiz_with_question, app
    ):
        from app.services.signed_media import KIND_CLIP

        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        clip_id = self._clip_id(app, question_id)

        assert client.get("/api/media/not-a-token").status_code == 404
        token = self._token(app, clip_id, KIND_CLIP)
        # Flipping one character of the signature must not open the door - and
        # it must fail identically to an unknown id, so a probe learns nothing.
        assert client.get(f"/api/media/{token[:-1]}x").status_code == 404


class TestAudienceSeparation:
    """A player must never receive a coach-audience media token.

    This was a real defect, caught by decoding a token in a browser rather
    than by any assertion: `/validate-code` serialises questions for a PLAYER
    through the coach serializer, so minting a URL there stamped `coach` on a
    credential handed to an anonymous player. It played perfectly, which is
    precisely why nothing flagged it.

    A player's clip URL is minted in routes/play.py, audienced to the access
    code they are using, so a leaked URL stays traceable to the code it was
    issued for.
    """

    def _decode_audience(self, token_url):
        import base64
        import json

        token = token_url.rsplit("/", 1)[-1]
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_b64))["a"]

    def test_the_coach_payload_carries_a_coach_token(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        quiz = client.get(f"/api/quizzes/{quiz_id}", headers=coach_headers).get_json()
        clip = quiz["questions"][0]["clip"]
        assert clip["url"]
        assert self._decode_audience(clip["url"]) == "coach"

    def test_the_player_facing_serializer_carries_no_credential(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)

        with app.app_context():
            from app.extensions import db
            from app.models import Quiz

            quiz = db.session.get(Quiz, quiz_id)
            # The exact call /validate-code makes.
            payload = quiz.to_dict(include_questions=True, include_correct_answers=False)

        clip = payload["questions"][0]["clip"]
        # Metadata is fine - it says a clip exists and how big it is.
        assert clip is not None
        assert clip["content_type"] == "video/mp4"
        # A credential is not.
        assert "url" not in clip
        assert "poster_url" not in clip

    def test_the_coach_serializer_still_carries_one(
        self, client, coach_headers, quiz_with_question, app
    ):
        quiz_id, question_id = quiz_with_question
        upload_clip(client, coach_headers, quiz_id, question_id)
        with app.app_context():
            from app.extensions import db
            from app.models import Quiz

            payload = db.session.get(Quiz, quiz_id).to_dict(
                include_questions=True, include_correct_answers=True
            )
        assert payload["questions"][0]["clip"]["url"]
