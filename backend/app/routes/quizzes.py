"""Quiz CRUD, duplication, and preview.

All routes are organization-scoped: any coach in the organization can read
a quiz, but only its creator or an org admin can change it. See
app/utils/auth.py for the tenancy rules.
"""

import copy
from collections import defaultdict
from datetime import datetime, timezone

from flask import Blueprint, jsonify
from flask_jwt_extended import jwt_required
from sqlalchemy import case, func
from sqlalchemy.orm import contains_eager, selectinload

from app.errors import ApiError
from app.extensions import db
from app.services.attempt_scope import official_filter
from app.models import (
    AccessCode,
    Answer,
    AttemptStatus,
    Group,
    PlayerAttempt,
    Question,
    QuestionImage,
    QuestionOption,
    QuestionRegion,
    Quiz,
    Roster,
)
from app.schemas.quiz import QuizCreateSchema, QuizUpdateSchema
from app.services.access_codes import effective_roster_names, effective_roster_names_for_quiz
from app.services.file_storage import StorageError, get_file_storage
from app.services.question_exclusions import sql_not_excluded
from app.services.question_snapshots import delivered_question_ids_for_quiz
from app.services.scoring import score_percent
from app.utils.auth import (
    current_coach,
    get_editable_quiz,
    get_org_folder,
    get_visible_quiz,
    own_quizzes_query,
)
from app.utils.validation import load_json_body

quizzes_bp = Blueprint("quizzes", __name__)


@quizzes_bp.get("")
@jwt_required()
def list_quizzes():
    coach = current_coach()
    # selectinload: to_dict() reads len(quiz.questions) for question_count,
    # and the roster-size stat below falls back to len(quiz.roster.players)
    # when a quiz has no active (or group-restricted) code - without
    # eager-loading both, each quiz would trigger its own lazy-load query
    # (N+1).
    # Own-only, for members AND admins. The organization-wide list is a
    # separate admin endpoint (/api/organizations/quizzes); there is
    # deliberately no parameter here that could widen this.
    quizzes = (
        own_quizzes_query(coach)
        .options(
            selectinload(Quiz.questions),
            selectinload(Quiz.coach),
            selectinload(Quiz.roster).selectinload(Roster.players),
        )
        .order_by(Quiz.updated_at.desc())
        .all()
    )

    # One query for every quiz's currently-active access code, instead of
    # walking each quiz's full access_codes history (which only grows over
    # time) or issuing a per-quiz query (N+1). Eager-loads .groups.players
    # so the group-aware roster-size stat below doesn't trigger a query per
    # quiz either. A quiz has at most one active code in practice
    # (reactivating deactivates the prior one), but nothing enforces that at
    # the DB level; keying by quiz_id and keeping whichever comes back last
    # for a given id is fine either way.
    quiz_ids = [q.id for q in quizzes]
    active_codes_by_quiz_id: dict[int, AccessCode] = {}
    if quiz_ids:
        active_codes = (
            AccessCode.query.filter(
                AccessCode.quiz_id.in_(quiz_ids),
                AccessCode.is_active.is_(True),
                AccessCode.expires_at > datetime.now(timezone.utc),
            )
            .options(selectinload(AccessCode.groups).selectinload(Group.players))
            .all()
        )
        active_codes_by_quiz_id = {code.quiz_id: code for code in active_codes}
    active_quiz_ids = set(active_codes_by_quiz_id)

    # Same batching discipline as is_active above: one query for every
    # quiz's completed-attempt count, and one more for the aggregate
    # correct/graded answer counts behind the "average score" stat -
    # counting only SUBMITTED attempts, matching quiz_dashboard's own
    # definition of "a response" so the two numbers never disagree.
    completed_counts: dict[int, int] = {}
    score_totals: dict[int, tuple[int, int]] = {}
    if quiz_ids:
        completed_counts = dict(
            db.session.query(PlayerAttempt.quiz_id, func.count(PlayerAttempt.id))
            .filter(
                PlayerAttempt.quiz_id.in_(quiz_ids),
                PlayerAttempt.status == AttemptStatus.SUBMITTED,
                # Response counts and average score are official numbers.
                official_filter(),
            )
            .group_by(PlayerAttempt.quiz_id)
            .all()
        )
        score_totals = {
            quiz_id: (int(correct or 0), int(graded or 0))
            for quiz_id, correct, graded in db.session.query(
                PlayerAttempt.quiz_id,
                func.sum(case((Answer.is_correct.is_(True), 1), else_=0)),
                func.sum(case((Answer.is_correct.isnot(None), 1), else_=0)),
            )
            .join(Answer, Answer.attempt_id == PlayerAttempt.id)
            .filter(
                PlayerAttempt.quiz_id.in_(quiz_ids),
                PlayerAttempt.status == AttemptStatus.SUBMITTED,
                # Response counts and average score are official numbers.
                official_filter(),
                # "Don't count this question", in SQL. This is the ONE place
                # the exclusion predicate is spelled twice - the Python
                # equivalent is ExclusionSet.excludes, and the two are locked
                # together by the equivalence tests in
                # tests/test_question_exclusions.py.
                #
                # It stays in SQL because this aggregate must not load every
                # answer of every attempt to divide two numbers: measured at
                # 75k answers, the anti-join costs ~33ms against ~88ms for the
                # Python counter, before ORM and network overhead.
                sql_not_excluded(PlayerAttempt, Answer),
            )
            .group_by(PlayerAttempt.quiz_id)
            .all()
        }

    def _quiz_dict(quiz: Quiz) -> dict:
        correct, graded = score_totals.get(quiz.id, (0, 0))
        # None (not 0%) when nothing's been graded yet - a brand-new quiz
        # shouldn't show a misleading "0% avg. score" before anyone's
        # answered anything gradeable. Quiz.to_dict then OMITS the key
        # entirely on None, which is what QuizCard.tsx's `!== undefined`
        # guard reads; do not "improve" that into an explicit null.
        #
        # Counted in SQL rather than in Python - this is the one aggregate
        # that must not load every answer of every attempt just to divide two
        # numbers - so it shares the FORMULA rather than the counter. The two
        # SUM(CASE ...) expressions above are the SQL spelling of
        # ScoreCounts.correct and ScoreCounts.scored_total.
        average_score_percent = score_percent(correct, graded)
        # Group-aware: if the quiz's active code is restricted to group(s),
        # that's who's actually eligible to submit, not the quiz's own
        # Roster - see effective_roster_names_for_quiz.
        roster_size = len(
            effective_roster_names_for_quiz(quiz, active_codes_by_quiz_id.get(quiz.id))
        )
        return quiz.to_dict(
            is_active=quiz.id in active_quiz_ids,
            completed_count=completed_counts.get(quiz.id, 0),
            roster_size=roster_size,
            average_score_percent=average_score_percent,
        )

    return jsonify([_quiz_dict(quiz) for quiz in quizzes])


