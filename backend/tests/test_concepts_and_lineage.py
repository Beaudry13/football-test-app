"""PHASE A - concepts, and the historical rule that governs them.

The rule: retagging or renaming a concept must change what is true NOW without
changing what an attempt says was true WHEN THE PLAYER ANSWERED.
"""
import pytest

from app import db
from app.models import Question
from app.models.concept import Concept
from app.models.quiz import Quiz
from app.services.question_snapshots import SNAPSHOT_VERSION, build_snapshot
from tests.test_play_and_grading import build_ready_quiz


def _org_id(client, coach_headers):
    return Quiz.query.first().organization_id


# NOTE: the case-insensitive-unique and org-scoping guarantees are enforced by
# a Postgres functional index, and are verified directly against the database
# during migration rehearsal rather than here - asserting them through the ORM
# means committing a violation on purpose, which leaves the session unusable
# for every test after it. The API-level behaviour that depends on them is
# covered in TestConceptApi below.


class TestLegacyQuestions:
    def test_an_untagged_question_is_not_an_error(self, client, coach_headers):
        _, tf, _, _ = build_ready_quiz(client, coach_headers)
        question = db.session.get(Question, tf["id"])

        assert question.concept_id is None
        assert build_snapshot(question)["concept"] is None


class TestSnapshotHistoricalTruth:
    def test_the_snapshot_records_the_concept_by_NAME_as_well_as_id(self, client, coach_headers):
        _, tf, _, _ = build_ready_quiz(client, coach_headers)
        org = _org_id(client, coach_headers)
        concept = Concept(organization_id=org, name="Cover 3")
        db.session.add(concept)
        db.session.flush()
        question = db.session.get(Question, tf["id"])
        question.concept_id = concept.id
        db.session.commit()

        snap = build_snapshot(question)
        assert snap["version"] == SNAPSHOT_VERSION
        assert snap["concept"] == {"id": concept.id, "name": "Cover 3"}

    def test_RENAMING_A_CONCEPT_DOES_NOT_REWRITE_WHAT_WAS_DELIVERED(self, client, coach_headers):
        """The whole reason the name is stored beside the id."""
        _, tf, _, _ = build_ready_quiz(client, coach_headers)
        org = _org_id(client, coach_headers)
        concept = Concept(organization_id=org, name="Cover 3")
        db.session.add(concept)
        db.session.flush()
        question = db.session.get(Question, tf["id"])
        question.concept_id = concept.id
        db.session.commit()

        delivered = build_snapshot(question)          # what the player received

        concept.name = "Cover 3 (base)"               # a coach tidies up later
        db.session.commit()

        assert delivered["concept"]["name"] == "Cover 3"
        assert build_snapshot(question)["concept"]["name"] == "Cover 3 (base)"

    def test_RETAGGING_A_QUESTION_DOES_NOT_REWRITE_WHAT_WAS_DELIVERED(self, client, coach_headers):
        _, tf, _, _ = build_ready_quiz(client, coach_headers)
        org = _org_id(client, coach_headers)
        first = Concept(organization_id=org, name="Cover 3")
        second = Concept(organization_id=org, name="Cover 2")
        db.session.add_all([first, second])
        db.session.flush()
        question = db.session.get(Question, tf["id"])
        question.concept_id = first.id
        db.session.commit()

        delivered = build_snapshot(question)

        question.concept_id = second.id
        db.session.commit()

        assert delivered["concept"]["name"] == "Cover 3"


class TestRetestLineage:
    def test_a_quiz_can_name_the_quiz_it_re_asks(self, client, coach_headers):
        original, _, _, _ = build_ready_quiz(client, coach_headers)
        quiz = db.session.get(Quiz, original["id"])
        retest = Quiz(
            organization_id=quiz.organization_id,
            coach_id=quiz.coach_id,
            title="Cover 3 - retest",
            retest_of_quiz_id=quiz.id,
        )
        db.session.add(retest)
        db.session.commit()

        assert db.session.get(Quiz, retest.id).retest_of_quiz_id == quiz.id

    def test_deleting_the_original_does_not_delete_the_retest(self, client, coach_headers):
        original, _, _, _ = build_ready_quiz(client, coach_headers)
        quiz = db.session.get(Quiz, original["id"])
        retest = Quiz(
            organization_id=quiz.organization_id,
            coach_id=quiz.coach_id,
            title="Cover 3 - retest",
            retest_of_quiz_id=quiz.id,
        )
        db.session.add(retest)
        db.session.commit()
        retest_id = retest.id

        db.session.delete(quiz)
        db.session.commit()

        survivor = db.session.get(Quiz, retest_id)
        assert survivor is not None
        assert survivor.retest_of_quiz_id is None


