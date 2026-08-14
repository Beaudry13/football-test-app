"""Coach endpoints for "don't count this question".

Nested under /api/quizzes/<quiz_id>/questions/<question_id>/exclusions so the
quiz is in the path and every route can re-verify it through the same
`get_editable_quiz` every other mutating coach route uses.

TENANCY IS CHECKED SERVER-SIDE, ON EVERY ID. The frontend sends a question id
and an access-code id; neither is trusted. The question must belong to the
named quiz, and the access code must belong to that SAME quiz - otherwise a
coach could scope an exclusion to another organization's assignment, or to a
different quiz's assignment, and quietly alter results they cannot even see.
404, never 403, matching app/utils/auth.py: an id must not be probeable.
"""

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from sqlalchemy.exc import IntegrityError

from app.errors import ApiError
from app.extensions import db
from app.models import AccessCode, Question, QuestionExclusion
from app.schemas.question_exclusion import ExclusionCreateSchema
from app.services.attempt_scope import official_filter
from app.services.question_exclusions import restore as restore_exclusion
from app.utils.auth import current_coach, get_editable_quiz
from app.utils.validation import load_json_body

question_exclusions_bp = Blueprint("question_exclusions", __name__)


def _question_in_quiz(quiz_id: int, question_id: int) -> Question:
    quiz = get_editable_quiz(quiz_id)
    question = Question.query.filter_by(id=question_id, quiz_id=quiz.id).first()
    if question is None:
        raise ApiError("Question not found", status_code=404)
    return question


def _validated_scope(quiz_id: int, access_code_id: int | None) -> int | None:
    """The assignment this exclusion applies to, or None for quiz-wide.

    An access code from ANOTHER QUIZ is rejected even when it belongs to the
    caller's own organization. Without this check a coach could scope an
    exclusion to an assignment that never delivered this question, producing a
    row that silently never matches - or, worse, one that matches a different
    quiz's attempts if the predicate were ever loosened.
    """
    if access_code_id is None:
        return None

    code = db.session.get(AccessCode, access_code_id)
    if code is None or code.quiz_id != quiz_id:
        raise ApiError("Assignment not found for this quiz", status_code=404)
    return code.id


@question_exclusions_bp.get("/<int:quiz_id>/questions/<int:question_id>/exclusions")
@jwt_required()
def list_exclusions(quiz_id: int, question_id: int):
    """Every exclusion ever recorded for this question, newest first.

    Restored ones are included: the audit trail is the point, and a coach
    looking at a question that behaved oddly should be able to see that it was
    excluded and put back last week.
    """
    question = _question_in_quiz(quiz_id, question_id)
    rows = (
        QuestionExclusion.query.filter_by(question_id=question.id)
        .order_by(QuestionExclusion.excluded_at.desc())
        .all()
    )
    # Coach-facing, so the reason is included - it is the coach's own note.
    return jsonify([row.to_dict(include_reason=True) for row in rows])


@question_exclusions_bp.post("/<int:quiz_id>/questions/<int:question_id>/exclusions")
@jwt_required()
def create_exclusion(quiz_id: int, question_id: int):
    """Stop counting this question, for one assignment or quiz-wide.

    Writes ONLY this row. No answer is edited, no grade is recomputed and
    nothing is deleted - every score that changes does so because the scoring
    surfaces filter on this row at read time, which is what makes the action
    reversible and auditable.
    """
    question = _question_in_quiz(quiz_id, question_id)
    data = load_json_body(ExclusionCreateSchema())
    access_code_id = _validated_scope(quiz_id, data["access_code_id"])
    coach = current_coach()

    exclusion = QuestionExclusion(
        question_id=question.id,
        access_code_id=access_code_id,
        coach_id=coach.id,
        reason=(data.get("reason") or None),
    )
    db.session.add(exclusion)
    try:
        db.session.commit()
    except IntegrityError as exc:
        # One of the two partial unique indexes. A coach double-clicking, or
        # two coaches acting at once, is a benign race - not an error worth a
        # 500. Converge on the exclusion that already exists.
        db.session.rollback()
        existing = QuestionExclusion.query.filter_by(
            question_id=question.id, access_code_id=access_code_id, restored_at=None
        ).first()
        if existing is None:
            raise
        raise ApiError(
            "This question is already excluded for that assignment.",
            status_code=409,
            reason="already_excluded",
            details={"exclusion": existing.to_dict(include_reason=True)},
        ) from exc

    return jsonify(exclusion.to_dict(include_reason=True)), 201


