"""Multi-Select M4 - SEEING WHAT WAS SELECTED, AFTERWARDS.

    A player ticked Mike, Nickel and Boundary Safety. Every historical
    surface says "Mike; Nickel; Boundary Safety". That is the whole
    feature.

WHY THIS PHASE EXISTED AT ALL
-----------------------------
M3 made a set answerable and gradable, and every surface that DISPLAYS an
answer resolved `answers.selected_option_id` - which is NULL on every
multi-select answer by construction. So a player who ticked three boxes, got
them right, and scored 100% opened their results page and read "No answer".
Measured, not feared: `test_the_bug_this_phase_fixed` below pins it.

ONE RESOLVER, FOUR SURFACES
---------------------------
`services/delivered_questions.selection_text` is the only thing that turns a
recorded set into words, and the player's results page, the coach's expanded
view, the CSV and the detailed PDF all call it. A coach and a player discussing
one answer are reading the same words in the same order, because there is only
one place that decides either.

DISPLAY ORDER IS THE QUESTION'S, NOT THE PLAYER'S
-------------------------------------------------
`answer_selected_options` stores no order - order is not a property of a set,
and exact-set grading must never depend on tap sequence. So display order has
to be chosen, and the only choice that means anything to a reader is the order
the options appeared in on screen. `TestDeliveredOrder` proves tap order cannot
change the output.
"""

import csv
import io
import json

import pytest

from app.extensions import db
from app.models import Answer, AttemptQuestionSnapshot, QuestionOption

PLAYER = "Jordan Smith"

#: In DELIVERED order. The fixture below hands them to the player in exactly
#: this sequence, which is what every display assertion here is measured
#: against.
OPTIONS = ["Mike", "Will", "Nickel", "Boundary Safety", "Free Safety", "Strong Safety"]
CORRECT = ["Mike", "Nickel", "Boundary Safety"]

#: Three options that are all WRONG. The PDF prints the answer key as well as
#: the player's picks, so a set drawn from the key would appear in the report
#: whether or not selections are rendered at all - which is how a "shows every
#: selection" assertion passes against code that shows none of them. Selecting
#: only wrong options is what makes those tests measure something.
WRONG_SET = ["Will", "Free Safety", "Strong Safety"]


def opt(text):
    return {"option_text": text, "is_correct_answer": text in CORRECT}


@pytest.fixture
def multi(client, coach_headers):
    """One "Select all that apply" question, one rostered player, activated."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Pressure"}, headers=coach_headers
    ).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Who is in the pressure?",
            "question_type": "multiple_choice",
            "allows_multiple_answers": True,
            "options": [opt(t) for t in OPTIONS],
        },
        headers=coach_headers,
    )
    assert question.status_code == 201, question.get_json()
    question = question.get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    )
    assert code.status_code == 201, code.get_json()
    return {
        "quiz_id": quiz["id"],
        "question": question,
        "code": code.get_json(),
        "ids": {o["option_text"]: o["id"] for o in question["options"]},
    }


@pytest.fixture
def single(client, coach_headers):
    """THE CONTROL. An ordinary multiple choice question, whose display must
    not move by a character."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Coverage"}, headers=coach_headers
    ).get_json()
    question = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Which coverage?",
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Cover 2", "is_correct_answer": True},
                {"option_text": "Cover 3", "is_correct_answer": False},
            ],
        },
        headers=coach_headers,
    ).get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    return {
        "quiz_id": quiz["id"],
        "question": question,
        "code": code,
        "ids": {o["option_text"]: o["id"] for o in question["options"]},
    }


