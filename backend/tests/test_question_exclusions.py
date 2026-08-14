"""Phase 3 - "don't count this question".

THE LOAD-BEARING PART OF THIS FILE IS THE EQUIVALENCE CLASS.

The exclusion predicate is written twice on purpose: once in Python
(`ExclusionSet.excludes`) and once in SQL (`sql_not_excluded`, used by the
quiz-card aggregate, which must not load 75,000 answer rows to divide two
numbers). Every other test here checks a behaviour; those tests check that the
two spellings cannot drift apart. If you change the rule in one place, they are
what will tell you that you forgot the other.

The second theme is EVIDENCE PRESERVATION. Exclusion changes what is COUNTED,
never what is STORED - no answer is edited, hidden or deleted - so every
surface that shows raw responses must still show them.
"""

import csv
import io

import pytest
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models import (
    Answer,
    AttemptStatus,
    PlayerAttempt,
    Question,
    QuestionExclusion,
)
from app.services.question_exclusions import (
    ExclusionSet,
    NO_EXCLUSIONS,
    load_for_quizzes,
)
from app.services.scoring import count_answers

PLAYER = "Jordan Smith"
OTHER = "Alex Lee"


# ---------------------------------------------------------------------------
# Fixture: one quiz, two assignments (Monday and Tuesday), real attempts
# ---------------------------------------------------------------------------


def _mc(client, headers, quiz_id, text):
    r = client.post(
        f"/api/quizzes/{quiz_id}/questions",
        json={
            "question_text": text,
            "question_type": "multiple_choice",
            "options": [
                {"option_text": "Right", "is_correct_answer": True},
                {"option_text": "Wrong", "is_correct_answer": False},
            ],
        },
        headers=headers,
    )
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def _pick(question, correct):
    return next(
        o["id"] for o in question["options"] if o["option_text"] == ("Right" if correct else "Wrong")
    )


def _submit(client, code, player, answers):
    started = client.post(
        "/api/play/start", json={"access_code_id": code["id"], "player_name": player}
    )
    assert started.status_code == 201, started.get_json()
    r = client.post(
        "/api/play/submit",
        json={"access_code_id": code["id"], "player_name": player, "answers": answers},
    )
    assert r.status_code == 201, r.get_json()
    return r.get_json()


@pytest.fixture
def quiz3(client, coach_headers):
    """Three questions; Monday and Tuesday assignments of the SAME quiz.

    Monday's player answers Q1 right, Q2 wrong, and skips Q3 entirely - so the
    fixture contains the case that matters most: an EXCLUDED question that
    nobody answered must not move the score, because it was never in the
    denominator to begin with.
    """
    quiz = client.post("/api/quizzes", json={"title": "Install"}, headers=coach_headers).get_json()
    q1 = _mc(client, coach_headers, quiz["id"], "Q1")
    q2 = _mc(client, coach_headers, quiz["id"], "Q2")
    q3 = _mc(client, coach_headers, quiz["id"], "Q3")
    client.put(
        f"/api/quizzes/{quiz['id']}/roster",
        json={"players": [PLAYER, OTHER]},
        headers=coach_headers,
    )

    monday = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    _submit(
        client,
        monday,
        PLAYER,
        [
            {"question_id": q1["id"], "selected_option_id": _pick(q1, True), "answer_text": None},
            {"question_id": q2["id"], "selected_option_id": _pick(q2, False), "answer_text": None},
        ],
    )

    tuesday = client.post(
        f"/api/quizzes/{quiz['id']}/access-codes", json={}, headers=coach_headers
    ).get_json()
    _submit(
        client,
        tuesday,
        OTHER,
        [
            {"question_id": q1["id"], "selected_option_id": _pick(q1, True), "answer_text": None},
            {"question_id": q2["id"], "selected_option_id": _pick(q2, True), "answer_text": None},
            {"question_id": q3["id"], "selected_option_id": _pick(q3, False), "answer_text": None},
        ],
    )

    return {
        "quiz_id": quiz["id"],
        "q1": q1,
        "q2": q2,
        "q3": q3,
        "monday": monday,
        "tuesday": tuesday,
    }


