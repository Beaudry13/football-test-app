"""The answer key export (GET /api/quizzes/answer-key.pdf).

THE TEST ITSELF, NOT HOW ANYBODY DID ON IT. A coach wants one PDF of the
quizzes they wrote and the correct answers, to review and to mark from. So the
two rules worth defending are:

  * NO PLAYER DATA, ever. The route loads quizzes and never touches attempts,
    so there is nothing in scope to leak - and the tests below read the actual
    rendered text back out of the PDF rather than trusting that.

  * ONLY WHAT A PLAYER IS STILL MEANT TO LEARN. The key doubles as a study
    guide, so a question marked "don't count" AND a question a coach has
    stopped sending are both omitted entirely - never labelled, because a
    label restates a decision already made and invites teaching from it
    anyway. What remains is renumbered 1..n so the guide reads naturally.
"""

import io

from pypdf import PdfReader

from app.extensions import db
from app.models import Question, QuestionOption
from app.models.question_exclusion import QuestionExclusion


def pdf_text(pdf_bytes: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join(page.extract_text() for page in reader.pages)


def make_quiz(client, headers, title, questions):
    """A quiz with multiple-choice questions, through the real API."""
    quiz_id = client.post("/api/quizzes", json={"title": title}, headers=headers).get_json()["id"]
    ids = []
    for text, choices, correct_index in questions:
        response = client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": text,
                "question_type": "multiple_choice",
                "options": [
                    {"option_text": choice, "is_correct_answer": i == correct_index}
                    for i, choice in enumerate(choices)
                ],
            },
            headers=headers,
        )
        assert response.status_code == 201, response.get_json()
        ids.append(response.get_json()["id"])
    return quiz_id, ids


def exclude(app, question_id):
    """Mark a question "don't count", quiz-wide."""
    with app.app_context():
        db.session.add(
            QuestionExclusion(question_id=question_id, access_code_id=None)
        )
        db.session.commit()


def retire(client, headers, quiz_id, question_id):
    """Stop sending a question, through the real coach endpoint."""
    response = client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/retire", headers=headers
    )
    assert response.status_code in (200, 201), response.get_json()


def fetch(client, headers, ids):
    return client.get(
        "/api/quizzes/answer-key.pdf?ids=" + ",".join(str(i) for i in ids), headers=headers
    )


class TestTheKeyShowsTheTest:
    def test_it_returns_a_pdf(self, client, coach_headers):
        quiz_id, _ = make_quiz(
            client, coach_headers, "Cover 3 Test", [("What coverage?", ["Cover 2", "Cover 3"], 1)]
        )
        response = fetch(client, coach_headers, [quiz_id])
        assert response.status_code == 200
        assert response.mimetype == "application/pdf"
        assert response.data[:4] == b"%PDF"
        assert "answer-key" in response.headers["Content-Disposition"]

    def test_it_shows_the_quiz_title_and_every_question(self, client, coach_headers):
        quiz_id, _ = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("What coverage is this?", ["Cover 2", "Cover 3", "Quarters"], 1),
                ("Who has the flat?", ["Corner", "Sam", "Free safety"], 1),
            ],
        )
        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)

        assert "Cover 3 Test" in text
        assert "What coverage is this?" in text
        assert "Who has the flat?" in text

    def test_it_shows_every_choice_and_marks_the_correct_one(self, client, coach_headers):
        quiz_id, _ = make_quiz(
            client, coach_headers, "Cover 3 Test", [("What coverage?", ["Cover 2", "Cover 3", "Quarters"], 1)]
        )
        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)

        for choice in ("Cover 2", "Cover 3", "Quarters"):
            assert choice in text
        # The tick sits with the right answer, and only with it.
        marked = [line for line in text.splitlines() if "✓" in line]
        assert any("Cover 3" in line for line in marked), text
        assert not any("Quarters" in line for line in marked)

    def test_the_key_is_headed_as_an_answer_key(self, client, coach_headers):
        quiz_id, _ = make_quiz(client, coach_headers, "Cover 3 Test", [("Q", ["a", "b"], 0)])
        assert "ANSWER KEY" in pdf_text(fetch(client, coach_headers, [quiz_id]).data)


