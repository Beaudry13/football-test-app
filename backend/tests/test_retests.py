"""PHASE D - "Retest these players".

Peira assembles; the coach sends. These tests pin both halves of that: what
Peira is allowed to assemble from, and the fact that it stops before sending.

The security cases matter more than usual here. This endpoint copies content
and targets people, so a request that could name another organization's quiz,
concept or player would be a cross-tenant leak with a UI in front of it.
"""
from app import db
from app.models import Answer, Question
from app.models.concept import Concept
from app.models.player import Player
from app.models.quiz import Quiz
from tests.test_play_and_grading import build_ready_quiz, start_and_submit


def _concept(client, headers, name="Force / Contain"):
    return client.post("/api/concepts", json={"name": name}, headers=headers).get_json()


def _tag(client, headers, quiz_id, question_id, concept_id):
    client.patch(
        f"/api/quizzes/{quiz_id}/questions/{question_id}",
        json={"concept_id": concept_id},
        headers=headers,
    )


def _widen(client, headers, quiz_id, names):
    client.put(f"/api/quizzes/{quiz_id}/roster", json={"players": names}, headers=headers)


def _retest(client, headers, quiz_id, **body):
    return client.post(f"/api/quizzes/{quiz_id}/retests", json=body, headers=headers)


def _missed_setup(client, headers, names=("A", "B")):
    """A tagged quiz where `names` all got the true/false question wrong."""
    quiz, tf, written, code = build_ready_quiz(client, headers)
    concept = _concept(client, headers)
    _tag(client, headers, quiz["id"], tf["id"], concept["id"])
    _widen(client, headers, quiz["id"], list(names))
    wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
    for name in names:
        start_and_submit(
            client, code["id"], name,
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )
    return quiz, tf, written, concept, code


class TestOrganizationIsolation:
    def test_another_orgs_quiz_is_not_even_visible(self, client, coach_headers):
        refused = _retest(client, coach_headers, 999999, concept_id=1, player_names=["A"])
        assert refused.status_code == 404

    def test_a_concept_this_org_does_not_own_is_refused(self, client, coach_headers):
        quiz, _, _, _, _ = _missed_setup(client, coach_headers)
        refused = _retest(client, coach_headers, quiz["id"], concept_id=999999, player_names=["A"])
        assert refused.status_code == 422

    def test_a_player_who_missed_NOTHING_cannot_be_targeted(self, client, coach_headers):
        """One refusal covers "not in this org" and "did not miss anything" on
        purpose - the caller is entitled to neither answer, and separating them
        would reveal whether a player id exists."""
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)
        refused = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_ids=[999999],
        )
        assert refused.status_code == 422
        assert refused.get_json().get("reason") == "player_not_eligible"

    def test_a_question_the_group_did_not_miss_cannot_be_copied(self, client, coach_headers):
        """question_ids may only NARROW what the server derived. Widening it is
        how a client would otherwise copy arbitrary content."""
        quiz, _, written, concept, _ = _missed_setup(client, coach_headers)
        refused = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_names=["A"], question_ids=[written["id"]],
        )
        assert refused.status_code == 422
        assert refused.get_json().get("reason") == "question_not_eligible"

    def test_targeting_nobody_is_refused_rather_than_defaulted(self, client, coach_headers):
        # Defaulting to "everyone who missed" would send to more people than
        # the coach asked for.
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)
        assert _retest(client, coach_headers, quiz["id"], concept_id=concept["id"]).status_code == 422