def answer_and_submit(client, fixture, texts, *, tap_order=None):
    """Answer with `texts` and submit. `tap_order` overrides the order the ids
    are SENT in, which must never reach the display."""
    client.post(
        "/api/play/start",
        json={"access_code_id": fixture["code"]["id"], "player_name": PLAYER},
    )
    sending = tap_order if tap_order is not None else texts
    saved = client.post(
        "/api/play/answers",
        json={
            "access_code_id": fixture["code"]["id"],
            "player_name": PLAYER,
            "question_id": fixture["question"]["id"],
            "selected_option_id": None,
            "selected_option_ids": [fixture["ids"][t] for t in sending],
            "answer_text": None,
        },
    )
    assert saved.status_code == 204, saved.get_json()
    submitted = client.post(
        "/api/play/submit",
        json={
            "access_code_id": fixture["code"]["id"],
            "player_name": PLAYER,
            "answers": [
                {
                    "question_id": fixture["question"]["id"],
                    "selected_option_id": None,
                    "selected_option_ids": [fixture["ids"][t] for t in sending],
                    "answer_text": None,
                }
            ],
        },
    )
    assert submitted.status_code == 201, submitted.get_json()
    return submitted


def answer_single_and_submit(client, fixture, text):
    client.post(
        "/api/play/start",
        json={"access_code_id": fixture["code"]["id"], "player_name": PLAYER},
    )
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": fixture["code"]["id"],
            "player_name": PLAYER,
            "question_id": fixture["question"]["id"],
            "selected_option_id": fixture["ids"][text],
            "answer_text": None,
        },
    )
    submitted = client.post(
        "/api/play/submit",
        json={
            "access_code_id": fixture["code"]["id"],
            "player_name": PLAYER,
            "answers": [
                {
                    "question_id": fixture["question"]["id"],
                    "selected_option_id": fixture["ids"][text],
                    "answer_text": None,
                }
            ],
        },
    )
    assert submitted.status_code == 201, submitted.get_json()


def player_results(client, fixture):
    got = client.post(
        "/api/play/results",
        json={"code": fixture["code"]["code"], "player_name": PLAYER},
    )
    assert got.status_code == 200, got.get_json()
    return got.get_json()


def coach_responses(client, headers, fixture):
    got = client.get(
        f"/api/quizzes/{fixture['quiz_id']}/responses", headers=headers
    )
    assert got.status_code == 200, got.get_json()
    return got.get_json()


def csv_rows(client, headers, quiz_id):
    got = client.get(f"/api/quizzes/{quiz_id}/export.csv", headers=headers)
    assert got.status_code == 200
    return list(csv.reader(io.StringIO(got.get_data(as_text=True))))


def pdf_text(client, headers, quiz_id):
    from pypdf import PdfReader

    got = client.get(f"/api/quizzes/{quiz_id}/export-detailed.pdf", headers=headers)
    assert got.status_code == 200, got.get_data()
    reader = PdfReader(io.BytesIO(got.get_data()))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def rename_option(app, option_id, new_text):
    """A coach correcting the wording FOR FUTURE ATTEMPTS. Written straight to
    the live row: the point is that the snapshot is unaffected, and going
    through the editor would only add an unrelated correction-lock question."""
    with app.app_context():
        db.session.get(QuestionOption, option_id).option_text = new_text
        db.session.commit()


# ---------------------------------------------------------------------------
# The bug
# ---------------------------------------------------------------------------


class TestTheBugThisPhaseFixed:
    def test_a_correct_three_box_answer_no_longer_reads_as_no_answer(
        self, client, coach_headers, multi
    ):
        """MEASURED BEFORE THE FIX: this player scored 100% and their own
        results page said their answer was nothing at all, because
        `selected_option_id` is NULL on every multi-select answer."""
        answer_and_submit(client, multi, CORRECT)

        detail = player_results(client, multi)["answers"][0]

        assert detail["is_correct"] is True
        assert detail["your_answer"] == "Mike; Nickel; Boundary Safety"


# ---------------------------------------------------------------------------
# 1-2. Both results surfaces show the whole set
# ---------------------------------------------------------------------------


