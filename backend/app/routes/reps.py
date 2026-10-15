"""Situational Rep: the coach's diagnostics and one-click Retest.

A Rep is an ordinary quiz with kind REP (see models/quiz.py), so creating,
editing, activating and playing one all go through the existing routes. Only
the two things a Rep adds live here:

  GET  /api/quizzes/<id>/rep-results   the football problems (services/rep_results)
  POST /api/quizzes/<id>/rep-retest    the missed concept, back out to the players
                                       who missed it - a new REP built from the
                                       same decisions, ready to send

RETEST REUSES THE QUIZ RETEST'S PARTS, not its rules. The copy (every field a
decision carries, its picture included) and the targeted roster are the very
helpers the quiz retest uses; only "who missed it" differs, because a Rep's
answers are practice-delivered first tries (services/rep_results), which the
graded retest rightly never reads.
"""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from marshmallow import Schema, fields

from app.errors import ApiError
from app.extensions import db
from app.models import Concept, Quiz
from app.models.quiz import REP_KIND
from app.routes.quizzes import _copy_questions_into, _retest_title, _seed_retest_roster
from app.services.file_storage import StorageError, get_file_storage
from app.services.rep_results import first_tries, rep_attempts, rep_results
from app.utils.auth import current_coach, get_visible_quiz
from app.utils.validation import load_json_body

reps_bp = Blueprint("reps", __name__)


def _visible_rep(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    if quiz.kind != REP_KIND:
        raise ApiError("That is not a Rep", status_code=422, reason="not_a_rep")
    return quiz


@reps_bp.get("/<int:quiz_id>/rep-results")
@jwt_required()
def get_rep_results(quiz_id: int):
    return jsonify(rep_results(_visible_rep(quiz_id)))


class RepRetestSchema(Schema):
    #: The football problem to send back out. None means the untagged
    #: ("General") decisions.
    concept_id = fields.Int(required=False, load_default=None, allow_none=True)


@reps_bp.post("/<int:quiz_id>/rep-retest")
@jwt_required()
def create_rep_retest(quiz_id: int):
    """A new Rep: this concept's decisions, for exactly the players who missed it.

    Built, not sent - the client activates it straight after (the ordinary
    activation route, with its own checks), so a Retest is one tap for the
    coach and still one rulebook for sending.
    """
    original = _visible_rep(quiz_id)
    coach = current_coach()
    data = load_json_body(RepRetestSchema())
    concept_id = data["concept_id"]

    in_concept = [
        q for q in original.questions if q.concept_id == concept_id and not q.is_retired
    ]
    if not in_concept:
        raise ApiError(
            "There are no decisions to send for that concept", status_code=422,
            reason="no_questions_to_retest",
        )
    ids = {q.id for q in in_concept}

    missed_attempts = []
    for attempt, _made in first_tries(rep_attempts(original)).values():
        if any(
            a.question_id in ids and a.checked_at is not None and a.is_correct is False
            for a in attempt.answers
        ):
            missed_attempts.append(attempt)
    if not missed_attempts:
        raise ApiError(
            "Nobody missed that, so there is nobody to retest", status_code=422,
            reason="nobody_missed",
        )

    concept = db.session.get(Concept, concept_id) if concept_id is not None else None
    title = _retest_title(concept, original) if concept is not None else f"{original.title} - Retest"
    retest = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=title[:255],
        kind=REP_KIND,
        one_question_at_a_time=True,
        require_all_answers=original.require_all_answers,
        folder_id=original.folder_id,
        retest_of_quiz_id=original.id,
    )
    db.session.add(retest)
    db.session.flush()

    storage = get_file_storage()
    copied_keys: list[str] = []
    try:
        _copy_questions_into(original, retest, storage, copied_keys, only_question_ids=ids)
        _seed_retest_roster(retest, missed_attempts, coach)
        db.session.commit()
    except StorageError as exc:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise ApiError(
            "Could not copy the Rep's pictures, so the retest was not created. Please try again.",
            status_code=502,
            reason="image_copy_failed",
        ) from exc
    except Exception:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise

    body = retest.to_dict()
    body["player_count"] = len(missed_attempts)
    return jsonify(body), 201