class TestWhoQualifies:
    def _answer_state(self, client, headers, is_correct):
        quiz, tf, _, code = build_ready_quiz(client, headers)
        concept = _concept(client, headers)
        _tag(client, headers, quiz["id"], tf["id"], concept["id"])
        _widen(client, headers, quiz["id"], ["A"])
        option = next(
            o for o in tf["options"] if bool(o["is_correct_answer"]) is bool(is_correct)
        )
        start_and_submit(
            client, code["id"], "A",
            [{"question_id": tf["id"], "selected_option_id": option["id"]}],
        )
        return quiz, concept

    def test_a_graded_incorrect_answer_qualifies(self, client, coach_headers):
        quiz, concept = self._answer_state(client, coach_headers, is_correct=False)
        created = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        )
        assert created.status_code == 201

    def test_a_correct_answer_does_not(self, client, coach_headers):
        quiz, concept = self._answer_state(client, coach_headers, is_correct=True)
        refused = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        )
        assert refused.status_code == 422

    def test_an_UNGRADED_answer_never_silently_becomes_wrong(self, client, coach_headers):
        """The oldest rule in this codebase. A coach's grading backlog is not
        evidence that a player got something wrong."""
        quiz, _, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A"])
        start_and_submit(
            client, code["id"], "A", [{"question_id": written["id"], "answer_text": "maybe"}]
        )

        refused = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        )

        assert refused.status_code == 422
        assert refused.get_json().get("reason") == "player_not_eligible"

    def test_an_unanswered_question_is_not_a_miss(self, client, coach_headers):
        # No answer row at all. Absence is not wrongness.
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A"])
        start_and_submit(client, code["id"], "A", [])

        refused = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        )
        assert refused.status_code == 422

    def test_a_PRACTICE_attempt_does_not_qualify(self, client, coach_headers):
        """Nobody owes a practice rep, and a practice answer has never counted
        toward anything else either."""
        quiz, tf, _, _ = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A"])
        practice = client.post(
            f"/api/quizzes/{quiz['id']}/access-codes",
            json={"mode": "PRACTICE"},
            headers=coach_headers,
        ).get_json()
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, practice["id"], "A",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )

        refused = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        )
        assert refused.status_code == 422


class TestWhatGetsCopied:
    def test_the_UNION_of_what_the_group_missed(self, client, coach_headers):
        """Player A missed Q1, player B missed Q2, the retest asks both. One
        quiz has one question list, and "you all get what this group missed" is
        a sentence a coach can say out loud."""
        quiz, tf, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A", "B"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        correct = next(o for o in tf["options"] if o["is_correct_answer"] is not False)

        start_and_submit(
            client, code["id"], "A",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )
        start_and_submit(
            client, code["id"], "B",
            [
                {"question_id": tf["id"], "selected_option_id": correct["id"]},
                {"question_id": written["id"], "answer_text": "no"},
            ],
        )
        for answer in Answer.query.filter_by(question_id=written["id"]).all():
            answer.is_correct = False
        db.session.commit()

        created = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_names=["A", "B"],
        ).get_json()

        copied = {q["question_text"] for q in created["questions"]}
        assert len(copied) == 2

    def test_a_STOPPED_question_is_excluded_and_the_coach_is_told(self, client, coach_headers):
        """Copying it would put an undeliverable question in the retest;
        dropping it silently would leave the coach wondering why the count is
        short."""
        quiz, tf, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A"])
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "A",
            [
                {"question_id": tf["id"], "selected_option_id": wrong["id"]},
                {"question_id": written["id"], "answer_text": "no"},
            ],
        )
        for answer in Answer.query.filter_by(question_id=written["id"]).all():
            answer.is_correct = False
        db.session.commit()
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{written['id']}/retire", headers=coach_headers
        )

        created = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        assert len(created["questions"]) == 1
        assert len(created["skipped_retired_questions"]) == 1
        assert created["skipped_retired_questions"][0]["id"] == written["id"]

    def test_the_copy_keeps_its_concept(self, client, coach_headers):
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        created = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        assert created["questions"][0]["concept"]["id"] == concept["id"]

    def test_THE_ORIGINAL_IS_UNTOUCHED(self, client, coach_headers):
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        before = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()

        _retest(client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"])

        after = client.get(f"/api/quizzes/{quiz['id']}", headers=coach_headers).get_json()
        assert after["title"] == before["title"]
        assert len(after["questions"]) == len(before["questions"])
        assert [q["id"] for q in after["questions"]] == [q["id"] for q in before["questions"]]


class TestTargeting:
    def test_the_retest_roster_is_exactly_the_retested_players(self, client, coach_headers):
        """The targeting mechanism, and it needs no new schema: eligibility is
        the linked groups OR the quiz's own roster, and a retest is a new quiz.
        """
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers, names=("A", "B", "C"))
        created = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_names=["A", "B"],
        ).get_json()

        roster = client.get(f"/api/quizzes/{created['id']}/roster", headers=coach_headers).get_json()
        assert {p["player_name"] for p in roster["players"]} == {"A", "B"}

    def test_activating_with_no_groups_admits_exactly_those_players(self, client, coach_headers):
        # End to end: the roster is not decoration, it is who can join.
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers, names=("A", "B", "C"))
        created = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_names=["A"],
        ).get_json()
        code = client.post(
            f"/api/quizzes/{created['id']}/access-codes", headers=coach_headers
        ).get_json()

        allowed = client.post("/api/play/validate-code", json={"code": code["code"]}).get_json()

        assert allowed["roster_players"] == ["A"]

    def test_a_canonical_player_is_linked_by_id_not_just_by_name(self, client, coach_headers):
        """Verification later has to recognise the same person across two
        quizzes, which a name cannot do."""
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        player = client.post(
            "/api/players", json={"first_name": "Jalen", "last_name": "Reed"}, headers=coach_headers
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz['id']}/roster/members",
            json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "Jalen Reed",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )

        created = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_ids=[player["id"]],
        ).get_json()

        roster = client.get(f"/api/quizzes/{created['id']}/roster", headers=coach_headers).get_json()
        # The roster nests the canonical Player rather than exposing a bare
        # player_id - that is the existing contract, and it is what proves the
        # entry is linked rather than a name that happens to match.
        assert [p["player"]["id"] for p in roster["players"]] == [player["id"]]


