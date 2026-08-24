"""PHASE E - did the result improve?

Not "did the player master it". Every rule here exists to stop a surface built
on this data claiming more than the data supports: a comparison across two
different populations, an ungraded answer read as a miss, an absent player read
as a failure, or a later retag rewriting what a past round tested.
"""
from app import db
from app.models import Answer, AttemptQuestionSnapshot, PlayerAttempt
from app.models.concept import Concept
from app.models.quiz import Quiz
from app.services.retest_verification import verification_for
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


def _answer_round(client, code_id, name, question_id, option_id):
    start_and_submit(
        client, code_id, name,
        [{"question_id": question_id, "selected_option_id": option_id}],
    )


def _parent_with_misses(client, headers, missed=("A", "B"), passed=()):
    """A tagged quiz where `missed` got it wrong and `passed` got it right."""
    quiz, tf, _written, code = build_ready_quiz(client, headers)
    concept = _concept(client, headers)
    _tag(client, headers, quiz["id"], tf["id"], concept["id"])
    _widen(client, headers, quiz["id"], list(missed) + list(passed))
    wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
    right = next(o for o in tf["options"] if o["is_correct_answer"] is not False)
    for name in missed:
        _answer_round(client, code["id"], name, tf["id"], wrong["id"])
    for name in passed:
        _answer_round(client, code["id"], name, tf["id"], right["id"])
    return quiz, tf, concept, code


def _make_retest(client, headers, quiz_id, concept_id, names):
    return client.post(
        f"/api/quizzes/{quiz_id}/retests",
        json={"concept_id": concept_id, "player_names": list(names)},
        headers=headers,
    ).get_json()


def _activate(client, headers, quiz_id):
    return client.post(f"/api/quizzes/{quiz_id}/access-codes", headers=headers).get_json()


def _verify(quiz_id):
    return verification_for(db.session.get(Quiz, quiz_id))


class TestItOnlyAppliesToARetest:
    def test_an_ordinary_quiz_has_no_verification(self, client, coach_headers):
        quiz, _, _, _ = _parent_with_misses(client, coach_headers)
        assert _verify(quiz["id"]) is None


class TestPopulationsAreNotConflated:
    def test_the_team_figure_is_CONTEXT_and_the_comparison_is_the_targeted_group(
        self, client, coach_headers
    ):
        """"6 of 22 missed" and "2 of 6 missed" describe different groups.
        The team-wide number is reported separately and never divided into."""
        quiz, tf, concept, _ = _parent_with_misses(
            client, coach_headers, missed=("A", "B"), passed=("C", "D")
        )
        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A", "B"])

        v = _verify(retest["id"])

        assert v["parent_response_total"] == 4      # the whole first check
        assert v["parent_missed_total"] == 2        # how big the problem was
        assert v["targeted_total"] == 2             # who this retest is for
        # The comparison is closed over the targeted group only.
        assert v["correct_count"] + v["incorrect_count"] + v["ungraded_count"] + v[
            "not_submitted_count"
        ] == v["targeted_total"]


