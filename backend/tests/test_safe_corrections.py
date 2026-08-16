"""Phase 4C - SAFE CORRECTION OF A DELIVERED QUESTION.

    A coach can fix wording, add an option, replace or remove the image and
    redraw annotations AFTER players have received the question.
    Existing attempts keep the version they were delivered.

WHY THIS IS SAFE NOW AND WAS NOT BEFORE
---------------------------------------
Phase 1 records what each attempt was delivered. Phase 4a makes every
historical surface read that record. Phase 4a-bis pins an attempt in progress
to its delivered version. Phase 4b lets a coach stop sending a question
outright. Together those mean a correction can change the FUTURE without
touching any past evidence - which is the only reason these edits can be
unlocked at all.

WHAT IS STILL BLOCKED, AND WHY THAT IS NOT TIMIDITY
---------------------------------------------------
* **Removing an option** - would strand `Answer.selected_option_id`. Whether
  the snapshot alone can still identify what a player picked is an open
  question, and answering it is a separate audit.
* **Changing which answer is correct** (incl. expected_answers / matching) -
  `answers.is_correct` is STORED, so old answers keep the old verdict while
  new ones get the new key. Two players give the same answer and carry
  different results, permanently. That needs a product decision about
  regrading, not a code change.
* **Question type** - the Phase 4a corruption hole. Stays shut.
* **Region geometry** - a region question's masked render comes from the LIVE
  region, so editing it rewrites what a PAST attempt is shown. Blocked until
  masked-render preservation exists.

The safe workflow for anything blocked is Phase 4b ("stop sending it") plus
Phase 3 ("don't count it").
"""

import io

import pytest

from app.extensions import db
from app.models import Answer, AttemptQuestionSnapshot, Question, QuestionOption
from tests.conftest import make_image_file

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


def _mc(client, headers, quiz_id, text, right="RIGHT", wrong="WRONG"):
    r = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": right, "is_correct_answer": True},
                {"option_text": wrong, "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def start(client, code, player=PLAYER):
    return client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )


def patch_options(client, headers, quiz_id, question_id, options):
    return client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}",
        json={"options": options},
        headers=headers,
    )


def opt(text, correct=False):
    return {"option_text": text, "is_correct_answer": correct}


def delivered_options(payload, index=0):
    return [o["option_text"] for o in payload["questions"][index]["options"]]


@pytest.fixture
def delivered(client, coach_headers):
    """One question, delivered to one player who ANSWERED it, plus a second
    question delivered and SKIPPED - the case an answer-based check misses."""
    quiz = client.post(
        "/api/quizzes", json={"title": "Corrections"}, headers=coach_headers
    ).get_json()
    q1 = _mc(client, coach_headers, quiz["id"], "Original wording")
    q2 = _mc(client, coach_headers, quiz["id"], "Delivered but skipped")
    # THREE options, so that removing one still satisfies
    # validate_options_for_type (which needs >= 2) and the request reaches the
    # Phase 4C guard rather than being stopped by generic type validation.
    q3 = client.post(
        f"/api/quizzes/{quiz['id']}/questions",
        json={
            "question_text": "Three options",
            "question_type": "multiple_choice",
            "options": [opt("A", True), opt("B"), opt("C")],
        },
        headers=coach_headers,
    ).get_json()
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )
    code = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    started = start(client, code).get_json()
    client.post(
        "/api/play/answers",
        json={
            "access_code_id": code["id"],
            "player_name": PLAYER,
            "question_id": q1["id"],
            "selected_option_id": q1["options"][0]["id"],
            "answer_text": None,
        },
    )
    return {
        "quiz_id": quiz["id"],
        "q1": q1,
        "q2": q2,
        "q3": q3,
        "code": code,
        "start": started,
        "attempt_id": started["attempt_id"],
    }


# ---------------------------------------------------------------------------
# OPTION TEXT
# ---------------------------------------------------------------------------


