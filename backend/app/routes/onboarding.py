"""The First Success checklist.

One endpoint, one rule set. The alternative - the frontend fetching quizzes,
players, groups and access codes and re-deriving "is this step done" for
itself - is four round trips and a second copy of rules that would drift
from these the first time either side changed. Everything here is a thin
wrapper over app/services/onboarding.py so the rules stay testable without
HTTP and so no page has to know how onboarding is computed.

Scoping is inherited, not reimplemented: coach-scoped facts go through
services/quiz_scope.owned_quiz_ids, the same own-only rule Coach View uses,
so the checklist can never tick a step off the back of a teammate's quiz.
"""

from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify
from flask_jwt_extended import jwt_required

from app.extensions import db
from app.services.onboarding import build_progress
from app.utils.auth import current_coach

onboarding_bp = Blueprint("onboarding", __name__)


@onboarding_bp.get("")
@jwt_required()
def get_onboarding():
    return jsonify(build_progress(current_coach()))


@onboarding_bp.post("/dismiss")
@jwt_required()
def dismiss_onboarding():
    """Hide the checklist before finishing it.

    Idempotent: dismissing twice keeps the first timestamp, because the
    question this column answers is "when did they turn it off", and a
    double-click on a slow connection should not rewrite that.
    """
    coach = current_coach()
    if coach.onboarding_dismissed_at is None:
        coach.onboarding_dismissed_at = datetime.now(timezone.utc)
        db.session.commit()
    return jsonify(build_progress(coach))


@onboarding_bp.delete("/dismiss")
@jwt_required()
def restore_onboarding():
    """Bring the checklist back, from the Help menu.

    Dismissal has to be reversible or it is a trap: a coach who hides the
    checklist on day one has no way back to it, and the steps they had not
    reached are simply lost.
    """
    coach = current_coach()
    if coach.onboarding_dismissed_at is not None:
        coach.onboarding_dismissed_at = None
        db.session.commit()
    return jsonify(build_progress(coach))