class TestPlayerResults:
    def test_every_selected_option_is_shown(self, client, multi):
        answer_and_submit(client, multi, ["Mike", "Nickel", "Boundary Safety"])

        assert (
            player_results(client, multi)["answers"][0]["your_answer"]
            == "Mike; Nickel; Boundary Safety"
        )

    def test_a_partial_set_shows_exactly_what_was_picked(self, client, multi):
        """Not the correct set, and not a summary - what this player chose."""
        answer_and_submit(client, multi, ["Will", "Free Safety"])

        detail = player_results(client, multi)["answers"][0]

        assert detail["your_answer"] == "Will; Free Safety"
        assert detail["is_correct"] is False

    def test_the_answer_key_is_the_WHOLE_correct_set(self, client, multi):
        """A set question has a set answer. Showing only the first correct
        option told a player who had ticked Mike AND Nickel that the correct
        answer was "Mike" - which reads as a grading mistake on the one page
        that exists to explain their grade."""
        answer_and_submit(client, multi, CORRECT)

        assert (
            player_results(client, multi)["answers"][0]["correct_answer"]
            == "Mike; Nickel; Boundary Safety"
        )


class TestCoachExpandedResults:
    def test_the_payload_carries_the_whole_set(self, client, coach_headers, multi):
        """The coach's expanded view resolves ids against the delivered
        options in the browser, so what the API owes it is the SET - the
        single column it used to read is NULL here."""
        answer_and_submit(client, multi, ["Mike", "Nickel", "Boundary Safety"])

        answer = coach_responses(client, coach_headers, multi)[0]["answers"][0]

        assert answer["selected_option_id"] is None
        assert set(answer["selected_option_ids"]) == {
            multi["ids"][t] for t in ["Mike", "Nickel", "Boundary Safety"]
        }

    def test_the_delivered_question_says_it_was_a_set(
        self, client, coach_headers, multi
    ):
        """Without this the browser cannot tell a set answer from a single
        choice, and would go back to reading the NULL column."""
        answer_and_submit(client, multi, CORRECT)

        delivered = coach_responses(client, coach_headers, multi)[0][
            "delivered_questions"
        ][0]

        assert delivered["allows_multiple_answers"] is True
        assert [o["option_text"] for o in delivered["options"]] == OPTIONS

    def test_a_single_choice_response_is_unchanged(
        self, client, coach_headers, single
    ):
        answer_single_and_submit(client, single, "Cover 2")

        answer = coach_responses(client, coach_headers, single)[0]["answers"][0]
        delivered = coach_responses(client, coach_headers, single)[0][
            "delivered_questions"
        ][0]

        assert answer["selected_option_id"] == single["ids"]["Cover 2"]
        assert delivered["allows_multiple_answers"] is False


# ---------------------------------------------------------------------------
# 3-4. Delivered wording, delivered order
# ---------------------------------------------------------------------------


class TestDeliveredOrder:
    @pytest.mark.parametrize(
        "tap_order",
        [
            ["Mike", "Nickel", "Boundary Safety"],
            ["Boundary Safety", "Mike", "Nickel"],
            ["Nickel", "Boundary Safety", "Mike"],
        ],
    )
    def test_tap_order_cannot_change_the_output(self, client, multi, tap_order):
        """THE PROPERTY THAT MAKES THE THREE SURFACES AGREE. Two players who
        ticked the same boxes in a different sequence must not have their
        answers printed differently."""
        answer_and_submit(client, multi, CORRECT, tap_order=tap_order)

        assert (
            player_results(client, multi)["answers"][0]["your_answer"]
            == "Mike; Nickel; Boundary Safety"
        )

    def test_the_order_is_the_QUESTIONS_not_the_id_order(self, client, multi):
        """Ids ascend in delivered order here, so a set spanning the list is
        what distinguishes "sorted by id" from "sorted by position" - the
        assertion below would pass either way. What it really pins is that the
        LAST option can precede nothing: Free Safety is fifth, so it prints
        last however it was tapped."""
        answer_and_submit(
            client, multi, ["Will", "Free Safety"], tap_order=["Free Safety", "Will"]
        )

        assert player_results(client, multi)["answers"][0]["your_answer"] == (
            "Will; Free Safety"
        )