def exclude(client, headers, quiz_id, question_id, access_code_id, reason=None):
    return client.post(
        f"/api/quizzes/{quiz_id}/questions/{question_id}/exclusions",
        json={"access_code_id": access_code_id, "reason": reason},
        headers=headers,
    )


def quiz_card_average(client, headers, quiz_id):
    """The SQL-computed number."""
    body = client.get("/api/quizzes", headers=headers).get_json()
    card = next(q for q in body if q["id"] == quiz_id)
    return card.get("average_score_percent")


def python_pooled_average(app, quiz_id):
    """The same figure computed the PYTHON way, for equivalence checking."""
    from app.services.scoring import NO_COUNTS

    with app.app_context():
        attempts = PlayerAttempt.query.filter_by(
            quiz_id=quiz_id, status=AttemptStatus.SUBMITTED
        ).all()
        exclusions = load_for_quizzes([quiz_id])
        total = NO_COUNTS
        for attempt in attempts:
            total = total + count_answers(exclusions.active_answers(attempt))
        return total.percent


# ---------------------------------------------------------------------------
# THE EQUIVALENCE CLASS - SQL spelling vs Python spelling
# ---------------------------------------------------------------------------


class TestSqlAndPythonAgree:
    """The duplication is approved because the SQL is ~2.6x faster at scale.
    These tests are what make it safe."""

    def test_they_agree_with_nothing_excluded(self, app, client, coach_headers, quiz3):
        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) == python_pooled_average(
            app, quiz3["quiz_id"]
        )

    def test_they_agree_when_an_answered_question_is_excluded(
        self, app, client, coach_headers, quiz3
    ):
        before = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).status_code == 201

        after_sql = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        assert after_sql != before, "excluding an answered question must move the number"
        assert after_sql == python_pooled_average(app, quiz3["quiz_id"])

    def test_they_agree_when_an_unanswered_question_is_excluded_and_nothing_moves(
        self, app, client, coach_headers, quiz3
    ):
        """THE CASE THE WHOLE DESIGN TURNS ON. Monday's player never answered
        Q3, so it was never in the denominator - excluding it must change
        nothing at all, in either spelling."""
        before = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q3"]["id"], quiz3["monday"]["id"]
        ).status_code == 201

        after = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        assert after == before
        assert after == python_pooled_average(app, quiz3["quiz_id"])

    def test_they_agree_on_quiz_wide_exclusion(self, app, client, coach_headers, quiz3):
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q1"]["id"], None
        ).status_code == 201
        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) == python_pooled_average(
            app, quiz3["quiz_id"]
        )

    def test_they_agree_after_a_restore(self, app, client, coach_headers, quiz3):
        before = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).get_json()

        client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore",
            headers=coach_headers,
        )

        after = quiz_card_average(client, coach_headers, quiz3["quiz_id"])
        assert after == before, "restore must return the EXACT previous value"
        assert after == python_pooled_average(app, quiz3["quiz_id"])

    def test_they_agree_on_an_overlapping_pair(self, app, client, coach_headers, quiz3):
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"])

        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) == python_pooled_average(
            app, quiz3["quiz_id"]
        )

    def test_they_agree_when_every_graded_answer_is_excluded(
        self, app, client, coach_headers, quiz3
    ):
        """Exclusion can empty the denominator. Both spellings must then report
        'no score yet', never 0%."""
        for question in ("q1", "q2", "q3"):
            exclude(client, coach_headers, quiz3["quiz_id"], quiz3[question]["id"], None)

        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) is None
        assert python_pooled_average(app, quiz3["quiz_id"]) is None


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------