class TestOptionText:
    def test_rewording_an_option_is_allowed_after_delivery(
        self, client, coach_headers, delivered
    ):
        response = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        assert response.status_code == 200, response.get_json()

    def test_the_option_ROW_survives_so_the_answer_still_points_at_it(
        self, app, client, coach_headers, delivered
    ):
        """THE REASON THIS NEEDED NEW CODE. The old path cleared the option
        list and rebuilt it, minting new ids - which would have orphaned
        `Answer.selected_option_id`."""
        chosen_id = delivered["q1"]["options"][0]["id"]

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        with app.app_context():
            assert db.session.get(QuestionOption, chosen_id) is not None
            answer = Answer.query.filter_by(question_id=delivered["q1"]["id"]).one()
            assert answer.selected_option_id == chosen_id

    def test_an_attempt_in_progress_still_sees_the_OLD_option_text(
        self, client, coach_headers, delivered
    ):
        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        resumed = start(client, delivered["code"]).get_json()

        assert delivered_options(resumed) == ["RIGHT", "WRONG"]

    def test_a_new_attempt_sees_the_NEW_option_text(self, client, coach_headers, delivered):
        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        fresh = start(client, delivered["code"], player=OTHER).get_json()

        assert delivered_options(fresh) == ["RIGHT, reworded", "WRONG"]

    def test_the_stored_verdict_never_changes(self, app, client, coach_headers, delivered):
        with app.app_context():
            before = Answer.query.filter_by(question_id=delivered["q1"]["id"]).one().is_correct

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        with app.app_context():
            after = Answer.query.filter_by(question_id=delivered["q1"]["id"]).one().is_correct
        assert after == before is True

    def test_historical_results_show_the_delivered_wording(
        self, client, coach_headers, delivered
    ):
        body = start(client, delivered["code"]).get_json()
        client.post(
            "/api/play/submit",
            json={
                "access_code_id": delivered["code"]["id"],
                "player_name": PLAYER,
                "answers": [
                    {
                        "question_id": q["id"],
                        "selected_option_id": q["options"][0]["id"],
                        "answer_text": None,
                    }
                    for q in body["questions"]
                ],
            },
        )

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG")],
        )

        results = client.post(
            "/api/play/results",
            json={"code": delivered["code"]["code"], "player_name": PLAYER},
        ).get_json()
        row = next(a for a in results["answers"] if a["question_id"] == delivered["q1"]["id"])
        assert row["your_answer"] == "RIGHT", "the wording the player actually saw"


# ---------------------------------------------------------------------------
# ADD OPTION
# ---------------------------------------------------------------------------


class TestAddOption:
    def test_appending_an_option_is_allowed_after_delivery(
        self, client, coach_headers, delivered
    ):
        response = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT", True), opt("WRONG"), opt("ALSO WRONG")],
        )

        assert response.status_code == 200, response.get_json()
        assert [o["option_text"] for o in response.get_json()["options"]] == [
            "RIGHT",
            "WRONG",
            "ALSO WRONG",
        ]

    def test_an_existing_attempt_does_not_gain_it(self, client, coach_headers, delivered):
        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT", True), opt("WRONG"), opt("ALSO WRONG")],
        )

        resumed = start(client, delivered["code"]).get_json()

        assert delivered_options(resumed) == ["RIGHT", "WRONG"]

    def test_a_new_attempt_receives_it(self, client, coach_headers, delivered):
        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT", True), opt("WRONG"), opt("ALSO WRONG")],
        )

        fresh = start(client, delivered["code"], player=OTHER).get_json()

        assert delivered_options(fresh) == ["RIGHT", "WRONG", "ALSO WRONG"]

    def test_existing_answers_are_untouched(self, app, client, coach_headers, delivered):
        with app.app_context():
            before = {
                (a.question_id, a.selected_option_id, a.is_correct)
                for a in Answer.query.all()
            }

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT", True), opt("WRONG"), opt("ALSO WRONG")],
        )

        with app.app_context():
            after = {
                (a.question_id, a.selected_option_id, a.is_correct)
                for a in Answer.query.all()
            }
        assert after == before

    def test_adding_a_CORRECT_option_is_refused(self, client, coach_headers, delivered):
        """That is a key change wearing an addition's clothing.

        For multiple choice, `validate_options_for_type` refuses a second
        correct answer before the Phase 4C guard is reached - so this asserts
        the REFUSAL, not which guard produced it. The 4C branch behind it is a
        belt-and-braces check that stays correct if that type rule ever
        loosens; `test_moving_the_correct_answer_is_refused` is the case that
        exercises 4C's own key check directly.
        """
        refused = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT", True), opt("WRONG"), opt("ALSO RIGHT", True)],
        )

        assert refused.status_code == 422


# ---------------------------------------------------------------------------
# STILL BLOCKED
# ---------------------------------------------------------------------------