class TestHistoricalWording:
    def test_a_later_rename_does_not_rewrite_a_delivered_answer(
        self, app, client, coach_headers, multi
    ):
        """THE REQUIREMENT THIS FEATURE INHERITS. Delivered A + C, selected
        A + C, coach renames both for future attempts - the record still reads
        as the player saw it, on every surface."""
        answer_and_submit(client, multi, ["Mike", "Nickel"])

        rename_option(app, multi["ids"]["Mike"], "MIKE LINEBACKER (edited)")
        rename_option(app, multi["ids"]["Nickel"], "NICKEL (edited)")

        assert (
            player_results(client, multi)["answers"][0]["your_answer"]
            == "Mike; Nickel"
        )
        row = csv_rows(client, coach_headers, multi["quiz_id"])[1]
        assert row[5] == "Mike; Nickel"
        assert "MIKE LINEBACKER (edited)" not in pdf_text(
            client, coach_headers, multi["quiz_id"]
        )

    def test_the_coachs_payload_carries_the_delivered_wording_too(
        self, app, client, coach_headers, multi
    ):
        answer_and_submit(client, multi, ["Mike", "Nickel"])
        rename_option(app, multi["ids"]["Mike"], "MIKE LINEBACKER (edited)")

        delivered = coach_responses(client, coach_headers, multi)[0][
            "delivered_questions"
        ][0]

        assert [o["option_text"] for o in delivered["options"]] == OPTIONS

    def test_the_snapshot_itself_is_never_rewritten(
        self, app, client, coach_headers, multi
    ):
        """Reading is not writing. Every surface above walks the snapshot; none
        of them may leave a mark on it."""
        answer_and_submit(client, multi, ["Mike", "Nickel"])
        with app.app_context():
            before = json.dumps(AttemptQuestionSnapshot.query.one().snapshot, sort_keys=True)

        player_results(client, multi)
        coach_responses(client, coach_headers, multi)
        csv_rows(client, coach_headers, multi["quiz_id"])
        pdf_text(client, coach_headers, multi["quiz_id"])

        with app.app_context():
            after = json.dumps(AttemptQuestionSnapshot.query.one().snapshot, sort_keys=True)
        assert after == before


# ---------------------------------------------------------------------------
# 5-6-8. Single choice, exclusion, and the empty set
# ---------------------------------------------------------------------------


class TestSingleChoiceIsUntouched:
    def test_the_player_page_still_reads_the_one_selection(self, client, single):
        answer_single_and_submit(client, single, "Cover 2")

        detail = player_results(client, single)["answers"][0]

        assert detail["your_answer"] == "Cover 2"
        assert detail["correct_answer"] == "Cover 2"

    def test_a_later_rename_still_shows_the_delivered_wording(
        self, app, client, single
    ):
        answer_single_and_submit(client, single, "Cover 2")
        rename_option(app, single["ids"]["Cover 2"], "Cover 2 (edited)")

        assert player_results(client, single)["answers"][0]["your_answer"] == "Cover 2"

    def test_the_csv_cell_is_the_one_option(self, client, coach_headers, single):
        answer_single_and_submit(client, single, "Cover 3")

        assert csv_rows(client, coach_headers, single["quiz_id"])[1][5] == "Cover 3"