class TestScope:
    def test_monday_does_not_touch_tuesday(self, app, client, coach_headers, quiz3):
        """The rule the default scope exists for."""
        with app.app_context():
            tuesday_attempt = PlayerAttempt.query.filter_by(
                access_code_id=quiz3["tuesday"]["id"]
            ).one()
            before = count_answers(tuesday_attempt.answers).percent

        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"])

        with app.app_context():
            exclusions = load_for_quizzes([quiz3["quiz_id"]])
            monday_attempt = PlayerAttempt.query.filter_by(
                access_code_id=quiz3["monday"]["id"]
            ).one()
            tuesday_attempt = PlayerAttempt.query.filter_by(
                access_code_id=quiz3["tuesday"]["id"]
            ).one()

            assert count_answers(exclusions.active_answers(tuesday_attempt)).percent == before
            assert len(exclusions.active_answers(monday_attempt)) == 1

    def test_quiz_wide_reaches_every_assignment(self, app, client, coach_headers, quiz3):
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q1"]["id"], None)

        with app.app_context():
            exclusions = load_for_quizzes([quiz3["quiz_id"]])
            for code_id in (quiz3["monday"]["id"], quiz3["tuesday"]["id"]):
                attempt = PlayerAttempt.query.filter_by(access_code_id=code_id).one()
                kept = {a.question_id for a in exclusions.active_answers(attempt)}
                assert quiz3["q1"]["id"] not in kept


# ---------------------------------------------------------------------------
# Overlap and restore
# ---------------------------------------------------------------------------


class TestOverlapAndRestore:
    def test_restoring_one_of_two_leaves_the_question_excluded(
        self, app, client, coach_headers, quiz3
    ):
        """The single most misleading thing this feature could do is say
        'restored' while the question still does not count."""
        wide = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None
        ).get_json()
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"])

        response = client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{wide['id']}/restore",
            headers=coach_headers,
        )
        assert response.status_code == 200
        body = response.get_json()

        assert body["restored"]["restored_at"] is not None
        # THE POINT: the response says what is still in force.
        assert len(body["still_excluded_by"]) == 1
        assert body["still_excluded_by"][0]["scope"] == "assignment"

        with app.app_context():
            exclusions = load_for_quizzes([quiz3["quiz_id"]])
            monday = PlayerAttempt.query.filter_by(access_code_id=quiz3["monday"]["id"]).one()
            assert exclusions.excludes(quiz3["q2"]["id"], monday.access_code_id)
            # ...but Tuesday, only covered by the restored quiz-wide rule, counts again.
            tuesday = PlayerAttempt.query.filter_by(access_code_id=quiz3["tuesday"]["id"]).one()
            assert not exclusions.excludes(quiz3["q2"]["id"], tuesday.access_code_id)

    def test_restoring_the_only_exclusion_reports_nothing_still_active(
        self, client, coach_headers, quiz3
    ):
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).get_json()

        body = client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore",
            headers=coach_headers,
        ).get_json()

        assert body["still_excluded_by"] == []

    def test_restore_never_deletes_the_row(self, app, client, coach_headers, quiz3):
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"],
            reason="wrong answer key",
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore",
            headers=coach_headers,
        )

        with app.app_context():
            row = db.session.get(QuestionExclusion, created["id"])
            assert row is not None
            assert row.restored_at is not None
            assert row.reason == "wrong answer key"
            assert row.coach_id is not None

    def test_restore_is_idempotent(self, app, client, coach_headers, quiz3):
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).get_json()
        url = (
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore"
        )
        first = client.post(url, headers=coach_headers).get_json()
        second = client.post(url, headers=coach_headers).get_json()

        assert first["restored"]["restored_at"] == second["restored"]["restored_at"]

    def test_a_question_can_be_excluded_again_after_being_restored(
        self, client, coach_headers, quiz3
    ):
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).get_json()
        client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore",
            headers=coach_headers,
        )

        again = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        )
        assert again.status_code == 201, "the partial index must only constrain ACTIVE rows"


# ---------------------------------------------------------------------------
# Database constraints
# ---------------------------------------------------------------------------


class TestUniqueIndexes:
    def test_duplicate_active_assignment_exclusion_is_rejected(
        self, client, coach_headers, quiz3
    ):
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).status_code == 201
        second = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        )
        assert second.status_code == 409
        assert second.get_json()["reason"] == "already_excluded"

    def test_duplicate_active_quiz_wide_exclusion_is_rejected(self, client, coach_headers, quiz3):
        """The case a single (question_id, access_code_id) index would MISS,
        because Postgres treats NULLs as distinct."""
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None
        ).status_code == 201
        second = exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)
        assert second.status_code == 409

    def test_the_quiz_wide_index_is_enforced_at_the_database(self, app, client, coach_headers, quiz3):
        """Belt-and-braces: prove the constraint exists in the schema rather
        than only in the route's error handling."""
        with app.app_context():
            question_id = quiz3["q2"]["id"]
            db.session.add(QuestionExclusion(question_id=question_id, access_code_id=None))
            db.session.commit()

            db.session.add(QuestionExclusion(question_id=question_id, access_code_id=None))
            with pytest.raises(IntegrityError):
                db.session.commit()
            db.session.rollback()

    def test_assignment_and_quiz_wide_may_coexist(self, client, coach_headers, quiz3):
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None
        ).status_code == 201
        assert exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).status_code == 201


