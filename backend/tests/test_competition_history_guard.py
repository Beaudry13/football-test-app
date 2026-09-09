"""A question a competition has already played must stop being editable.

WHY THIS GUARD IS NOT THE SAME AS THE DELIVERED-QUESTION RULES.

An ordinary attempt records what it received in `attempt_question_snapshots`,
so correcting a question changes what FUTURE players get and cannot reach back
into a finished attempt. That is what makes safe correction safe, and it is
what the rest of the editing rules rest on.

COMPETITION HAS NO SUCH RECORD. `question_order` freezes WHICH questions a room
played and in what order; the CONTENT is read live through `question_id` every
single time. So without this guard a reworded question silently rewrites what a
team was asked, and a competition they have already played stops matching what
happened in the room.

Wording has always been editable, so this hole predates safe correction - but
making correction discoverable is exactly what turns a latent hole into one a
coach walks into on an ordinary Tuesday.

WHAT IS DELIBERATELY NOT GUARDED: retiring, restoring and reordering. Retiring
stops a question being sent again without altering it, and delivered order
comes from each attempt's own snapshot rather than the live list.
"""

import io

import pytest

from app.extensions import db
from app.models import CompetitionSession
from app.models.competition import ABANDONED, COMPLETE, LOBBY, QUESTION_OPEN

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 512
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 128


@pytest.fixture
def quiz_with_question(client, coach_headers):
    quiz_id = client.post(
        "/api/quizzes", json={"title": "Competition install"}, headers=coach_headers
    ).get_json()["id"]
    question_id = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": "Which coverage is shown?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()["id"]
    return quiz_id, question_id


def play_competition(app, quiz_id, question_ids, status=COMPLETE):
    """A session that has LEFT the lobby, carrying these questions.

    Built directly rather than through the competition routes: this suite is
    about the QUESTION-EDITING guard, and driving a whole room through lobby,
    rounds and podium to assert a 422 would make the test about Competition
    instead. Org and coach are taken from the quiz so the row is real.
    """
    from datetime import datetime, timedelta, timezone

    from app.models import Quiz

    with app.app_context():
        quiz = db.session.get(Quiz, quiz_id)
        session = CompetitionSession(
            expires_at=datetime.now(timezone.utc) + timedelta(hours=6),
            organization_id=quiz.organization_id,
            coach_id=quiz.coach_id,
            quiz_id=quiz_id,
            join_code=f"T{quiz_id:05d}"[:6],
            status=status,
            question_order=list(question_ids),
        )
        db.session.add(session)
        db.session.commit()


def reword(client, coach_headers, quiz_id, question_id, text="Reworded"):
    return client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 3", "is_correct_answer": True},
                {"option_text": "Cover 2", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    )


class TestAPlayedCompetitionFreezesTheQuestion:
    def test_rewording_is_refused_with_its_own_reason(
        self, app, client, coach_headers, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id])

        response = reword(client, coach_headers, quiz_id, question_id)

        assert response.status_code == 422
        body = response.get_json()
        assert body["reason"] == "competition_history_blocked"
        # The coach is told what to do instead, not just told no.
        assert "stop sending" in body["error"].lower()

    def test_the_question_text_is_actually_unchanged(
        self, app, client, coach_headers, quiz_with_question
    ):
        """A refusal that still wrote would be worse than no guard at all."""
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id])

        reword(client, coach_headers, quiz_id, question_id, "Rewritten history")

        from app.models import Question

        with app.app_context():
            assert db.session.get(Question, question_id).question_text == (
                "Which coverage is shown?"
            )

    def test_an_abandoned_session_still_counts_as_played(
        self, app, client, coach_headers, quiz_with_question
    ):
        # The room saw the questions. Abandoning does not unsee them.
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id], status=ABANDONED)

        assert reword(client, coach_headers, quiz_id, question_id).status_code == 422

    def test_a_session_mid_play_counts_too(
        self, app, client, coach_headers, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id], status=QUESTION_OPEN)

        assert reword(client, coach_headers, quiz_id, question_id).status_code == 422

    def test_media_changes_are_refused_too(
        self, app, client, coach_headers, quiz_with_question
    ):
        """Replacing the picture rewrites the room's history exactly as
        rewording does - the competition reads both live."""
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id])

        response = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/clip",
            data={"clip": (io.BytesIO(MP4), "clip.mp4"), "duration_ms": "5000"},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert response.status_code == 422
        assert response.get_json()["reason"] == "competition_history_blocked"

    def test_DELETION_is_NOT_this_guard_s_job(
        self, app, client, coach_headers, quiz_with_question
    ):
        """THE BOUNDARY, corrected after the full suite disagreed with it.

        This guard blocks SILENT content mutation - rewording makes a finished
        room's questions read differently with nothing to notice it. Deletion
        is not silent, and Competition already has explicit resilience for a
        question vanishing: a deleted round is stepped over, and deleting the
        last remaining question ends the run cleanly. Both are covered in
        tests/test_competition_answers.py::TestDeletedQuestion, which this
        guard must not break - it did, and that is how the mistake surfaced.

        Deletion keeps its own, stronger protection: a competition answer IS an
        answer, so `_reject_if_already_answered` refuses a question anybody has
        actually answered. What must NOT happen is this guard adding a second,
        competition-specific deletion rule on top of it.
        """
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id])

        response = client.delete(
            f"/api/quizzes/{quiz_id}/questions/{question_id}", headers=coach_headers
        )

        # Whatever the outcome, it must not be THIS guard doing the refusing.
        body = response.get_json() if response.status_code >= 400 else {}
        assert body.get("reason") != "competition_history_blocked"


class TestWhatMustStayEditable:
    def test_a_lobby_session_has_shown_nothing_yet(
        self, app, client, coach_headers, quiz_with_question
    ):
        """A coach must be able to fix a typo right up until the room starts.
        A lobby has put nothing on anybody's screen."""
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id], status=LOBBY)

        assert reword(client, coach_headers, quiz_id, question_id).status_code == 200

    def test_a_question_NOT_in_the_played_order_is_untouched(
        self, app, client, coach_headers, quiz_with_question
    ):
        """THE PRECISION THAT MAKES THIS USABLE. Blocking every question on a
        quiz that has ever hosted a competition would freeze whole quizzes; the
        guard reads the played order, so only the questions actually put on the
        room's screen are protected."""
        quiz_id, question_id = quiz_with_question
        other_id = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={"question_text": "Second", "question_type": "written", "options": []},
            headers=coach_headers,
        ).get_json()["id"]

        # The competition played only the FIRST question.
        play_competition(app, quiz_id, [question_id])

        response = client.patch(
            f"/api/quizzes/{quiz_id}/questions/{other_id}",
            json={"question_text": "Freely corrected", "question_type": "written", "options": []},
            headers=coach_headers,
        )
        assert response.status_code == 200

    def test_no_competition_at_all_leaves_editing_alone(
        self, client, coach_headers, quiz_with_question
    ):
        quiz_id, question_id = quiz_with_question
        assert reword(client, coach_headers, quiz_id, question_id).status_code == 200

    def test_retiring_is_still_allowed(
        self, app, client, coach_headers, quiz_with_question
    ):
        """The guard must not take away the very tool it points the coach at.
        Retiring stops the question being SENT again; it alters nothing about
        what the competition displayed."""
        quiz_id, question_id = quiz_with_question
        play_competition(app, quiz_id, [question_id])

        response = client.post(
            f"/api/quizzes/{quiz_id}/questions/{question_id}/retire", headers=coach_headers
        )
        assert response.status_code in (200, 204), response.get_json()