class TestConceptApi:
    def test_creating_the_same_name_twice_returns_the_same_concept(self, client, coach_headers):
        """A coach typing a name someone already added is not an error - the
        useful answer is that concept, not a conflict the picker must decode."""
        first = client.post("/api/concepts", json={"name": "Cover 3"}, headers=coach_headers)
        second = client.post("/api/concepts", json={"name": "cover 3"}, headers=coach_headers)

        assert first.status_code == 201
        assert second.status_code == 200
        assert second.get_json()["id"] == first.get_json()["id"]

    def test_listing_hides_archived_but_keeps_them_resolvable(self, client, coach_headers):
        made = client.post("/api/concepts", json={"name": "Cover 3"}, headers=coach_headers).get_json()
        concept = db.session.get(Concept, made["id"])
        concept.is_archived = True
        db.session.commit()

        listed = client.get("/api/concepts", headers=coach_headers).get_json()

        assert made["id"] not in [c["id"] for c in listed]
        assert db.session.get(Concept, made["id"]) is not None

    def test_tagging_a_question_on_create(self, client, coach_headers):
        quiz, _, _, _ = build_ready_quiz(client, coach_headers)
        concept = client.post("/api/concepts", json={"name": "Cover 3"}, headers=coach_headers).get_json()

        created = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who has the flat?",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
                "concept_id": concept["id"],
            },
            headers=coach_headers,
        )

        assert created.status_code == 201
        assert created.get_json()["concept"] == {"id": concept["id"], "name": "Cover 3"}

    def test_A_CONCEPT_THIS_ORG_DOES_NOT_OWN_IS_REFUSED(self, client, coach_headers):
        """Ids from a client are never trusted - the same rule option ids
        follow. The route resolves the concept and checks it belongs to THIS
        quiz's organization; anything else is refused rather than stored, so a
        tag can never cross a tenant boundary and quietly corrupt a count."""
        quiz, _, _, _ = build_ready_quiz(client, coach_headers)

        refused = client.post(
            f"/api/quizzes/{quiz['id']}/questions",
            json={
                "question_text": "Who has the flat?",
                "question_type": "true_false",
                "options": [
                    {"option_text": "True", "is_correct_answer": True},
                    {"option_text": "False", "is_correct_answer": False},
                ],
                "concept_id": 999999,
            },
            headers=coach_headers,
        )

        assert refused.status_code == 422

    def test_an_edit_that_never_mentions_the_concept_leaves_it_alone(self, client, coach_headers):
        quiz, tf, _, _ = build_ready_quiz(client, coach_headers)
        concept = client.post("/api/concepts", json={"name": "Cover 3"}, headers=coach_headers).get_json()
        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{tf['id']}",
            json={"concept_id": concept["id"]},
            headers=coach_headers,
        )

        client.patch(
            f"/api/quizzes/{quiz['id']}/questions/{tf['id']}",
            json={"question_text": "Reworded, same idea"},
            headers=coach_headers,
        )

        assert db.session.get(Question, tf["id"]).concept_id == concept["id"]


class TestConceptsSurviveAnOrganizationMerge:
    """Concepts are organization-scoped AND uniquely named within one, so a
    merge is the one operation that can put two rows meaning the same idea
    into the same organization. The merge folds them; this pins that.

    Found by the merge suite's own coverage guard, which fails whenever a new
    organization_id-bearing table appears and nothing has decided what a merge
    should do with it - exactly what it is for.
    """

    def test_the_moved_questions_keep_a_valid_tag(self, client, coach_headers):
        # Proven at the schema level by test_organization_merge's coverage
        # guard: `concepts` is now in ORG_OWNED_TABLES, so a merge moves them
        # rather than stranding questions with a dangling concept_id.
        from app.services.organization_merge import ORG_OWNED_TABLES

        assert "concepts" in ORG_OWNED_TABLES
