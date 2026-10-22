"""Situational Rep: the coach's diagnostics and one-click Retest.

A Rep is an ordinary quiz with kind REP (see models/quiz.py), so creating,
editing, activating and playing one all go through the existing routes. Only
the two things a Rep adds live here:

  GET  /api/quizzes/<id>/rep-results   the football problems (services/rep_results)
  POST /api/quizzes/<id>/rep-retest    the missed concept, back out to the players
                                       who missed it - a new REP built from the
                                       same decisions, ready to send
  POST /api/quizzes/<id>/make-rep      an existing quiz's tap-an-answer questions
                                       as a new REP (existing content -> Rep)
  GET  /api/quizzes/reps-summary       the latest Reps, each with its worst
                                       football problem - what Home shows
  POST /api/quizzes/<rep>/add-decisions  questions from a quiz added to a Rep
                                       that already exists
  POST /api/quizzes/<rep>/rep-teach    a problem marked taught, so its next
                                       step is Retest for every coach
  GET  /api/quizzes/concept-history/<concept>  one problem over time: the
                                       trend, recent Reps, who still misses it

RETEST REUSES THE QUIZ RETEST'S PARTS, not its rules. The copy (every field a
decision carries, its picture included) and the targeted roster are the very
helpers the quiz retest uses; only "who missed it" differs, because a Rep's
answers are practice-delivered first tries (services/rep_results), which the
graded retest rightly never reads.
"""

import re
from datetime import datetime, timezone

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from marshmallow import Schema, fields, validate
from sqlalchemy.exc import IntegrityError

from app.errors import ApiError
from app.extensions import db
from app.models import Concept, Quiz, RepTeachMark
from app.models.rep_teach_mark import concept_key
from app.models.question import QuestionType
from app.models.quiz import REP_KIND
from app.routes.quizzes import _copy_questions_into, _retest_title, _seed_retest_roster
from app.services.file_storage import StorageError, get_file_storage
from app.services.rep_results import concept_history, first_tries, player_progress, rep_attempts, rep_results
from app.utils.auth import current_coach, get_visible_quiz
from app.utils.validation import load_json_body

reps_bp = Blueprint("reps", __name__)
#: The one player-facing Rep route (registered under /api/play): no JWT -
#: the player is proven the way every /play write proves him.
rep_play_bp = Blueprint("rep_play", __name__)


def _my_reps(coach):
    """The Reps a LIST shows this coach: his own. The same rule every quiz list
    follows (utils/auth.get_visible_quiz - lists are own-only for everyone), so
    Home never offers a Rep that would then refuse to open."""
    return Quiz.query.filter(
        Quiz.organization_id == coach.organization_id,
        Quiz.coach_id == coach.id,
        Quiz.kind == REP_KIND,
    )