class TestOutcomes:
    def _retest_answered(self, client, headers, correct_names=(), wrong_names=()):
        quiz, tf, concept, _ = _parent_with_misses(
            client, headers, missed=tuple(correct_names) + tuple(wrong_names)
        )
        retest = _make_retest(
            client, headers, quiz["id"], concept["id"],
            list(correct_names) + list(wrong_names),
        )
        code = _activate(client, headers, retest["id"])
        copied = retest["questions"][0]
        right = next(o for o in copied["options"] if o["is_correct_answer"] is not False)
        wrong = next(o for o in copied["options"] if o["is_correct_answer"] is False)
        for name in correct_names:
            _answer_round(client, code["id"], name, copied["id"], right["id"])
        for name in wrong_names:
            _answer_round(client, code["id"], name, copied["id"], wrong["id"])
        return retest

    def test_incorrect_then_correct_counts_as_correct_this_time(self, client, coach_headers):
        retest = self._retest_answered(client, coach_headers, correct_names=("A", "B"))
        v = _verify(retest["id"])

        assert v["correct_count"] == 2
        assert v["incorrect_count"] == 0
        assert v["is_complete"] is True

    def test_incorrect_then_incorrect_is_still_missing(self, client, coach_headers):
        retest = self._retest_answered(client, coach_headers, wrong_names=("A", "B"))
        v = _verify(retest["id"])

        assert v["incorrect_count"] == 2
        assert [p["display_name"] for p in v["still_missing"]] == ["A", "B"]

    def test_a_mixed_round_reports_both(self, client, coach_headers):
        retest = self._retest_answered(
            client, coach_headers, correct_names=("A",), wrong_names=("B",)
        )
        v = _verify(retest["id"])

        assert (v["correct_count"], v["incorrect_count"]) == (1, 1)
        assert [p["display_name"] for p in v["still_missing"]] == ["B"]

    def test_A_PLAYER_WHO_HAS_NOT_SUBMITTED_IS_NOT_A_MISS(self, client, coach_headers):
        """Absence is not failure, and the card must not read as though the
        retest is finished."""
        quiz, _tf, concept, _ = _parent_with_misses(client, coach_headers, missed=("A", "B"))
        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A", "B"])
        code = _activate(client, coach_headers, retest["id"])
        copied = retest["questions"][0]
        right = next(o for o in copied["options"] if o["is_correct_answer"] is not False)
        _answer_round(client, code["id"], "A", copied["id"], right["id"])

        v = _verify(retest["id"])

        assert v["correct_count"] == 1
        assert v["not_submitted_count"] == 1
        assert v["incorrect_count"] == 0
        assert v["is_complete"] is False

    def test_AN_UNGRADED_ANSWER_IS_NOT_A_MISS_and_blocks_the_claim(self, client, coach_headers):
        """A coach's own grading backlog must never read as evidence about
        what the team knows."""
        quiz, _tf, written, code = build_ready_quiz(client, coach_headers)
        concept = _concept(client, coach_headers)
        _tag(client, coach_headers, quiz["id"], written["id"], concept["id"])
        _widen(client, coach_headers, quiz["id"], ["A"])
        start_and_submit(
            client, code["id"], "A", [{"question_id": written["id"], "answer_text": "no"}]
        )
        for answer in Answer.query.filter_by(question_id=written["id"]).all():
            answer.is_correct = False
        db.session.commit()

        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A"])
        rcode = _activate(client, coach_headers, retest["id"])
        copied = retest["questions"][0]
        start_and_submit(
            client, rcode["id"], "A", [{"question_id": copied["id"], "answer_text": "maybe"}]
        )

        v = _verify(retest["id"])

        assert v["ungraded_count"] == 1
        assert v["incorrect_count"] == 0
        assert v["correct_count"] == 0
        assert v["is_complete"] is False


class TestIdentity:
    def _canonical_parent(self, client, headers):
        quiz, tf, _written, code = build_ready_quiz(client, headers)
        concept = _concept(client, headers)
        _tag(client, headers, quiz["id"], tf["id"], concept["id"])
        player = client.post(
            "/api/players", json={"first_name": "Jalen", "last_name": "Reed"}, headers=headers
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz['id']}/roster/members",
            json={"player_ids": [player["id"]]},
            headers=headers,
        )
        wrong = next(o for o in tf["options"] if o["is_correct_answer"] is False)
        _answer_round(client, code["id"], "Jalen Reed", tf["id"], wrong["id"])
        return quiz, tf, concept, player

    def test_a_canonical_player_is_matched_by_ID(self, client, coach_headers):
        quiz, _tf, concept, player = self._canonical_parent(client, coach_headers)
        retest = client.post(
            f"/api/quizzes/{quiz['id']}/retests",
            json={"concept_id": concept["id"], "player_ids": [player["id"]]},
            headers=coach_headers,
        ).get_json()

        v = _verify(retest["id"])

        assert v["targeted_total"] == 1
        assert v["players"][0]["player_id"] == player["id"]
        assert v["players"][0]["identity"] == "canonical"

    def test_RENAMING_A_PLAYER_BETWEEN_ROUNDS_DOES_NOT_BREAK_THE_MATCH(
        self, client, coach_headers
    ):
        """The reason names are never used to match a canonical player."""
        quiz, _tf, concept, player = self._canonical_parent(client, coach_headers)
        retest = client.post(
            f"/api/quizzes/{quiz['id']}/retests",
            json={"concept_id": concept["id"], "player_ids": [player["id"]]},
            headers=coach_headers,
        ).get_json()

        client.patch(
            f"/api/players/{player['id']}",
            json={"first_name": "Jaylen", "last_name": "Reid"},
            headers=coach_headers,
        )

        v = _verify(retest["id"])

        assert v["targeted_total"] == 1
        assert v["players"][0]["player_id"] == player["id"]
        # The parent round is still recognised as this player's.
        assert v["players"][0]["parent_outcome"] == "incorrect"

    def test_a_legacy_name_is_kept_SEPARATE_from_a_canonical_player(self, client, coach_headers):
        """"Jalen Reed typed into a phone" and "the Player row called Jalen
        Reed" are not known to be the same person, and merging them on a string
        is the guess this refuses to make."""
        from app.services.retest_verification import PlayerKey

        canonical = PlayerKey(player_id=7, legacy_name=None)
        legacy = PlayerKey(player_id=None, legacy_name="jalen reed")

        assert canonical != legacy
        assert canonical.is_canonical is True
        assert legacy.is_canonical is False