class TestLineageAndDraftState:
    def test_the_retest_points_at_its_IMMEDIATE_PARENT(self, client, coach_headers):
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)
        created = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        assert db.session.get(Quiz, created["id"]).retest_of_quiz_id == quiz["id"]

    def test_A_RETEST_OF_A_RETEST_CHAINS(self, client, coach_headers):
        """Round order is what the parent pointer preserves and a root pointer
        would destroy - and the root stays derivable by walking up."""
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        first = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        # The player misses it again on the retest.
        _widen(client, coach_headers, first["id"], ["A"])
        code2 = client.post(
            f"/api/quizzes/{first['id']}/access-codes", headers=coach_headers
        ).get_json()
        copied_q = first["questions"][0]
        wrong = next(o for o in copied_q["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code2["id"], "A",
            [{"question_id": copied_q["id"], "selected_option_id": wrong["id"]}],
        )

        second = _retest(
            client, coach_headers, first["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        assert db.session.get(Quiz, second["id"]).retest_of_quiz_id == first["id"]
        # ...and the root is reachable by walking the chain.
        node = db.session.get(Quiz, second["id"])
        hops = 0
        while node.retest_of_quiz_id is not None and hops < 5:
            node = db.session.get(Quiz, node.retest_of_quiz_id)
            hops += 1
        assert node.id == quiz["id"]

    def test_it_arrives_as_a_DRAFT_with_nothing_activated_or_sent(self, client, coach_headers):
        """Peira assembles; the coach sends. Auto-activating would put a quiz
        in front of players that nobody had reviewed."""
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)

        created = _retest(
            client, coach_headers, quiz["id"], concept_id=concept["id"], player_names=["A"]
        ).get_json()

        listed = [
            q for q in client.get("/api/quizzes", headers=coach_headers).get_json()
            if q["id"] == created["id"]
        ][0]
        assert listed["is_active"] is False
        assert listed["completed_count"] == 0


class TestPhaseECanBeReconstructed:
    def test_identity_and_lineage_survive_for_verification(self, client, coach_headers):
        """Phase E wants "6 missed, then 2 missed, these two still are". That
        needs three things to exist together: the parent link, the concept on
        the copied questions, and stable player identity. This asserts all
        three are present after a retest, without building Phase E."""
        quiz, tf, _, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], tf["id"], concept["id"])
        player = client.post(
            "/api/players", json={"first_name": "Jalen", "last_name": "Reed"}, headers=coach_headers
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz['id']}/roster/members",
            json={"player_ids": [player["id"]]},
            headers=coach_headers,
        )
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "Jalen Reed",
            [{"question_id": tf["id"], "selected_option_id": wrong["id"]}],
        )

        # 1. The original names who missed, WITH canonical identity.
        original_row = client.get(
            f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers
        ).get_json()["concept_breakdown"][0]
        assert original_row["players_missed"][0]["player_id"] == player["id"]

        created = _retest(
            client, coach_headers, quiz["id"],
            concept_id=concept["id"], player_ids=[player["id"]],
        ).get_json()

        # 2. Lineage back to the quiz being verified.
        assert db.session.get(Quiz, created["id"]).retest_of_quiz_id == quiz["id"]
        # 3. The concept survives onto the copy, so both rounds group the same.
        assert created["questions"][0]["concept"]["id"] == concept["id"]
        # 4. The same person is targetable and recognisable on the retest.
        roster = client.get(
            f"/api/quizzes/{created['id']}/roster", headers=coach_headers
        ).get_json()
        assert roster["players"][0]["player"]["id"] == player["id"]