@quizzes_bp.get("/active-status")
@jwt_required()
def active_status():
    """Live submitted/in-progress/not-started breakdown for every currently
    active access code in the org - what the dashboard's prominent
    active-quiz section polls. Keyed by access code, not quiz: nothing stops
    two codes on the same quiz both being active in principle (the
    retire-on-activate behavior in access_codes.py is app-level, not a DB
    constraint), so keying by code means that surfaces as two cards instead
    of silently colliding.

    Two queries total regardless of how many quizzes are simultaneously
    active - same batching discipline as list_quizzes' is_active computation
    above, just extended to also carry the roster/group data each card
    needs.
    """
    coach = current_coach()
    active_codes = (
        AccessCode.query.join(Quiz)
        .filter(
            Quiz.organization_id == coach.organization_id,
            # Same own-only scope as the dashboard list: an active quiz a coach
            # cannot open must not appear on their status board either.
            Quiz.coach_id == coach.id,
            AccessCode.is_active.is_(True),
            AccessCode.expires_at > datetime.now(timezone.utc),
        )
        .options(
            contains_eager(AccessCode.quiz).selectinload(Quiz.roster).selectinload(Roster.players),
            selectinload(AccessCode.groups).selectinload(Group.players),
        )
        .all()
    )

    attempts_by_code: dict[int, list[PlayerAttempt]] = defaultdict(list)
    if active_codes:
        code_ids = [c.id for c in active_codes]
        # DELIBERATELY NOT official_only. This board answers "who is doing the
        # thing I just sent", scoped to one access code - not "how did anybody
        # perform". Excluding practice here does not protect a number, it
        # blanks the card: a live practice code would show nobody submitted
        # and the whole roster not started, forever.
        #
        # Cross-mode contamination is impossible anyway because each attempt
        # is matched against its OWN code's mode below, so a graded card can
        # never absorb a practice attempt even if a code were re-moded after
        # attempts existed.
        modes_by_code = {c.id: c.mode for c in active_codes}
        for attempt in PlayerAttempt.query.filter(
            PlayerAttempt.access_code_id.in_(code_ids)
        ).all():
            if attempt.mode != modes_by_code[attempt.access_code_id]:
                continue
            attempts_by_code[attempt.access_code_id].append(attempt)

    result = []
    for code in active_codes:
        attempts = attempts_by_code[code.id]
        submitted = [
            {"player_name": a.player_name, "submitted_at": a.submitted_at.isoformat()}
            for a in attempts
            if a.status == AttemptStatus.SUBMITTED
        ]
        in_progress = [
            {"player_name": a.player_name, "started_at": a.started_at.isoformat()}
            for a in attempts
            if a.status == AttemptStatus.IN_PROGRESS
        ]
        # Ground truth is the attempt, not the roster snapshot - a coach can
        # edit a group's membership after players already started, and an
        # already-created attempt shouldn't vanish from view because of that
        # (same staleness tolerance _build_dashboard_data already documents
        # for its own missing_players list).
        roster_names = effective_roster_names(code)
        started_names = {a.player_name for a in attempts}
        not_started = [name for name in roster_names if name not in started_names]

        result.append(
            {
                "quiz_id": code.quiz_id,
                "quiz_title": code.quiz.title,
                "access_code_id": code.id,
                "code": code.code,
                "expires_at": code.expires_at.isoformat(),
                # So the live board can say plainly that this one is practice.
                # A "12 submitted" card that silently meant practice reps
                # would be read as twelve real results.
                "mode": code.mode,
                "is_practice": code.is_practice,
                # So the live board says how the code was set up, not just
                # what mode it is.
                "randomize_questions": code.randomize_questions,
                # Sorted so the "sent to" line doesn't visually reorder on a
                # background poll when nothing actually changed - a poll
                # that reorders things nobody touched reads as a bug.
                "group_names": sorted(g.name for g in code.groups),
                "roster_size": len(roster_names),
                "submitted": submitted,
                "in_progress": in_progress,
                "not_started": not_started,
            }
        )

    return jsonify(result)