# ---------------------------------------------------------------------------
# Security / tenancy
# ---------------------------------------------------------------------------


class TestTenancy:
    def test_a_coach_cannot_exclude_another_organizations_question(
        self, client, coach_headers, register_coach, quiz3
    ):
        _, _, other_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        response = exclude(
            client, other_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        )
        # 404, never 403 - an id must not be probeable.
        assert response.status_code == 404

    def test_an_access_code_from_another_quiz_is_rejected(self, client, coach_headers, quiz3):
        """Server-side scope validation. The frontend selector is not trusted:
        a tampered id pointing at a different quiz's assignment must not
        create a row that silently affects results elsewhere."""
        other_quiz = client.post(
            "/api/quizzes", json={"title": "Other"}, headers=coach_headers
        ).get_json()
        _mc(client, coach_headers, other_quiz["id"], "Other Q1")
        client.put(
            f"/api/quizzes/{other_quiz['id']}/roster",
            json={"players": [PLAYER]},
            headers=coach_headers,
        )
        other_code = client.post(
            f"/api/quizzes/{other_quiz['id']}/access-codes", json={}, headers=coach_headers
        ).get_json()

        response = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], other_code["id"]
        )
        assert response.status_code == 404

    def test_a_question_from_another_quiz_is_rejected(self, client, coach_headers, quiz3):
        other_quiz = client.post(
            "/api/quizzes", json={"title": "Other"}, headers=coach_headers
        ).get_json()
        foreign_question = _mc(client, coach_headers, other_quiz["id"], "Foreign")

        response = exclude(
            client, coach_headers, quiz3["quiz_id"], foreign_question["id"], quiz3["monday"]["id"]
        )
        assert response.status_code == 404

    def test_a_coach_cannot_restore_another_organizations_exclusion(
        self, client, coach_headers, register_coach, quiz3
    ):
        created = exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"]
        ).get_json()
        _, _, other_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )

        response = client.post(
            f"/api/quizzes/{quiz3['quiz_id']}/questions/{quiz3['q2']['id']}"
            f"/exclusions/{created['id']}/restore",
            headers=other_headers,
        )
        assert response.status_code == 404

    def test_the_assignment_list_is_scoped_to_the_caller(
        self, client, coach_headers, register_coach, quiz3
    ):
        _, _, other_headers = register_coach(
            username="rival", email="rival@example.com", organization="Rivals"
        )
        assert (
            client.get(f"/api/quizzes/{quiz3['quiz_id']}/assignments", headers=other_headers).status_code
            == 404
        )

        mine = client.get(
            f"/api/quizzes/{quiz3['quiz_id']}/assignments", headers=coach_headers
        )
        assert mine.status_code == 200
        assert {a["access_code_id"] for a in mine.get_json()} == {
            quiz3["monday"]["id"],
            quiz3["tuesday"]["id"],
        }


# ---------------------------------------------------------------------------
# Evidence preservation across the surfaces
# ---------------------------------------------------------------------------


