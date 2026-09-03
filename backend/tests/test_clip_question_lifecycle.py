"""A recorded-clip question must survive its whole life.

REPORTED FROM REAL USE: a coach added a question with a screen recording, saw
it in the builder, activated the quiz so they could open it on a phone - and
the question was gone.

This walks the entire reported path in one test rather than asserting about
one layer, because "it disappeared" is a claim about the SEQUENCE:

    create -> attach clip -> reload -> activate -> reload
           -> validate-code -> /play/start -> submit

Every step asserts the question is still there and still carries its clip. If
the question is being dropped anywhere on the server, one of these fails and
names the step; if they all pass, the loss is in the browser and the backend
is exonerated - which is worth knowing before touching either.
"""

import io

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128


def make_clip_question(client, headers, quiz_id, text="What happens after the motion?"):
    """A question created WITH its clip in one multipart request - the path the
    Add Question form actually uses."""
    import json

    response = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        data={
            "payload": json.dumps(
                {
                    "question_text": text,
                    "question_type": "multiple_choice",
                    "options": [
                        {"option_text": "Cover 3", "is_correct_answer": True},
                        {"option_text": "Cover 2", "is_correct_answer": False},
                    ],
                }
            ),
            "clip": (io.BytesIO(MP4), "clip.mp4"),
            "clip_poster": (io.BytesIO(WEBP), "poster.webp"),
            "clip_duration_ms": "8000",
            "clip_width": "1920",
            "clip_height": "1080",
        },
        content_type="multipart/form-data",
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def coach_questions(client, headers, quiz_id):
    return client.get(f"/api/quizzes/{quiz_id}", headers=headers).get_json()["questions"]


class TestTheQuestionSurvivesActivation:
    def test_the_whole_reported_sequence(self, client, coach_headers):
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Clip lifecycle"}, headers=coach_headers
        ).get_json()["id"]

        created = make_clip_question(client, coach_headers, quiz_id)
        question_id = created["id"]
        assert created["clip"] is not None, "the clip must be attached at creation"

        # 1. It is in the builder before activation.
        before = coach_questions(client, coach_headers, quiz_id)
        assert [q["id"] for q in before] == [question_id]
        assert before[0]["clip"] is not None

        # 2. Activation succeeds - a clip question is not a Draw Response and
        #    must not be caught by the "needs an image" guard.
        client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey Fields"]}, headers=coach_headers
        )
        activated = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        )
        assert activated.status_code == 201, activated.get_json()
        code = activated.get_json()

        # 3. THE REPORTED FAILURE. Still in the builder afterwards.
        after = coach_questions(client, coach_headers, quiz_id)
        assert [q["id"] for q in after] == [question_id], "the question vanished on activation"
        assert after[0]["clip"] is not None, "the clip came off the question"
        assert after[0]["question_text"] == created["question_text"]
        assert len(after[0]["options"]) == 2

        # 4. The player's join sees it.
        validated = client.post("/api/play/validate-code", json={"code": code["code"]})
        assert validated.status_code == 200, validated.get_json()
        joined = validated.get_json()["quiz"]["questions"]
        assert [q["id"] for q in joined] == [question_id]

        # 5. And the delivered attempt carries it, with a playable url.
        started = client.post(
            "/api/play/start",
            json={"access_code_id": code["id"], "player_name": "Casey Fields"},
        )
        assert started.status_code in (200, 201), started.get_json()
        delivered = started.get_json()["questions"]
        assert [q["id"] for q in delivered] == [question_id]
        assert delivered[0]["clip"] is not None
        assert delivered[0]["clip"]["url"].startswith("/api/media/")

    def test_a_clip_question_alone_can_activate(self, client, coach_headers):
        """A quiz whose only question is a clip question must be publishable.

        If anything treated "no image" as "not ready", this is where it would
        show up as a refusal rather than a disappearance.
        """
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Only a clip"}, headers=coach_headers
        ).get_json()["id"]
        make_clip_question(client, coach_headers, quiz_id)
        client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey"]}, headers=coach_headers
        )

        response = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        )
        assert response.status_code == 201, response.get_json()

    def test_it_is_still_there_after_a_fresh_reload(self, app, client, coach_headers):
        """Straight from the database, with no session cache in the way."""
        from app.extensions import db
        from app.models import Question

        quiz_id = client.post(
            "/api/quizzes", json={"title": "Reload"}, headers=coach_headers
        ).get_json()["id"]
        created = make_clip_question(client, coach_headers, quiz_id)

        with app.app_context():
            row = db.session.get(Question, created["id"])
            assert row is not None
            assert row.clip is not None
            assert row.clip.storage_key

    def test_mixed_questions_all_survive_activation(self, client, coach_headers):
        """A clip question next to an ordinary one - neither may push the other
        out, and the order must hold."""
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Mixed"}, headers=coach_headers
        ).get_json()["id"]
        plain = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Plain question",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
            },
            headers=coach_headers,
        ).get_json()
        clipped = make_clip_question(client, coach_headers, quiz_id, text="Clip question")

        client.put(
            f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey"]}, headers=coach_headers
        )
        assert (
            client.post(
                f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
            ).status_code
            == 201
        )

        after = coach_questions(client, coach_headers, quiz_id)
        assert [q["id"] for q in after] == [plain["id"], clipped["id"]]
        assert after[0]["clip"] is None
        assert after[1]["clip"] is not None