@quizzes_bp.post("")
@jwt_required()
def create_quiz():
    coach = current_coach()
    data = load_json_body(QuizCreateSchema())

    quiz = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=data["title"],
        description=data["description"],
        one_question_at_a_time=data["one_question_at_a_time"],
        require_all_answers=data["require_all_answers"],
    )
    db.session.add(quiz)
    db.session.commit()
    return jsonify(quiz.to_dict()), 201


def _flag_delivered(payload: dict, quiz_id: int) -> dict:
    """Mark which questions players have already RECEIVED.

    Phase 4C's warning trigger. Attached here rather than in `Question.to_dict`
    because the model cannot answer it without a query per question, and this
    payload is the coach's editor - the one screen where an N+1 would be felt.

    Snapshot-based, deliberately: a question can be delivered and SKIPPED, and
    a coach correcting that question needs the warning just as much as one
    correcting a question people answered. See has_been_delivered.
    """
    delivered = delivered_question_ids_for_quiz(quiz_id)
    for question in payload.get("questions", []):
        question["has_been_delivered"] = question["id"] in delivered
    return payload


@quizzes_bp.get("/<int:quiz_id>")
@jwt_required()
def get_quiz(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    return jsonify(
        _flag_delivered(
            quiz.to_dict(include_questions=True, include_correct_answers=True), quiz.id
        )
    )


@quizzes_bp.patch("/<int:quiz_id>")
@jwt_required()
def update_quiz(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(QuizUpdateSchema())

    for field in ("title", "description", "one_question_at_a_time", "require_all_answers"):
        if field in data:
            setattr(quiz, field, data[field])

    if "folder_id" in data:
        if data["folder_id"] is None:
            quiz.folder_id = None
        else:
            quiz.folder_id = get_org_folder(data["folder_id"]).id

    db.session.commit()
    return jsonify(quiz.to_dict())


@quizzes_bp.delete("/<int:quiz_id>")
@jwt_required()
def delete_quiz(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    # DB-level cascade removes the question_images rows, but not the actual
    # files - those have to be cleaned up explicitly before the row goes away.
    #
    # NO SNAPSHOT PRESERVATION HERE, and that is not an oversight. Deleting a
    # quiz deletes its attempts, and an attempt takes its delivered-question
    # snapshots with it (ON DELETE CASCADE) - so there is no history left to
    # point at these images. The image routes are different: they destroy the
    # picture while the attempts that were shown it live on.
    storage = get_file_storage()
    for question in quiz.questions:
        if question.image:
            storage.delete_image(question.image.image_url)
    db.session.delete(quiz)
    db.session.commit()
    return "", 204


@quizzes_bp.post("/<int:quiz_id>/duplicate")
@jwt_required()
def duplicate_quiz(quiz_id: int):
    # Readable by anyone in the org, so a coach can start from a teammate's
    # quiz. The copy belongs to whoever duplicated it, not to the original
    # author - otherwise they'd end up unable to edit their own new copy.
    original = get_visible_quiz(quiz_id)
    coach = current_coach()

    storage = get_file_storage()
    # Every object this operation creates, so a failure can undo them. The DB
    # side is already all-or-nothing through the session; storage is not, and a
    # rollback that left copied assets behind would leak a file per attempt.
    copied_keys: list[str] = []

    copy_quiz = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=f"{original.title} (Copy)",
        description=original.description,
        one_question_at_a_time=original.one_question_at_a_time,
        require_all_answers=original.require_all_answers,
        folder_id=original.folder_id,
    )
    db.session.add(copy_quiz)
    db.session.flush()  # assign copy_quiz.id without committing

    try:
        _copy_questions_into(original, copy_quiz, storage, copied_keys)
        db.session.commit()
    except StorageError as exc:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        # A readable refusal rather than a 500. The coach can retry, and
        # crucially they are NOT handed a duplicate that is missing pictures.
        raise ApiError(
            "Could not copy this quiz's images, so the duplicate was not created. "
            "Please try again.",
            status_code=502,
            reason="image_copy_failed",
        ) from exc
    except Exception:
        # Order matters. Roll the DB back FIRST so nothing can observe rows
        # pointing at assets that are about to disappear, then remove the
        # objects this call created. delete_image is idempotent, and a failure
        # to clean up must not mask the original error.
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise

    return jsonify(copy_quiz.to_dict(include_questions=True, include_correct_answers=True)), 201


def _copy_questions_into(original, copy_quiz, storage, copied_keys: list[str]) -> None:
    """Copy every authored question onto `copy_quiz`. Does not commit.

    Split out of the route so the whole copy sits inside one try/except that
    can undo both halves - the DB session and the storage objects.
    """
    for question in original.questions:
        copy_question = Question(
            quiz_id=copy_quiz.id,
            question_text=question.question_text,
            question_type=question.question_type,
            position=question.position,
            # Without these a duplicated Fill in the Blank question would keep
            # its type but lose its answers, so every player would be marked
            # wrong - and the coach would have no way to see why.
            expected_answers=question.expected_answers,
            answer_matching=question.answer_matching,
            # The teaching material. It was silently dropped until a real coach
            # duplicated a quiz to work around not being able to edit a live
            # one, and every explanation vanished with no error anywhere.
            answer_explanation=question.answer_explanation,
            # THE COPY STARTS IN THE SAME STATE THE ORIGINAL IS IN. A coach
            # stops sending a question because it is wrong or unusable;
            # silently reactivating it in the duplicate would put that exact
            # question back in front of players, which is the failure this
            # feature exists to prevent. The copy stays fully visible and
            # editable with a one-click restore, so nothing is trapped.
            #
            # The original decision is copied verbatim, coach included: it
            # records who stopped sending this content, which is still true of
            # the copy.
            retired_at=question.retired_at,
            retired_by_coach_id=question.retired_by_coach_id,
            # A copy of a "select all that apply" question is still one. Losing
            # the flag would silently turn it into single-choice with several
            # options marked correct, which validation would then reject.
            allows_multiple_answers=question.allows_multiple_answers,
        )
        db.session.add(copy_question)
        db.session.flush()

        for option in question.options:
            db.session.add(
                QuestionOption(
                    question_id=copy_question.id,
                    option_text=option.option_text,
                    is_correct_answer=option.is_correct_answer,
                    position=option.position,
                )
            )

        for region in question.regions:
            # The rectangle is copied; the cached masked render deliberately is
            # not. It is derived data keyed to the original region, and letting
            # the copy point at it would mean deleting one question's mask
            # blanked the other's. It regenerates on first request.
            db.session.add(
                QuestionRegion(
                    question_id=copy_question.id,
                    document_page_id=region.document_page_id,
                    shape=region.shape,
                    x=region.x,
                    y=region.y,
                    width=region.width,
                    height=region.height,
                    role=region.role,
                    position=region.position,
                )
            )

        if question.image is not None:
            # ITS OWN STORAGE OBJECT, not a second reference to the original's.
            # Sharing one asset between two quizzes looks harmless until any
            # delete path runs: delete_quiz, and both the replace and delete
            # image routes, unlink the file outright because they assume a
            # single owner. The first destructive edit on either side then
            # blanked the other's images - proven in both directions.
            #
            # A copy failure raises, which aborts the whole duplicate. That is
            # deliberate: a duplicate that quietly drops a picture is the exact
            # failure being fixed, so it must not be the fallback.
            copied_url = storage.copy_image(question.image.image_url)
            copied_keys.append(copied_url)
            db.session.add(
                QuestionImage(
                    question_id=copy_question.id,
                    image_url=copied_url,
                    annotations=copy.deepcopy(question.image.annotations),
                    # The coordinate space those annotations were authored in.
                    # NULL means "assume the legacy 900px canvas", so dropping
                    # it silently MOVED every saved shape on the duplicate.
                    # Annotations and canvas_width only mean anything together.
                    canvas_width=question.image.canvas_width,
                )
            )