@question_exclusions_bp.post(
    "/<int:quiz_id>/questions/<int:question_id>/exclusions/<int:exclusion_id>/restore"
)
@jwt_required()
def restore(quiz_id: int, question_id: int, exclusion_id: int):
    """Put this question back into scoring.

    Sets `restored_at`; the row is never deleted, so both decisions stay on
    the record.

    THE RESPONSE REPORTS WHETHER THE QUESTION ACTUALLY COUNTS AGAIN. A question
    can be covered by a quiz-wide AND an assignment-scoped exclusion at once,
    and restoring one of them leaves the other in force. Returning a bare 204
    would let the UI claim the question is back when it is not - so the payload
    carries the exclusions that are still active.
    """
    question = _question_in_quiz(quiz_id, question_id)
    exclusion = QuestionExclusion.query.filter_by(
        id=exclusion_id, question_id=question.id
    ).first()
    if exclusion is None:
        raise ApiError("Exclusion not found", status_code=404)

    restore_exclusion(exclusion)
    db.session.commit()

    still_active = (
        QuestionExclusion.query.filter_by(question_id=question.id, restored_at=None)
        .order_by(QuestionExclusion.excluded_at.desc())
        .all()
    )
    return jsonify(
        {
            "restored": exclusion.to_dict(include_reason=True),
            # Empty means the question genuinely counts again.
            "still_excluded_by": [row.to_dict(include_reason=True) for row in still_active],
        }
    )


@question_exclusions_bp.get("/<int:quiz_id>/assignments")
@jwt_required()
def list_assignments(quiz_id: int):
    """The quiz's assignments, labelled well enough for a coach to pick one.

    THE PICKER PROBLEM. The Results tab pools every assignment of a quiz, so
    "this assignment" is ambiguous there and the coach has to choose - but a
    raw access-code id means nothing to them. This returns the metadata that
    already exists (code, activation date, mode, groups, attempt count) so the
    choice reads as "Monday's Group A" rather than "id 47". NO NEW SCHEMA was
    added for labelling; everything here is already stored.
    """
    quiz = get_editable_quiz(quiz_id)

    codes = (
        AccessCode.query.filter_by(quiz_id=quiz.id)
        .order_by(AccessCode.activated_at.desc())
        .all()
    )

    # One grouped count rather than a query per code.
    #
    # OFFICIAL ONLY. This number answers "how many results will excluding a
    # question here actually change", and practice attempts are scored nowhere
    # official - so counting them would advertise an assignment as affecting
    # twenty results when excluding a question there changes nothing a coach
    # can see. Routed through services/attempt_scope like every other reporting
    # count; a guard test in test_practice_mode fails if it is not.
    from app.models import AttemptStatus, PlayerAttempt

    counts = dict(
        db.session.query(PlayerAttempt.access_code_id, db.func.count(PlayerAttempt.id))
        .filter(
            PlayerAttempt.quiz_id == quiz.id,
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
            official_filter(),
        )
        .group_by(PlayerAttempt.access_code_id)
        .all()
    )

    return jsonify(
        [
            {
                "access_code_id": code.id,
                "code": code.code,
                "activated_at": code.activated_at.isoformat(),
                "is_active": code.is_active,
                "is_valid": code.is_valid(),
                "mode": code.mode,
                # The single most useful label a coach has: which group(s) it
                # went to. Empty means the quiz's own roster.
                "groups": [{"id": g.id, "name": g.name} for g in code.groups],
                "submitted_count": counts.get(code.id, 0),
            }
            for code in codes
        ]
    )