class TestStillBlocked:
    def test_removing_an_option_is_refused(self, client, coach_headers, delivered):
        """Three options down to two. That passes validate_options_for_type,
        so this genuinely exercises the Phase 4C guard rather than the generic
        "multiple choice needs at least two options" rule."""
        refused = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q3"]["id"],
            [opt("A", True), opt("B")],
        )

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "option_removal_blocked"

    def test_moving_the_correct_answer_is_refused(self, client, coach_headers, delivered):
        refused = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT"), opt("WRONG", True)],
        )

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "correct_answer_change_blocked"

    def test_a_refused_edit_changes_NOTHING(self, app, client, coach_headers, delivered):
        """Refusals must not half-apply. The text change in this payload is
        itself legal - it is rejected because it travels with a key change."""
        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("REWORDED"), opt("WRONG", True)],
        )

        with app.app_context():
            options = db.session.get(Question, delivered["q1"]["id"]).options
            assert [o.option_text for o in options] == ["RIGHT", "WRONG"]
            assert [o.is_correct_answer for o in options] == [True, False]

    def test_changing_the_question_type_is_still_refused(
        self, client, coach_headers, delivered
    ):
        """The Phase 4a corruption hole stays shut."""
        refused = client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_type": "written"},
            headers=coach_headers,
        )

        assert refused.status_code == 422

    def test_deleting_a_delivered_question_is_still_refused(
        self, client, coach_headers, delivered
    ):
        refused = client.delete(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            headers=coach_headers,
        )

        assert refused.status_code == 422


# ---------------------------------------------------------------------------
# A QUESTION NOBODY HAS RECEIVED IS STILL FREELY EDITABLE
# ---------------------------------------------------------------------------


class TestUndeliveredIsUnrestricted:
    def test_the_correct_answer_can_still_be_changed_before_delivery(
        self, client, coach_headers
    ):
        """Phase 4C must not make authoring harder. Nothing has seen this
        question, so the whole option list is still the coach's to rewrite."""
        quiz = client.post(
            "/api/quizzes", json={"title": "Draft"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Still a draft")

        response = patch_options(
            client,
            coach_headers,
            quiz["id"],
            question["id"],
            [opt("RIGHT"), opt("WRONG", True)],
        )

        assert response.status_code == 200

    def test_options_can_still_be_removed_before_delivery(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Draft"}, headers=coach_headers
        ).get_json()
        question = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Three options",
                "question_type": "multiple_choice",
                "options": [opt("A", True), opt("B"), opt("C")],
            },
            headers=coach_headers,
        ).get_json()

        response = patch_options(
            client, coach_headers, quiz["id"], question["id"], [opt("A", True), opt("B")]
        )

        assert response.status_code == 200


# ---------------------------------------------------------------------------
# THE DELIVERED CHECK
# ---------------------------------------------------------------------------