class TestExcludedFromScoring:
    @pytest.fixture
    def excluded(self, client, coach_headers, multi):
        answer_and_submit(client, multi, CORRECT)
        # access_code_id null == quiz-wide, and the field is required-but-
        # nullable on purpose: see ExclusionCreateSchema.
        made = client.post(
            f"/api/quizzes/{multi['quiz_id']}/questions/"
            f"{multi['question']['id']}/exclusions",
            json={"access_code_id": None},
            headers=coach_headers,
        )
        assert made.status_code == 201, made.get_json()
        return multi

    def test_the_player_still_sees_every_selection(self, client, excluded):
        """EVIDENCE IS NOT HIDDEN. Only the verdict goes neutral."""
        detail = player_results(client, excluded)["answers"][0]

        assert detail["your_answer"] == "Mike; Nickel; Boundary Safety"
        assert detail["is_excluded"] is True
        assert detail["is_correct"] is None

    def test_the_csv_keeps_the_answer_and_changes_only_the_verdict(
        self, client, coach_headers, excluded
    ):
        row = csv_rows(client, coach_headers, excluded["quiz_id"])[1]

        assert row[5] == "Mike; Nickel; Boundary Safety"
        assert row[6] == "Excluded"


class TestTheEmptySet:
    """A player who ticked boxes and then unticked them all.

    THE ANSWER ROW EXISTS AND IS EMPTY, which is the case worth testing: "no
    row at all" was already unanswered before multi-select existed, whereas
    this shape is new and is the one a display could get wrong - by printing an
    empty-looking set, or by inventing a marker for it.
    """

    @pytest.fixture
    def emptied(self, app, client, multi):
        answer_and_submit(client, multi, ["Mike"], tap_order=[])
        # The precondition. Without this assertion the tests below would pass
        # just as happily against no answer row at all, proving nothing.
        with app.app_context():
            answer = Answer.query.one()
            assert answer.selected_option_id is None
            assert answer.selected_options == []
        return multi

    def test_the_player_sees_no_answer_rather_than_an_empty_set(
        self, client, emptied
    ):
        detail = player_results(client, emptied)["answers"][0]

        assert detail["your_answer"] is None
        assert detail["is_correct"] is None, "not graded 0 for never answering"

    def test_the_csv_uses_ITS_EXISTING_semantics_and_invents_nothing(
        self, client, coach_headers, emptied
    ):
        """An empty cell, and the verdict column carrying the meaning.

        "Ungraded" rather than "Unanswered" is the EXISTING, TYPE-AGNOSTIC
        rule and not something multi-select introduced: `scoring.classify`
        reads UNANSWERED as "no answer row" and NOT_GRADED as "a row with no
        verdict", and a cleared single-choice answer lands in exactly the same
        bucket. Either way the answer is outside the scored denominator, so no
        0% is fabricated - which is the property that actually matters here.
        """
        row = csv_rows(client, coach_headers, emptied["quiz_id"])[1]

        assert row[5] == ""
        assert row[6] == "Ungraded"


# ---------------------------------------------------------------------------
# 9-13. The exports
# ---------------------------------------------------------------------------


class TestCsv:
    def test_the_cell_joins_the_set_with_a_semicolon(
        self, client, coach_headers, multi
    ):
        answer_and_submit(client, multi, CORRECT)

        assert (
            csv_rows(client, coach_headers, multi["quiz_id"])[1][5]
            == "Mike; Nickel; Boundary Safety"
        )

    def test_the_cell_survives_the_round_trip_as_ONE_field(
        self, client, coach_headers, multi
    ):
        """Semicolon, not comma, precisely so a set never splits a row. Read
        back through a real CSV parser rather than eyeballed."""
        answer_and_submit(client, multi, CORRECT)

        row = csv_rows(client, coach_headers, multi["quiz_id"])[1]

        assert len(row) == len(csv_rows(client, coach_headers, multi["quiz_id"])[0])
        assert row[5].count(";") == 2

    def test_tap_order_does_not_reach_the_spreadsheet(
        self, client, coach_headers, multi
    ):
        answer_and_submit(
            client,
            multi,
            CORRECT,
            tap_order=["Boundary Safety", "Nickel", "Mike"],
        )

        assert (
            csv_rows(client, coach_headers, multi["quiz_id"])[1][5]
            == "Mike; Nickel; Boundary Safety"
        )