class TestEvidenceIsPreserved:
    def test_no_answer_row_is_touched(self, app, client, coach_headers, quiz3):
        """Exclusion changes what is COUNTED, never what is STORED."""
        with app.app_context():
            before = {
                (a.attempt_id, a.question_id): a.is_correct for a in Answer.query.all()
            }

        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)

        with app.app_context():
            after = {(a.attempt_id, a.question_id): a.is_correct for a in Answer.query.all()}
        assert after == before

    def test_the_per_question_breakdown_keeps_its_raw_counts_and_marks_the_row(
        self, client, coach_headers, quiz3
    ):
        exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"],
            reason="ambiguous wording",
        )

        dashboard = client.get(
            f"/api/quizzes/{quiz3['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        row = next(
            q for q in dashboard["question_breakdown"] if q["question_id"] == quiz3["q2"]["id"]
        )

        assert row["is_excluded"] is True
        # THE EVIDENCE SURVIVES - usually the reason the coach excluded it.
        assert row["correct_count"] + row["incorrect_count"] == 2
        assert len(row["exclusions"]) == 1
        assert row["exclusions"][0]["scope"] == "assignment"
        assert row["exclusions"][0]["reason"] == "ambiguous wording"

    def test_the_csv_keeps_the_row_and_labels_it_excluded(self, client, coach_headers, quiz3):
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)

        raw = client.get(
            f"/api/quizzes/{quiz3['quiz_id']}/export.csv", headers=coach_headers
        ).get_data(as_text=True)
        rows = [r for r in csv.DictReader(io.StringIO(raw)) if r["Question"] == "Q2"]

        assert rows, "the excluded question's rows must NOT be dropped"
        for row in rows:
            assert row["Correct"] == "Excluded"
            # The player's actual answer is still there.
            assert row["Answer"] in {"Right", "Wrong"}

    def test_the_detailed_pdf_still_renders(self, client, coach_headers, quiz3):
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)
        response = client.get(
            f"/api/quizzes/{quiz3['quiz_id']}/export-detailed.pdf", headers=coach_headers
        )
        assert response.status_code == 200
        assert response.data.startswith(b"%PDF")


# ---------------------------------------------------------------------------
# Delivered / unanswered reporting
# ---------------------------------------------------------------------------


class TestDeliveredReporting:
    def test_an_excluded_question_stops_counting_as_unanswered(
        self, app, client, coach_headers, quiz3
    ):
        """Only the delivered-question path can express this - and it is the
        one thing exclusion needs snapshots-shaped information for."""
        from app.services.export import RESULT_UNANSWERED, _player_result_counts

        with app.app_context():
            monday = PlayerAttempt.query.filter_by(access_code_id=quiz3["monday"]["id"]).one()
            questions = sorted(
                Question.query.filter_by(quiz_id=quiz3["quiz_id"]).all(), key=lambda q: q.position
            )
            before, _ = _player_result_counts(questions, monday, NO_EXCLUSIONS)
            assert before[RESULT_UNANSWERED] == 1

        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q3"]["id"], quiz3["monday"]["id"])

        with app.app_context():
            monday = PlayerAttempt.query.filter_by(access_code_id=quiz3["monday"]["id"]).one()
            questions = sorted(
                Question.query.filter_by(quiz_id=quiz3["quiz_id"]).all(), key=lambda q: q.position
            )
            after, _ = _player_result_counts(
                questions, monday, load_for_quizzes([quiz3["quiz_id"]])
            )
            assert after[RESULT_UNANSWERED] == 0


# ---------------------------------------------------------------------------
# Player-facing
# ---------------------------------------------------------------------------


class TestPlayerResults:
    def test_the_player_sees_a_neutral_excluded_state_with_their_answer_intact(
        self, client, coach_headers, quiz3
    ):
        exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"],
            reason="my private note",
        )

        body = client.post(
            "/api/play/results",
            json={"code": quiz3["monday"]["code"], "player_name": PLAYER},
        ).get_json()
        answer = next(a for a in body["answers"] if a["question_text"] == "Q2")

        assert answer["is_excluded"] is True
        # Not right, not wrong.
        assert answer["is_correct"] is None
        # Their answer is preserved and still shown.
        assert answer["your_answer"] == "Wrong"
        # And the correct answer is withheld, so they cannot re-score it.
        assert answer["correct_answer"] is None

    def test_the_coachs_private_reason_never_reaches_a_player(self, client, coach_headers, quiz3):
        exclude(
            client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None,
            reason="I set the answer key wrong",
        )
        raw = client.post(
            "/api/play/results",
            json={"code": quiz3["monday"]["code"], "player_name": PLAYER},
        ).get_data(as_text=True)

        assert "I set the answer key wrong" not in raw
        assert "reason" not in raw

    def test_an_unexcluded_question_is_unaffected(self, client, coach_headers, quiz3):
        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], None)
        body = client.post(
            "/api/play/results",
            json={"code": quiz3["monday"]["code"], "player_name": PLAYER},
        ).get_json()

        q1 = next(a for a in body["answers"] if a["question_text"] == "Q1")
        assert q1["is_excluded"] is False
        assert q1["is_correct"] is True