class TestExcludedQuestionsAreGone:
    def test_an_excluded_question_does_not_appear_at_all(self, app, client, coach_headers):
        quiz_id, ids = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("Keep this one", ["a", "b"], 0),
                ("DO NOT COUNT THIS", ["wrong-c", "wrong-d"], 0),
                ("Keep this too", ["e", "f"], 1),
            ],
        )
        exclude(app, ids[1])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)

        assert "Keep this one" in text
        assert "Keep this too" in text
        # Neither the question nor its choices survive anywhere.
        assert "DO NOT COUNT THIS" not in text
        assert "wrong-c" not in text
        assert "wrong-d" not in text

    def test_it_is_omitted_rather_than_labelled(self, app, client, coach_headers):
        # Printing it greyed out would restate a decision the coach has made.
        quiz_id, ids = make_quiz(
            client, coach_headers, "Cover 3 Test", [("Keep", ["a", "b"], 0), ("Drop", ["c", "d"], 0)]
        )
        exclude(app, ids[1])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        assert "Excluded" not in text
        assert "excluded" not in text
        assert "Do not count" not in text

    def test_what_remains_is_renumbered_from_one(self, app, client, coach_headers):
        """The numbering follows what is PRINTED, not the positions of
        questions that are not."""
        quiz_id, ids = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("Alpha question", ["a", "b"], 0),
                ("Bravo question", ["c", "d"], 0),
                ("Charlie question", ["e", "f"], 0),
            ],
        )
        exclude(app, ids[0])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        # Bravo is now question 1 and Charlie question 2 - no gap where Alpha was.
        assert "1. Bravo question" in text.replace("\n", " ")
        assert "2. Charlie question" in text.replace("\n", " ")
        assert "3." not in text

    def test_a_quiz_whose_questions_are_all_excluded_still_renders(
        self, app, client, coach_headers
    ):
        quiz_id, ids = make_quiz(client, coach_headers, "All Gone", [("Only one", ["a", "b"], 0)])
        exclude(app, ids[0])

        response = fetch(client, coach_headers, [quiz_id])
        assert response.status_code == 200
        text = pdf_text(response.data)
        assert "ALL GONE" in text.upper()
        assert "Only one" not in text

    def test_an_exclusion_scoped_to_one_access_code_does_not_hide_it(
        self, app, client, coach_headers
    ):
        """A narrower decision must not be read as a wider one.

        An exclusion attached to a single assignment belongs to that
        assignment; the question is still part of the test.
        """
        quiz_id, ids = make_quiz(client, coach_headers, "Scoped", [("Still on the test", ["a", "b"], 0)])
        client.put(f"/api/quizzes/{quiz_id}/roster", json={"players": ["Casey"]}, headers=coach_headers)
        code = client.post(
            f"/api/quizzes/{quiz_id}/access-codes", json={}, headers=coach_headers
        ).get_json()
        with app.app_context():
            db.session.add(
                QuestionExclusion(question_id=ids[0], access_code_id=code["id"])
            )
            db.session.commit()

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        assert "Still on the test" in text


class TestNoPlayerDataAnywhere:
    def test_the_key_carries_no_names_scores_or_percentages(self, app, client, coach_headers):
        """The strongest rule here, checked against the RENDERED TEXT.

        The route takes quizzes rather than responses, so there is nothing in
        scope to leak - this reads the PDF back to prove it.
        """
        from tests.test_play_and_grading import build_ready_quiz, start_and_submit

        quiz, _tf, _written, access_code = build_ready_quiz(client, coach_headers)
        # A real submitted attempt exists for this quiz - so if the key could
        # reach player data at all, this is where it would show up.
        start_and_submit(client, access_code["id"], "Jordan Smith", [])

        text = pdf_text(fetch(client, coach_headers, [quiz["id"]]).data)

        assert "Jordan Smith" not in text
        assert "Alex Lee" not in text
        assert "%" not in text
        for word in ("Score", "Responses", "Roster", "Player", "Submitted", "Ungraded"):
            assert word not in text, f"{word} is results data and must not be here"


class TestOtherQuestionTypes:
    def test_a_fill_blank_shows_every_accepted_answer(self, client, coach_headers):
        # A coach marking by hand needs to know which spellings were set to pass.
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Fill"}, headers=coach_headers
        ).get_json()["id"]
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Name the coverage",
                "question_type": "fill_blank",
                "options": [],
                "expected_answers": ["Cover 3 Buzz", "Cover 3"],
            },
            headers=coach_headers,
        )
        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        assert "Cover 3 Buzz" in text
        assert "Accepted answers" in text

    def test_a_written_question_says_it_is_graded_by_hand(self, client, coach_headers):
        # Said plainly rather than left blank, so a coach can see the gap.
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Written"}, headers=coach_headers
        ).get_json()["id"]
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Explain your fit",
                "question_type": "written",
                "options": [],
            },
            headers=coach_headers,
        )
        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        assert "graded by hand" in text.lower()

    def test_an_explanation_is_shown_when_the_coach_wrote_one(self, client, coach_headers):
        quiz_id = client.post(
            "/api/quizzes", json={"title": "Explained"}, headers=coach_headers
        ).get_json()["id"]
        client.post(
            f"/api/quizzes/{quiz_id}/questions",
            json={
                "question_text": "Explain your fit",
                "question_type": "written",
                "options": [],
                "answer_explanation": "Spill the ball to the free hitter.",
            },
            headers=coach_headers,
        )
        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        # It is the MODEL ANSWER here, not a footnote: there is nothing else on
        # this question to mark against, so it must not be printed under a line
        # saying no model answer was set.
        assert "Spill the ball to the free hitter." in text
        assert "Model answer" in text
        assert "No model answer set" not in text