class TestConceptHistory:
    def test_the_DELIVERED_concept_is_used_when_it_was_recorded(self, client, coach_headers):
        """Snapshot v2 records the concept a player actually received, so a
        retag afterwards cannot rewrite what the round tested."""
        quiz, _tf, concept, _ = _parent_with_misses(client, coach_headers, missed=("A",))
        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A"])
        code = _activate(client, coach_headers, retest["id"])
        copied = retest["questions"][0]
        right = next(o for o in copied["options"] if o["is_correct_answer"] is not False)
        _answer_round(client, code["id"], "A", copied["id"], right["id"])

        before = _verify(retest["id"])
        assert before["concept_source"] == "snapshot"
        assert before["correct_count"] == 1

        # A coach retags the live question months later.
        other = _concept(client, coach_headers, "Something Else")
        _tag(client, coach_headers, retest["id"], copied["id"], other["id"])
        db.session.expire_all()

        after = _verify(retest["id"])

        # The delivered concept still names the round, so the comparison holds.
        assert after["concept_source"] == "snapshot"
        assert after["concept_ids"] == before["concept_ids"]

    def test_a_delivery_that_PREDATES_concepts_falls_back_and_says_so(
        self, client, coach_headers
    ):
        """Every snapshot already in Peira is v1 and carries no concept.
        A strict snapshot-only rule would make this feature blank on all
        existing data, so the live tag stands in - flagged, never presented as
        recorded history."""
        quiz, _tf, concept, _ = _parent_with_misses(client, coach_headers, missed=("A",))
        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A"])
        code = _activate(client, coach_headers, retest["id"])
        copied = retest["questions"][0]
        right = next(o for o in copied["options"] if o["is_correct_answer"] is not False)
        _answer_round(client, code["id"], "A", copied["id"], right["id"])

        # Strip the concept from the delivered snapshots, as a v1 row has it.
        for row in AttemptQuestionSnapshot.query.all():
            payload = dict(row.snapshot or {})
            payload.pop("concept", None)
            payload["version"] = 1
            row.snapshot = payload
        db.session.commit()
        db.session.expire_all()

        v = _verify(retest["id"])

        assert v["concept_source"] == "live_fallback"
        assert v["targeted_total"] == 1


class TestChaining:
    def test_a_retest_of_a_retest_compares_to_its_IMMEDIATE_PARENT(self, client, coach_headers):
        """"What changed since the last check?" - not since the beginning."""
        quiz, _tf, concept, _ = _parent_with_misses(client, coach_headers, missed=("A",))
        first = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A"])
        code = _activate(client, coach_headers, first["id"])
        copied = first["questions"][0]
        wrong = next(o for o in copied["options"] if o["is_correct_answer"] is False)
        _answer_round(client, code["id"], "A", copied["id"], wrong["id"])

        second = _make_retest(client, coach_headers, first["id"], concept["id"], ["A"])

        v = _verify(second["id"])

        assert v["parent_quiz_id"] == first["id"]
        assert v["parent_quiz_id"] != quiz["id"]

    def test_players_still_missing_feed_the_next_retest_directly(self, client, coach_headers):
        quiz, _tf, concept, _ = _parent_with_misses(client, coach_headers, missed=("A", "B"))
        retest = _make_retest(client, coach_headers, quiz["id"], concept["id"], ["A", "B"])
        code = _activate(client, coach_headers, retest["id"])
        copied = retest["questions"][0]
        right = next(o for o in copied["options"] if o["is_correct_answer"] is not False)
        wrong = next(o for o in copied["options"] if o["is_correct_answer"] is False)
        _answer_round(client, code["id"], "A", copied["id"], right["id"])
        _answer_round(client, code["id"], "B", copied["id"], wrong["id"])

        v = _verify(retest["id"])
        still = [p["display_name"] for p in v["still_missing"]]

        assert still == ["B"]
        # And Phase D accepts exactly that, without a second derivation.
        again = client.post(
            f"/api/quizzes/{retest['id']}/retests",
            json={"concept_id": concept["id"], "player_names": still},
            headers=coach_headers,
        )
        assert again.status_code == 201
        assert db.session.get(Quiz, again.get_json()["id"]).retest_of_quiz_id == retest["id"]