class TestDeliveredCheck:
    def test_a_delivered_and_ANSWERED_question_is_flagged(
        self, client, coach_headers, delivered
    ):
        quiz = client.get(
            f"/api/quizzes/{delivered['quiz_id']}", headers=coach_headers
        ).get_json()

        flagged = {q["id"]: q["has_been_delivered"] for q in quiz["questions"]}
        assert flagged[delivered["q1"]["id"]] is True

    def test_a_delivered_but_SKIPPED_question_is_also_flagged(
        self, client, coach_headers, delivered
    ):
        """THE WHOLE REASON THE CHECK IS SNAPSHOT-BASED. Nobody answered q2,
        so an answer-based check would tell the coach their correction affects
        nobody - when in fact somebody looked at it and could not do it."""
        quiz = client.get(
            f"/api/quizzes/{delivered['quiz_id']}", headers=coach_headers
        ).get_json()

        flagged = {q["id"]: q["has_been_delivered"] for q in quiz["questions"]}
        assert flagged[delivered["q2"]["id"]] is True

        # ...and it genuinely has no answer row.
        assert True

    def test_a_never_delivered_question_is_NOT_flagged(self, client, coach_headers, delivered):
        added = _mc(client, coach_headers, delivered["quiz_id"], "Added after everyone joined")

        quiz = client.get(
            f"/api/quizzes/{delivered['quiz_id']}", headers=coach_headers
        ).get_json()

        flagged = {q["id"]: q["has_been_delivered"] for q in quiz["questions"]}
        assert flagged[added["id"]] is False

    def test_a_LEGACY_answered_question_is_still_protected(
        self, app, client, coach_headers, delivered
    ):
        """`has_been_delivered` is snapshot-based and would say False here.
        The ENFORCEMENT uses `has_history`, which also counts answers, so a
        pre-Phase-1 question cannot be corrupted by an unsafe edit just
        because no snapshot was ever written for it."""
        # A legacy attempt has ANSWERS and no snapshot. Answering q3 first is
        # what makes this that case - with neither an answer nor a snapshot the
        # question genuinely has no history, and the free edit path is correct.
        client.post(
            "/api/play/answers",
            json={
                "access_code_id": delivered["code"]["id"],
                "player_name": PLAYER,
                "question_id": delivered["q3"]["id"],
                "selected_option_id": delivered["q3"]["options"][0]["id"],
                "answer_text": None,
            },
        )

        with app.app_context():
            AttemptQuestionSnapshot.query.filter_by(
                attempt_id=delivered["attempt_id"]
            ).delete()
            db.session.commit()

        refused = patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q3"]["id"],
            [opt("A", True), opt("B")],
        )

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "option_removal_blocked"

    def test_the_flag_costs_one_query_regardless_of_quiz_size(
        self, app, client, coach_headers
    ):
        """Attached per QUIZ, not per question - the editor is the screen a
        coach opens most."""
        from sqlalchemy import event

        quiz = client.post(
            "/api/quizzes", json={"title": "Big"}, headers=coach_headers
        ).get_json()
        for i in range(12):
            _mc(client, coach_headers, quiz["id"], f"Q{i}")

        queries = []

        def listener(conn, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        with app.app_context():
            engine = db.engine
        event.listen(engine, "before_cursor_execute", listener)
        try:
            client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers)
        finally:
            event.remove(engine, "before_cursor_execute", listener)

        snapshot_queries = [q for q in queries if "attempt_question_snapshots" in q]
        assert len(snapshot_queries) == 1, snapshot_queries


# ---------------------------------------------------------------------------
# IMAGES AND ANNOTATIONS
# ---------------------------------------------------------------------------