class TestDetailedPdf:
    def test_every_selection_is_printed(self, client, coach_headers, multi):
        """A SET OF WRONG ANSWERS, deliberately. The card also prints the key,
        so selecting the correct options would put those words on the page
        whether or not the player's picks are rendered at all - which is
        exactly how this assertion passed against code that showed none of
        them. Only a wrong pick can prove the selection reached the page."""
        answer_and_submit(client, multi, WRONG_SET)

        text = pdf_text(client, coach_headers, multi["quiz_id"])

        assert "PLAYER ANSWER" in text
        for chosen in WRONG_SET:
            assert chosen in text, f"{chosen} was selected and is not on the page"

    def test_an_unchosen_option_is_not_printed_as_an_answer(
        self, client, coach_headers, multi
    ):
        """The other half: a card that simply listed every option would satisfy
        the test above and be useless."""
        answer_and_submit(client, multi, ["Will"])

        text = pdf_text(client, coach_headers, multi["quiz_id"])

        assert "Free Safety" not in text
        assert "Strong Safety" not in text

    def test_it_prints_the_delivered_wording(self, app, client, coach_headers, multi):
        """Renaming a WRONG option, so the key cannot supply the old wording."""
        answer_and_submit(client, multi, ["Will", "Free Safety"])
        rename_option(app, multi["ids"]["Will"], "WILL LINEBACKER (edited)")

        text = pdf_text(client, coach_headers, multi["quiz_id"])

        assert "Will" in text
        assert "(edited)" not in text

    def test_the_correct_answer_block_lists_the_whole_key(
        self, client, coach_headers, multi
    ):
        """Printing only the first correct option would leave Nickel and
        Boundary Safety off the page entirely."""
        answer_and_submit(client, multi, ["Will"])

        text = pdf_text(client, coach_headers, multi["quiz_id"])

        assert "CORRECT ANSWER" in text
        for correct in CORRECT:
            assert correct in text

    def test_a_single_choice_pdf_is_unchanged(self, client, coach_headers, single):
        """Answering INCORRECTLY, so the player's answer and the key are
        different strings and each has to be printed on its own account."""
        answer_single_and_submit(client, single, "Cover 3")

        text = pdf_text(client, coach_headers, single["quiz_id"])

        assert "PLAYER ANSWER" in text
        assert "Cover 3" in text, "the player's choice"
        assert "Cover 2" in text, "the key"


# ---------------------------------------------------------------------------
# 14. Leakage
# ---------------------------------------------------------------------------


class TestNoAnswerKeyLeaks:
    def test_the_player_payload_carries_no_per_option_correctness(
        self, client, multi
    ):
        """The correct answer as a WHOLE is shown - it always has been, after
        submission. What must never appear is which of the PLAYER'S individual
        ticks were right, or the raw key structure that lets them be derived
        one checkbox at a time."""
        answer_and_submit(client, multi, ["Mike", "Will"])

        blob = json.dumps(player_results(client, multi))

        assert "is_correct_answer" not in blob
        assert "expected_answers" not in blob
        assert "answer_matching" not in blob
        assert "correct_option_ids" not in blob
        assert "selected_option_ids" not in blob

    def test_mid_quiz_delivery_still_carries_no_key(self, client, multi):
        """The dangerous moment: before submission. /play/start hands the
        player their delivered questions, and the set format must not have
        widened what rides along with them."""
        started = client.post(
            "/api/play/start",
            json={"access_code_id": multi["code"]["id"], "player_name": PLAYER},
        )

        blob = json.dumps(started.get_json())

        assert "is_correct_answer" not in blob
        assert "expected_answers" not in blob
        assert '"allows_multiple_answers": true' in blob.replace(", ", ", ")


# ---------------------------------------------------------------------------
# 18-19. Nothing else moved
# ---------------------------------------------------------------------------