class TestSeveralQuizzesInOneDocument:
    def test_every_requested_quiz_appears(self, client, coach_headers):
        first, _ = make_quiz(client, coach_headers, "Cover 3 Test", [("Q one", ["a", "b"], 0)])
        second, _ = make_quiz(client, coach_headers, "Red Zone Test", [("Q two", ["c", "d"], 1)])

        text = pdf_text(fetch(client, coach_headers, [first, second]).data)
        assert "COVER 3 TEST" in text.upper()
        assert "RED ZONE TEST" in text.upper()
        assert "Q one" in text
        assert "Q two" in text

    def test_each_quiz_starts_its_own_page(self, client, coach_headers):
        first, _ = make_quiz(client, coach_headers, "Cover 3 Test", [("Q one", ["a", "b"], 0)])
        second, _ = make_quiz(client, coach_headers, "Red Zone Test", [("Q two", ["c", "d"], 1)])

        reader = PdfReader(io.BytesIO(fetch(client, coach_headers, [first, second]).data))
        assert len(reader.pages) >= 2
        # The second quiz is not on the first page.
        assert "RED ZONE TEST" not in reader.pages[0].extract_text().upper()

    def test_each_quiz_numbers_its_own_questions_from_one(self, client, coach_headers):
        first, _ = make_quiz(client, coach_headers, "First", [("Alpha", ["a", "b"], 0)])
        second, _ = make_quiz(client, coach_headers, "Second", [("Bravo", ["c", "d"], 0)])

        flat = pdf_text(fetch(client, coach_headers, [first, second]).data).replace("\n", " ")
        assert "1. Alpha" in flat
        assert "1. Bravo" in flat

    def test_the_requested_order_is_kept_and_duplicates_collapse(self, client, coach_headers):
        first, _ = make_quiz(client, coach_headers, "First", [("Alpha", ["a", "b"], 0)])
        second, _ = make_quiz(client, coach_headers, "Second", [("Bravo", ["c", "d"], 0)])

        reader = PdfReader(io.BytesIO(fetch(client, coach_headers, [second, first, second]).data))
        assert len(reader.pages) == 2, "a repeated id must not print the quiz twice"
        assert "SECOND" in reader.pages[0].extract_text().upper()