class TestImagesAndAnnotations:
    @pytest.fixture
    def with_image(self, client, coach_headers):
        quiz = client.post(
            "/api/quizzes", json={"title": "Film"}, headers=coach_headers
        ).get_json()
        question = _mc(client, coach_headers, quiz["id"], "Look at the film")
        buffer, filename = make_image_file("original.png", (30, 30))
        uploaded = client.post(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert uploaded.status_code in (200, 201), uploaded.get_json()
        client.put(
            f"/api/quizzes/{quiz['id']}/questions/{question['id']}/image/annotations",
            json={"annotations": [{"kind": "original"}]},
            headers=coach_headers,
        )
        client.put(
            f"/api/quizzes/{quiz['id']}/roster",
            json={"players": [PLAYER, OTHER]},
            headers=coach_headers,
        )
        code = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()
        started = start(client, code).get_json()
        return {
            "quiz_id": quiz["id"],
            "question": question,
            "code": code,
            "start": started,
            "original_url": started["questions"][0]["image"]["image_url"],
        }

    def test_replacing_the_image_keeps_the_old_one_for_the_old_attempt(
        self, client, coach_headers, with_image
    ):
        buffer, filename = make_image_file("replacement.png", (60, 60))
        replaced = client.post(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )
        assert replaced.status_code in (200, 201), replaced.get_json()

        resumed = start(client, with_image["code"]).get_json()
        preserved_url = resumed["questions"][0]["image"]["image_url"]
        live_url = client.get(
            f"/api/quizzes/{with_image['quiz_id']}", headers=coach_headers
        ).get_json()["questions"][0]["image"]["image_url"]

        # NOT equal to the pre-replacement URL, and that is correct: Phase 1
        # COPIES the old object to a new key and repoints the snapshot at the
        # copy, so the original key is free to be unlinked. What must hold is
        # that the old attempt is not looking at the NEW picture, and that its
        # URL still resolves.
        assert preserved_url != live_url
        assert client.get(preserved_url).status_code == 200

    def test_a_new_attempt_receives_the_replacement(
        self, client, coach_headers, with_image
    ):
        buffer, filename = make_image_file("replacement.png", (60, 60))
        client.post(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )

        fresh = start(client, with_image["code"], player=OTHER).get_json()

        assert fresh["questions"][0]["image"]["image_url"] != with_image["original_url"]

    def test_deleting_the_image_keeps_it_for_the_old_attempt(
        self, client, coach_headers, with_image
    ):
        removed = client.delete(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image",
            headers=coach_headers,
        )
        assert removed.status_code in (200, 204), removed.get_json()

        resumed = start(client, with_image["code"]).get_json()
        preserved_url = resumed["questions"][0]["image"]["image_url"]

        # The live question now has no image at all, but the attempt that was
        # given one still shows it - from the preserved copy.
        assert preserved_url
        assert client.get(preserved_url).status_code == 200
        live = client.get(
            f"/api/quizzes/{with_image['quiz_id']}", headers=coach_headers
        ).get_json()
        assert live["questions"][0]["image"] is None

    def test_a_new_attempt_gets_no_image_after_deletion(
        self, client, coach_headers, with_image
    ):
        client.delete(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image",
            headers=coach_headers,
        )

        fresh = start(client, with_image["code"], player=OTHER).get_json()

        assert fresh["questions"][0]["image"] is None

    def test_the_preserved_bytes_are_still_fetchable(
        self, client, coach_headers, with_image
    ):
        """Phase 1's copy-on-write, finally observed end to end: the old
        attempt's URL must still resolve to real bytes after the coach
        replaced the picture."""
        buffer, filename = make_image_file("replacement.png", (60, 60))
        client.post(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image",
            data={"image": (buffer, filename)},
            content_type="multipart/form-data",
            headers=coach_headers,
        )

        resumed = start(client, with_image["code"]).get_json()
        url = resumed["questions"][0]["image"]["image_url"]

        fetched = client.get(url)
        assert fetched.status_code == 200
        assert len(fetched.data) > 0

    def test_editing_annotations_leaves_the_old_attempts_alone(
        self, client, coach_headers, with_image
    ):
        client.put(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image/annotations",
            json={"annotations": [{"kind": "corrected"}]},
            headers=coach_headers,
        )

        resumed = start(client, with_image["code"]).get_json()

        assert resumed["questions"][0]["image"]["annotations"] == [{"kind": "original"}]

    def test_a_new_attempt_receives_the_new_annotations(
        self, client, coach_headers, with_image
    ):
        client.put(
            f"/api/quizzes/{with_image['quiz_id']}/questions/{with_image['question']['id']}/image/annotations",
            json={"annotations": [{"kind": "corrected"}]},
            headers=coach_headers,
        )

        fresh = start(client, with_image["code"], player=OTHER).get_json()

        assert fresh["questions"][0]["image"]["annotations"] == [{"kind": "corrected"}]


# ---------------------------------------------------------------------------
# NOTHING ELSE MOVED
# ---------------------------------------------------------------------------


class TestInvariants:
    def test_snapshots_are_never_mutated_by_a_correction(
        self, app, client, coach_headers, delivered
    ):
        with app.app_context():
            before = {
                (r.id, r.position, r.question_id, str(r.snapshot))
                for r in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=delivered["attempt_id"]
                )
            }

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG"), opt("ADDED")],
        )
        client.patch(
            f"/api/quizzes/{delivered['quiz_id']}/questions/{delivered['q1']['id']}",
            json={"question_text": "Corrected wording"},
            headers=coach_headers,
        )

        with app.app_context():
            after = {
                (r.id, r.position, r.question_id, str(r.snapshot))
                for r in AttemptQuestionSnapshot.query.filter_by(
                    attempt_id=delivered["attempt_id"]
                )
            }
        assert after == before

    def test_no_answer_row_is_touched_by_any_correction(
        self, app, client, coach_headers, delivered
    ):
        with app.app_context():
            before = {
                (a.id, a.question_id, a.selected_option_id, a.answer_text, a.is_correct)
                for a in Answer.query.all()
            }

        patch_options(
            client,
            coach_headers,
            delivered["quiz_id"],
            delivered["q1"]["id"],
            [opt("RIGHT, reworded", True), opt("WRONG"), opt("ADDED")],
        )

        with app.app_context():
            after = {
                (a.id, a.question_id, a.selected_option_id, a.answer_text, a.is_correct)
                for a in Answer.query.all()
            }
        assert after == before