def _visible_rep(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    if quiz.kind != REP_KIND:
        raise ApiError("That is not a Rep", status_code=422, reason="not_a_rep")
    return quiz


@reps_bp.get("/<int:quiz_id>/rep-results")
@jwt_required()
def get_rep_results(quiz_id: int):
    return jsonify(rep_results(_visible_rep(quiz_id)))


class RepTeachSchema(Schema):
    #: The problem taught. None means the untagged ("General") decisions.
    concept_id = fields.Int(required=False, load_default=None, allow_none=True)


@reps_bp.post("/<int:quiz_id>/rep-teach")
@jwt_required()
def mark_rep_taught(quiz_id: int):
    """TEACH, REMEMBERED: this problem has been taught on this Rep, so its
    next step is Retest - on every device, for every coach who opens it.
    Teaching it again moves the time and the coach forward."""
    quiz = _visible_rep(quiz_id)
    coach = current_coach()
    concept_id = load_json_body(RepTeachSchema())["concept_id"]
    if concept_id is not None:
        concept = db.session.get(Concept, concept_id)
        # Never trusted across a tenant boundary.
        if concept is None or concept.organization_id != quiz.organization_id:
            raise ApiError("That concept does not exist", status_code=422)
    key = concept_key(concept_id)
    for _ in range(2):
        mark = RepTeachMark.query.filter_by(quiz_id=quiz.id, concept_key=key).one_or_none()
        if mark is None:
            mark = RepTeachMark(quiz_id=quiz.id, concept_key=key, concept_id=concept_id)
            db.session.add(mark)
        mark.taught_by_coach_id = coach.id
        mark.taught_at = datetime.now(timezone.utc)
        try:
            db.session.commit()
            break
        except IntegrityError:
            # Two coaches taught it at the same moment: the other row won the
            # insert, so update that one instead.
            db.session.rollback()
    else:
        raise ApiError("Could not mark it taught. Try again.", status_code=409)
    return jsonify({"concept_key": key, "taught": mark.to_dict()})


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


#: What a Rep can judge on the spot: one tap, one right answer.
_TAP_TYPES = (QuestionType.MULTIPLE_CHOICE, QuestionType.TRUE_FALSE)


class MakeRepSchema(Schema):
    #: Narrow to these questions; absent means every tap-an-answer question.
    question_ids = fields.List(fields.Int(), required=False, load_default=None, allow_none=True)
    title = fields.Str(required=False, load_default=None, allow_none=True, validate=validate.Length(max=255))


@reps_bp.post("/<int:quiz_id>/make-rep")
@jwt_required()
def make_rep(quiz_id: int):
    """EXISTING CONTENT -> REP. A new Rep holding copies of a quiz's
    tap-an-answer questions (pictures, concepts and explanations travel), so a
    coach turns what he already wrote into a Rep in one tap. The quiz itself is
    untouched. Draw and written questions stay behind: a Rep judges on the
    spot, and they cannot be."""
    original = get_visible_quiz(quiz_id)
    coach = current_coach()
    data = load_json_body(MakeRepSchema())

    tappable = {
        q.id
        for q in original.questions
        if q.question_type in _TAP_TYPES and not q.allows_multiple_answers and not q.is_retired
    }
    chosen = tappable
    if data["question_ids"] is not None:
        requested = set(data["question_ids"])
        if requested - tappable:
            raise ApiError(
                "A Rep can only hold tap-an-answer questions (multiple choice or true/false)",
                status_code=422,
                reason="question_not_tappable",
            )
        chosen = requested
    if not chosen:
        raise ApiError(
            "This quiz has no tap-an-answer questions to make a Rep from",
            status_code=422,
            reason="no_tap_questions",
        )

    rep = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=(data["title"] or f"{original.title} - Rep")[:255],
        kind=REP_KIND,
        one_question_at_a_time=True,
        require_all_answers=False,
        folder_id=original.folder_id,
    )
    db.session.add(rep)
    db.session.flush()

    storage = get_file_storage()
    copied_keys: list[str] = []
    try:
        _copy_questions_into(original, rep, storage, copied_keys, only_question_ids=chosen)
        db.session.flush()
        _roles_from_words(rep.questions)
        db.session.commit()
    except StorageError as exc:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise ApiError(
            "Could not copy the pictures, so the Rep was not created. Please try again.",
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

    body = rep.to_dict()
    body["left_behind"] = len([q for q in original.questions if not q.is_retired]) - len(chosen)
    return jsonify(body), 201


#: How many Reps Home summarises. The Reps page has the rest.
HOME_REPS = 4


@reps_bp.get("/reps-summary")
@jwt_required()
def reps_summary():
    """THE NEXT USEFUL ACTION, FOR HOME: this coach's latest Reps, each
    with how many have run it and its worst football problem (if anyone
    missed anything). Computed by the same first-try rules as a Rep's page."""
    coach = current_coach()
    reps = (
        _my_reps(coach)
        .order_by(Quiz.updated_at.desc(), Quiz.id.desc())
        .limit(HOME_REPS)
        .all()
    )
    out = []
    for rep in reps:
        results = rep_results(rep)
        worst = next((c for c in results["concepts"] if c["missed"] > 0), None)
        # The worst problem nobody has retested yet - what "Next up" is for.
        open_problem = next((c for c in results["concepts"] if c["missed"] > 0 and not c.get("retest")), None)
        out.append(
            {
                "id": rep.id,
                "title": rep.title,
                "decisions": len(results["decisions"]),
                "ran": len(results["players"]),
                "invited": results["audience"]["invited"],
                "live": results["audience"]["code"] is not None,
                "audience_label": results["audience"]["label"],
                "audience_positions": results["audience"]["positions"],
                "is_retest": results["retest_of"] is not None,
                "worst": (
                    {
                        "name": worst["name"],
                        # For a deep link straight into Teach on this problem.
                        "concept_id": (worst["concept"] or {}).get("id"),
                        "missed": worst["missed"],
                        "responded": worst["responded"],
                        "most_common_wrong": (worst["most_common_wrong"] or {}).get("text"),
                    }
                    if worst
                    else None
                ),
                "signal": _signal(results, worst),
                "open_problem": (
                    {
                        "name": open_problem["name"],
                        "concept_id": (open_problem["concept"] or {}).get("id"),
                        "missed": open_problem["missed"],
                        "responded": open_problem["responded"],
                        # Taught already: Next up says Retest, the same as the Rep page.
                        "taught": open_problem.get("taught"),
                    }
                    if open_problem and results["retest_of"] is None
                    else None
                ),
            }
        )
    return jsonify(out)


def _pct(responded, missed):
    return round(100 * (responded - missed) / responded) if responded else None


def _signal(results, worst) -> dict | None:
    """THE ONE THING TO SAY ABOUT THIS REP ON HOME, when there is one:

      retest_fixed     "Motion adjustment - fixed on the retest"   (a retest: nobody misses it now)
      retest_missing   "Red zone check - still missed by 2 after the retest"
      improved / not   "Trips recognition 63% -> 91%" rides along on both
      retested         the original's worst problem already has a retest out:
                       say how that went instead of asking for another

    None when the plain worst problem (or nothing) is the whole story."""
    retest_of = results["retest_of"]
    if retest_of is not None:
        for c in results["concepts"]:
            if c["responded"] == 0:
                continue
            before = next((b for b in retest_of["concepts"] if b["name"] == c["name"]), None)
            pct_before = _pct(before["responded_before"], before["missed_before"]) if before and before["responded_before"] else None
            return {
                "kind": "retest_fixed" if c["missed"] == 0 else "retest_missing",
                "concept": c["name"],
                # Home's "Retest K" opens this Rep's retest for this problem.
                "concept_id": (c["concept"] or {}).get("id"),
                "missed": c["missed"],
                "responded": c["responded"],
                "before_pct": pct_before,
                "now_pct": _pct(c["responded"], c["missed"]),
            }
        return None
    if worst is not None and worst.get("retest"):
        again = worst["retest"]
        return {
            "kind": "retested",
            "concept": worst["name"],
            "concept_id": (worst["concept"] or {}).get("id"),
            "retest_id": again["id"],
            "missed": again["missed"],
            "responded": again["responded"],
            "before_pct": _pct(worst["responded"], worst["missed"]),
            "now_pct": _pct(again["responded"], again["missed"]),
        }
    return None


class RepProgressSchema(Schema):
    access_code_id = fields.Int(required=True)
    player_name = fields.Str(required=True, validate=validate.Length(min=1, max=255))
    player_id = fields.Int(required=False, allow_none=True, load_default=None)


@rep_play_bp.post("/rep-progress")
def rep_progress():
    """THE PLAYER'S OWN PROGRESS on this Rep, for his finish screen: his run
    before this one, and - on a Retest - what he missed on the original.

    Read-only, and proven exactly as checking an answer is: a live code, his
    own attempt on it, and (with PIN enforcement on) his attempt token. It
    returns only his own results, never anyone else's, and never a correct
    option - only counts and concept names.
    """
    from app.models import AccessCode
    from app.services import player_enforcement
    from app.services.access_codes import reason_for_invalid
    from app.services.attempts import find_attempt

    data = load_json_body(RepProgressSchema())
    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        message = "This access code has expired" if reason == "expired" else "Invalid access code"
        raise ApiError(message, status_code=404, reason=reason)
    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the rep first", status_code=404, reason="attempt_not_found")
    attempt = player_enforcement.authorize_player_write(access_code, attempt)
    quiz = access_code.quiz
    if quiz.kind != REP_KIND:
        raise ApiError("That is not a Rep", status_code=422, reason="not_a_rep")
    body = player_progress(quiz, attempt)
    # Releases the row lock enforcement may have taken; nothing was written.
    db.session.commit()
    return jsonify(body)


#: "You're the boundary safety. Draw your fit." -> "boundary safety"
_ROLE_IN_WORDS = re.compile(r"^\s*you(?:'|\u2019)re the ([^.?!]{1,60})[.?!]", re.IGNORECASE)


def _roles_from_words(questions) -> None:
    """A question that already says who the player is ("You're the Mike. ...")
    becomes a decision that knows it - no retyping the role."""
    for q in questions:
        if q.subject_role:
            continue
        match = _ROLE_IN_WORDS.match(q.question_text or "")
        if match:
            role = match.group(1).strip()
            q.subject_role = role[:1].upper() + role[1:]


class AddDecisionsSchema(Schema):
    from_quiz_id = fields.Int(required=True)
    question_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1))