class TestTheRequestItself:
    def test_no_ids_is_refused(self, client, coach_headers):
        assert client.get("/api/quizzes/answer-key.pdf", headers=coach_headers).status_code == 400
        assert (
            client.get("/api/quizzes/answer-key.pdf?ids=", headers=coach_headers).status_code == 400
        )

    def test_nonsense_ids_are_refused(self, client, coach_headers):
        assert (
            client.get("/api/quizzes/answer-key.pdf?ids=abc", headers=coach_headers).status_code
            == 400
        )

    def test_too_many_is_refused(self, client, coach_headers):
        ids = ",".join(str(i) for i in range(1, 60))
        assert (
            client.get(f"/api/quizzes/answer-key.pdf?ids={ids}", headers=coach_headers).status_code
            == 400
        )

    def test_it_needs_a_coach(self, client, coach_headers):
        quiz_id, _ = make_quiz(client, coach_headers, "Private", [("Q", ["a", "b"], 0)])
        assert client.get(f"/api/quizzes/answer-key.pdf?ids={quiz_id}").status_code == 401

    def test_another_organization_cannot_export_it(self, client, coach_headers):
        """A cumulative export must never become a way to read a quiz the
        caller could not open one at a time."""
        from tests.conftest import register_via_invite

        quiz_id, _ = make_quiz(client, coach_headers, "Private", [("Q", ["a", "b"], 0)])
        other = register_via_invite(
            client, username="rival", email="rival@example.com", organization="Rivals"
        )
        token = other.get_json()["access_token"]
        response = client.get(
            f"/api/quizzes/answer-key.pdf?ids={quiz_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 404

    def test_one_forbidden_id_refuses_the_whole_export(self, client, coach_headers):
        """Silently dropping it would hand back a key that is missing a test
        the coach asked for, without saying so."""
        from tests.conftest import register_via_invite

        mine, _ = make_quiz(client, coach_headers, "Mine", [("Q", ["a", "b"], 0)])
        other = register_via_invite(
            client, username="rival2", email="rival2@example.com", organization="Rivals2"
        )
        token = other.get_json()["access_token"]
        theirs = client.post(
            "/api/quizzes", json={"title": "Theirs"}, headers={"Authorization": f"Bearer {token}"}
        ).get_json()["id"]

        response = client.get(
            f"/api/quizzes/answer-key.pdf?ids={mine},{theirs}", headers=coach_headers
        )
        assert response.status_code == 404


class TestItChangesNothing:
    def test_exporting_does_not_touch_the_quiz(self, app, client, coach_headers):
        quiz_id, ids = make_quiz(client, coach_headers, "Cover 3 Test", [("Q", ["a", "b"], 0)])

        with app.app_context():
            before = [
                (q.id, q.question_text, q.position)
                for q in db.session.query(Question).filter_by(quiz_id=quiz_id).all()
            ]
            options_before = db.session.query(QuestionOption).count()

        fetch(client, coach_headers, [quiz_id])

        with app.app_context():
            after = [
                (q.id, q.question_text, q.position)
                for q in db.session.query(Question).filter_by(quiz_id=quiz_id).all()
            ]
            assert after == before
            assert db.session.query(QuestionOption).count() == options_before


class TestRetiredQuestionsAreGone:
    """A question a coach has stopped sending is not something to study.

    The key doubles as a study guide, so it must not put a question in front of
    players that no future attempt will ever ask them.
    """

    def test_a_retired_question_does_not_appear_at_all(self, client, coach_headers):
        quiz_id, ids = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("Keep this one", ["a", "b"], 0),
                ("STOPPED SENDING THIS", ["gone-c", "gone-d"], 0),
                ("Keep this too", ["e", "f"], 1),
            ],
        )
        retire(client, coach_headers, quiz_id, ids[1])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)

        assert "Keep this one" in text
        assert "Keep this too" in text
        assert "STOPPED SENDING THIS" not in text
        assert "gone-c" not in text
        assert "gone-d" not in text

    def test_it_is_omitted_rather_than_labelled(self, client, coach_headers):
        quiz_id, ids = make_quiz(
            client, coach_headers, "Cover 3 Test", [("Keep", ["a", "b"], 0), ("Drop", ["c", "d"], 0)]
        )
        retire(client, coach_headers, quiz_id, ids[1])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        for word in ("Retired", "retired", "Stopped", "Stop sending", "No longer"):
            assert word not in text

    def test_what_remains_is_renumbered_from_one(self, client, coach_headers):
        quiz_id, ids = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("Alpha question", ["a", "b"], 0),
                ("Bravo question", ["c", "d"], 0),
                ("Charlie question", ["e", "f"], 0),
            ],
        )
        retire(client, coach_headers, quiz_id, ids[0])

        flat = pdf_text(fetch(client, coach_headers, [quiz_id]).data).replace(chr(10), " ")
        assert "1. Bravo question" in flat
        assert "2. Charlie question" in flat
        assert "3." not in flat

    def test_retired_and_excluded_are_both_removed_together(self, app, client, coach_headers):
        """The two rules compose - neither cancels the other, and the survivors
        are numbered as though the removed ones were never there."""
        quiz_id, ids = make_quiz(
            client,
            coach_headers,
            "Cover 3 Test",
            [
                ("Retired one", ["a", "b"], 0),
                ("Excluded one", ["c", "d"], 0),
                ("The only survivor", ["e", "f"], 1),
            ],
        )
        retire(client, coach_headers, quiz_id, ids[0])
        exclude(app, ids[1])

        text = pdf_text(fetch(client, coach_headers, [quiz_id]).data)
        assert "Retired one" not in text
        assert "Excluded one" not in text
        assert "The only survivor" in text
        assert "1. The only survivor" in text.replace(chr(10), " ")

    def test_restoring_a_question_brings_it_back(self, client, coach_headers):
        """Retirement is reversible, and the key follows the live decision."""
        quiz_id, ids = make_quiz(
            client, coach_headers, "Cover 3 Test", [("Comes back", ["a", "b"], 0)]
        )
        retire(client, coach_headers, quiz_id, ids[0])
        assert "Comes back" not in pdf_text(fetch(client, coach_headers, [quiz_id]).data)

        client.delete(
            f"/api/quizzes/{quiz_id}/questions/{ids[0]}/retire", headers=coach_headers
        )
        assert "Comes back" in pdf_text(fetch(client, coach_headers, [quiz_id]).data)

    def test_a_quiz_whose_questions_are_all_retired_still_renders(self, client, coach_headers):
        quiz_id, ids = make_quiz(client, coach_headers, "All Stopped", [("Only one", ["a", "b"], 0)])
        retire(client, coach_headers, quiz_id, ids[0])

        response = fetch(client, coach_headers, [quiz_id])
        assert response.status_code == 200
        text = pdf_text(response.data)
        assert "ALL STOPPED" in text.upper()
        assert "Only one" not in text