class TestWhatTheCoachIsToldBeforeCommitting:
    """A retest that quietly contains fewer questions than the coach expects is
    worse than one that says what it left out."""

    def test_the_breakdown_reports_what_a_retest_could_copy(self, client, coach_headers):
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)

        row = client.get(
            f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers
        ).get_json()["concept_breakdown"][0]

        assert row["retestable_question_count"] == 1
        assert row["retired_missed_question_count"] == 0

    def test_a_STOPPED_question_is_counted_as_left_out(self, client, coach_headers):
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{tf['id']}/retire", headers=coach_headers
        )

        row = client.get(
            f"/api/quizzes/{quiz['id']}/dashboard", headers=coach_headers
        ).get_json()["concept_breakdown"][0]

        # Nothing left to copy, and the client must not offer the action.
        assert row["retestable_question_count"] == 0
        assert row["retired_missed_question_count"] == 1

    def test_the_endpoint_still_refuses_when_nothing_is_copyable(self, client, coach_headers):
        """Belt and braces: the client no longer offers it, and the server
        would still refuse if something else asked."""
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        client.post(
            f"/api/quizzes/{quiz['id']}/questions/{tf['id']}/retire", headers=coach_headers
        )

        refused = _retest(client, coach_headers, quiz["id"],
                          concept_id=concept["id"], player_names=["A"])

        assert refused.status_code == 422
        assert refused.get_json()["reason"] == "no_questions_to_retest"


class TestRetestTitles:
    """Two rounds on one concept used to produce two identically named quizzes,
    indistinguishable in the coach's quiz list."""

    def test_the_first_round_is_named_for_the_concept(self, client, coach_headers):
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)

        created = _retest(client, coach_headers, quiz["id"],
                          concept_id=concept["id"], player_names=["A"]).get_json()

        assert created["title"] == "Force / Contain - Retest"

    def test_a_retest_of_a_retest_is_NUMBERED(self, client, coach_headers):
        quiz, tf, _, concept, _ = _missed_setup(client, coach_headers)
        first = _retest(client, coach_headers, quiz["id"],
                        concept_id=concept["id"], player_names=["A", "B"]).get_json()

        code = client.post(
            f"/api/quizzes/{first['id']}/access-codes", headers=coach_headers
        ).get_json()
        copied = client.get(
            f"/api/quizzes/{first['id']}", headers=coach_headers
        ).get_json()["questions"][0]
        wrong = next(o for o in copied["options"] if o["is_correct_answer"] is False)
        start_and_submit(
            client, code["id"], "A",
            [{"question_id": copied["id"], "selected_option_id": wrong["id"]}],
        )

        second = _retest(client, coach_headers, first["id"],
                         concept_id=concept["id"], player_names=["A"]).get_json()

        assert second["title"] == "Force / Contain - Retest 2"
        assert second["title"] != first["title"]

    def test_a_title_the_coach_supplied_is_never_overwritten(self, client, coach_headers):
        quiz, _, _, concept, _ = _missed_setup(client, coach_headers)

        created = _retest(client, coach_headers, quiz["id"], concept_id=concept["id"],
                          player_names=["A"], title="Tuesday walkthrough").get_json()

        assert created["title"] == "Tuesday walkthrough"