class TestPractice:
    """M3's practice behaviour is untouched; only the display grew.

    Practice is where a player is told a verdict DURING the quiz, so it is the
    surface where per-option feedback would be most tempting and most harmful -
    tick A, check, tick B, check, and the answer key falls out one checkbox at
    a time. M4 shows the set AFTERWARDS and reveals nothing new about it.
    """

    @pytest.fixture
    def practice(self, client, coach_headers):
        from app.models.assessment_mode import PRACTICE

        quiz = client.post(
            "/api/quizzes", json={"title": "Pressure practice"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who is in the pressure?",
                "question_type": "multiple_choice",
                "allows_multiple_answers": True,
                "answer_explanation": "The Mike and the Nickel both come.",
                "options": [opt(t) for t in OPTIONS],
            },
            headers=coach_headers,
        ).get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": PRACTICE},
            headers=coach_headers,
        )
        assert code.status_code == 201, code.get_json()
        return {
            "quiz_id": quiz["id"],
            "question": question,
            "code": code.get_json(),
            "ids": {o["option_text"]: o["id"] for o in question["options"]},
        }

    def test_checking_an_answer_still_reveals_only_ONE_verdict(
        self, client, practice
    ):
        """Unchanged from M3, re-pinned here because M4 touched the surfaces
        either side of it."""
        client.post(
            "/api/play/start",
            json={"access_code_id": practice["code"]["id"], "player_name": PLAYER},
        )
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": practice["code"]["id"],
                "player_name": PLAYER,
                "question_id": practice["question"]["id"],
                "selected_option_id": None,
                "selected_option_ids": [practice["ids"]["Mike"]],
                "answer_text": None,
            },
        )
        checked = client.post(
            "/api/play/check",
            json={
                "access_code_id": practice["code"]["id"],
                "player_name": PLAYER,
                "question_id": practice["question"]["id"],
            },
        )

        body = checked.get_json()
        assert body["is_correct"] is False
        assert "selected_option_ids" not in json.dumps(body)

    def test_practice_results_show_the_whole_set(self, client, practice):
        answer_and_submit(client, practice, ["Mike", "Nickel"])

        assert (
            player_results(client, practice)["answers"][0]["your_answer"]
            == "Mike; Nickel"
        )


class TestScoringIsUnchanged:
    def test_the_stored_verdict_is_the_one_M3_recorded(self, app, client, multi):
        """M4 is a display phase. It must not regrade, and it must not write."""
        answer_and_submit(client, multi, CORRECT)
        with app.app_context():
            before = Answer.query.one().is_correct

        player_results(client, multi)

        with app.app_context():
            assert Answer.query.one().is_correct is before is True

    def test_a_wrong_set_still_scores_zero_percent(
        self, client, coach_headers, multi
    ):
        answer_and_submit(client, multi, ["Mike"])

        dashboard = client.get(
            f"/api/quizzes/{multi['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        row = dashboard["question_breakdown"][0]

        assert (row["correct_count"], row["incorrect_count"]) == (0, 1)


class TestTheBreakdownGainedNothing:
    def test_it_still_reports_counts_and_no_set_specific_field(
        self, client, coach_headers, multi
    ):
        """DELIBERATELY NOT EXTENDED. "Most common combination" is an
        analytics question, not a display one, and v1 answers it by letting a
        coach open the player's row. The breakdown carries no per-option
        distribution to become misleading for a set, which is why nothing here
        needed a fallback."""
        answer_and_submit(client, multi, CORRECT)

        row = client.get(
            f"/api/quizzes/{multi['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()["question_breakdown"][0]

        assert row["answered_count"] == 1
        assert row["correct_count"] == 1
        assert set(row) == {
            "question_id",
            "question_number",
            "question_text",
            "question_type",
            "answered_count",
            "correct_count",
            "incorrect_count",
            "ungraded_count",
            "is_excluded",
            "exclusions",
        }