@reps_bp.post("/<int:rep_id>/add-decisions")
@jwt_required()
def add_decisions(rep_id: int):
    """Questions from a quiz, added to a Rep that already exists - after its
    own decisions, with their pictures, concepts and reasons. Only questions a
    Rep can judge on the spot; the quiz is untouched."""
    from app.utils.auth import get_editable_quiz

    rep = get_editable_quiz(rep_id)
    if rep.kind != REP_KIND:
        raise ApiError("That is not a Rep", status_code=422, reason="not_a_rep")
    data = load_json_body(AddDecisionsSchema())
    source = get_visible_quiz(data["from_quiz_id"])
    tappable = {
        q.id
        for q in source.questions
        if q.question_type in _TAP_TYPES and not q.allows_multiple_answers and not q.is_retired
    }
    chosen = set(data["question_ids"])
    if chosen - tappable:
        raise ApiError(
            "A Rep can only hold tap-an-answer questions (multiple choice or true/false)",
            status_code=422,
            reason="question_not_tappable",
        )

    before = {q.id for q in rep.questions}
    start = max((q.position for q in rep.questions), default=-1) + 1
    storage = get_file_storage()
    copied_keys: list[str] = []
    try:
        _copy_questions_into(source, rep, storage, copied_keys, only_question_ids=chosen)
        db.session.flush()
        db.session.refresh(rep)
        added = sorted((q for q in rep.questions if q.id not in before), key=lambda q: (q.position, q.id))
        for offset, q in enumerate(added):
            q.position = start + offset
        _roles_from_words(added)
        db.session.commit()
    except StorageError as exc:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise ApiError(
            "Could not copy the pictures, so nothing was added. Please try again.",
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

    body = rep.to_dict()
    body["added"] = len(added)
    return jsonify(body), 201


@reps_bp.get("/reps-for-play/<int:play_id>")
@jwt_required()
def reps_for_play(play_id: int):
    """The Reps that already hold a decision made from this Motion Lab play,
    newest first - so Make rep can offer "the rep for this play" first."""
    from app.models import Question

    coach = current_coach()
    reps = (
        _my_reps(coach)
        .join(Question, Question.quiz_id == Quiz.id)
        .filter(Question.motion_play_id == play_id)
        .distinct()
        .order_by(Quiz.updated_at.desc(), Quiz.id.desc())
        .all()
    )
    return jsonify([{"id": r.id, "title": r.title, "question_count": len(r.questions)} for r in reps])


@reps_bp.get("/made-from-play/<int:play_id>")
@jwt_required()
def made_from_play(play_id: int):
    """WHAT HAVE I ALREADY MADE FROM THIS PLAY? This coach's quizzes and Reps
    holding a live question made from it, most recently made first, each with
    how many - and what he said the last time he made something from it (the
    concept, the man), so the next one starts there instead of from nothing.

    Own-only, like every quiz list (utils/auth.get_visible_quiz). Provenance
    only: a question's picture, answer and delivered snapshots are its own, so
    nothing here reads or changes the play, and nothing changes a question.
    """
    from app.models import Question

    coach = current_coach()
    rows = (
        db.session.query(Question, Quiz)
        .join(Quiz, Question.quiz_id == Quiz.id)
        .filter(
            Question.motion_play_id == play_id,
            Question.retired_at.is_(None),
            Quiz.organization_id == coach.organization_id,
            Quiz.coach_id == coach.id,
        )
        .order_by(Question.created_at.desc(), Question.id.desc())
        .all()
    )
    made: dict[int, dict] = {}
    for question, quiz in rows:
        entry = made.setdefault(
            quiz.id,
            {"id": quiz.id, "title": quiz.title, "kind": quiz.kind, "from_play": 0, "question_count": len(quiz.questions)},
        )
        entry["from_play"] += 1
    last = None
    if rows:
        question = rows[0][0]
        concept = question.concept if question.concept is not None and not question.concept.is_archived else None
        last = {
            "concept": {"id": concept.id, "name": concept.name} if concept else None,
            "subject_man": question.subject_man,
            "subject_role": question.subject_role,
        }
    return jsonify({"made": list(made.values()), "last": last})


#: How many recent Reps a concept trend reads. Enough for a season's arc,
#: small enough to stay a glance.
TREND_REPS = 20


@reps_bp.get("/concept-history/<int:concept_id>")
@jwt_required()
def get_concept_history(concept_id: int):
    """ONE FOOTBALL PROBLEM, OVER TIME - not a dashboard: its first-try trend
    across this coach's Reps that tested it (64% -> 67% -> 82%), the recent
    Reps, who is still missing it, and the next step from the latest Rep that
    tested it (taught? retested?)."""
    from app.models import Question

    coach = current_coach()
    concept = db.session.get(Concept, concept_id)
    if concept is None or concept.organization_id != coach.organization_id:
        raise ApiError("That concept does not exist", status_code=404)
    reps = (
        _my_reps(coach)
        .join(Question, Question.quiz_id == Quiz.id)
        .filter(Question.concept_id == concept_id)
        .distinct()
        .order_by(Quiz.created_at.desc(), Quiz.id.desc())
        .limit(TREND_REPS)
        .all()
    )
    history = concept_history(list(reversed(reps)), concept_id)
    latest = None
    if history["points"]:
        rep = db.session.get(Quiz, history["points"][-1]["rep_id"])
        here = next(
            (c for c in rep_results(rep)["concepts"] if (c["concept"] or {}).get("id") == concept_id), None
        )
        if here is not None:
            latest = {
                "rep_id": rep.id,
                "title": rep.title,
                "missed": here["missed"],
                "responded": here["responded"],
                "taught": here.get("taught"),
                "retest": here.get("retest"),
            }
    return jsonify(
        {
            "concept": {"id": concept.id, "name": concept.name, "is_archived": concept.is_archived},
            "points": history["points"],
            "recent": list(reversed(history["points"]))[:5],
            "still_missing": history["still_missing"],
            "latest": latest,
        }
    )


@reps_bp.get("/concept-trends")
@jwt_required()
def concept_trends():
    """IS IT GETTING BETTER? Per concept, across this coach's recent
    Reps (oldest first): first-try percent on the first Rep that tested it and
    on the latest, how many Reps tested it, and how many still missed it on the
    latest. Five, most recently tested first. A glance, not a dashboard."""
    from app.services.rep_results import _first_try_results

    coach = current_coach()
    reps = (
        _my_reps(coach)
        .order_by(Quiz.created_at.desc(), Quiz.id.desc())
        .limit(TREND_REPS)
        .all()
    )
    series: dict = {}
    for order, rep in enumerate(reversed(reps)):
        for c in _first_try_results(rep)["concepts"]:
            if c["responded"] == 0 or c["concept"] is None:
                continue
            series.setdefault(c["concept"]["id"], {"name": c["name"], "points": []})["points"].append(
                {"order": order, "rep_id": rep.id, "pct": _pct(c["responded"], c["missed"]), "missed": c["missed"]}
            )
    out = []
    for concept_id, entry in series.items():
        points = entry["points"]
        first, last = points[0], points[-1]
        out.append(
            {
                "concept_id": concept_id,
                "name": entry["name"],
                "reps": len(points),
                "first_pct": first["pct"],
                "last_pct": last["pct"],
                "last_missed": last["missed"],
                "last_rep_id": last["rep_id"],
                "_recent": last["order"],
            }
        )
    out.sort(key=lambda t: -t["_recent"])
    for t in out:
        del t["_recent"]
    return jsonify(out[:5])