# ---------------------------------------------------------------------------
# Legacy attempts
# ---------------------------------------------------------------------------


class TestLegacyAttempts:
    def test_an_attempt_with_no_snapshots_is_still_scored_correctly(
        self, app, client, coach_headers, quiz3
    ):
        """Exclusion filters ANSWER ROWS, so it needs no delivered history.
        A pre-Phase-1 attempt therefore gets a correct exclusion-aware score
        rather than being blocked or given invented content."""
        from app.models import AttemptQuestionSnapshot

        with app.app_context():
            monday = PlayerAttempt.query.filter_by(access_code_id=quiz3["monday"]["id"]).one()
            # Make it look like it predates delivered-question snapshots.
            AttemptQuestionSnapshot.query.filter_by(attempt_id=monday.id).delete()
            db.session.commit()
            assert AttemptQuestionSnapshot.query.filter_by(attempt_id=monday.id).count() == 0

        exclude(client, coach_headers, quiz3["quiz_id"], quiz3["q2"]["id"], quiz3["monday"]["id"])

        with app.app_context():
            monday = PlayerAttempt.query.filter_by(access_code_id=quiz3["monday"]["id"]).one()
            exclusions = load_for_quizzes([quiz3["quiz_id"]])
            counts = count_answers(exclusions.active_answers(monday))
            # Q1 right, Q2 excluded -> 1/1.
            assert counts.scored_total == 1
            assert counts.percent == 100.0

        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) == python_pooled_average(
            app, quiz3["quiz_id"]
        )


# ---------------------------------------------------------------------------
# The predicate itself
# ---------------------------------------------------------------------------


class TestExclusionSet:
    def test_quiz_wide_applies_to_every_assignment_including_none(self):
        s = ExclusionSet(quiz_wide=frozenset({7}), by_access_code={})
        assert s.excludes(7, 1)
        assert s.excludes(7, 99)
        assert s.excludes(7, None)

    def test_assignment_scope_needs_a_matching_code(self):
        s = ExclusionSet(quiz_wide=frozenset(), by_access_code={3: frozenset({9})})
        assert s.excludes(9, 3)
        assert not s.excludes(9, 4)
        # No assignment context - only a quiz-wide rule could apply.
        assert not s.excludes(9, None)

    def test_excluded_for_merges_both_scopes(self):
        s = ExclusionSet(quiz_wide=frozenset({7}), by_access_code={3: frozenset({9})})
        assert s.excluded_for(3) == frozenset({7, 9})
        assert s.excluded_for(4) == frozenset({7})

    def test_the_empty_set_excludes_nothing(self):
        assert NO_EXCLUSIONS.is_empty
        assert not NO_EXCLUSIONS.excludes(1, 1)


# ---------------------------------------------------------------------------
# Nothing excluded == nothing changed
# ---------------------------------------------------------------------------


class TestNoExclusionRegression:
    def test_an_empty_exclusion_table_changes_no_number(self, app, client, coach_headers, quiz3):
        """The deploy-day guarantee: with no exclusions, every surface reports
        exactly what it did before Phase 3."""
        with app.app_context():
            assert QuestionExclusion.query.count() == 0

        dashboard = client.get(
            f"/api/quizzes/{quiz3['quiz_id']}/dashboard", headers=coach_headers
        ).get_json()
        for row in dashboard["question_breakdown"]:
            assert row["is_excluded"] is False
            assert row["exclusions"] == []

        assert quiz_card_average(client, coach_headers, quiz3["quiz_id"]) == python_pooled_average(
            app, quiz3["quiz_id"]
        )

        body = client.post(
            "/api/play/results",
            json={"code": quiz3["monday"]["code"], "player_name": PLAYER},
        ).get_json()
        assert all(a["is_excluded"] is False for a in body["answers"])
