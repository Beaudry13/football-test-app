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
from app.services.clip_storage import copy_clip_object, copy_poster_object
from app.extensions import db
from app.services.attempt_scope import official_filter
from app.models import (
    AccessCode,
    Answer,
    AttemptStatus,
    Concept,
    Group,
    Player,
    PlayerAttempt,
    Question,
    QuestionClip,
    QuestionImage,
    QuestionOption,
    QuestionRegion,
    Quiz,
    Roster,
    RosterPlayer,
)
from app.schemas.retest import RetestCreateSchema
from app.schemas.quiz import QuizCreateSchema, QuizUpdateSchema
from app.services.access_codes import (
    effective_roster_people_for_quiz,
    effective_roster_players,
    identity_key,
)
from app.services.player_identity import PlayerKey
from app.services.retests import eligible_players, questions_to_copy
from app.services.file_storage import StorageError, get_file_storage
from app.services.page_masking import attach_masked_media
from app.services.question_exclusions import sql_not_excluded
from app.services.question_snapshots import delivered_question_ids_for_quiz
from app.services.scoring import score_percent
from app.services.signed_media import AUDIENCE_COACH
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
        # Counted by identity, not by display name - see
        # effective_roster_people_for_quiz. Two players sharing a name are two
        # players, and a rename moves nobody in or out of a roster.
        roster_size = len(
            effective_roster_people_for_quiz(quiz, active_codes_by_quiz_id.get(quiz.id))
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
        #
        # Compared by identity: with two same-named players, one starting used
        # to remove both from this list, so a coach chasing the one who had not
        # started saw nobody. The attempts are already in hand here, so their
        # player_id costs no extra query.
        roster_people = effective_roster_players(code)
        started = {identity_key(a.player_id, a.player_name) for a in attempts}
        not_started = [
            person["name"]
            for person in roster_people
            if identity_key(person["player_id"], person["name"]) not in started
        ]

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
                # People, matching not_started above and the quiz card.
                "roster_size": len(roster_people),
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
    payload = _flag_delivered(
        quiz.to_dict(include_questions=True, include_correct_answers=True), quiz.id
    )
    # IF THE PLAYER WILL SEE IT, PREVIEW MUST SHOW IT.
    #
    # A region-backed question has no `question_images` row: the masked render
    # IS its picture. Without this, Preview built a player's screen from a
    # payload that had no picture in it at all and drew an empty card for every
    # playbook question - while the real attempt was fine, so the one surface a
    # coach uses to check a quiz before sending it was the only one lying.
    #
    # The URL resolves to the MASKED render - the same pixels the player gets,
    # with the answer already removed from them. No unmasked page and no source
    # PDF is reachable from any token, so this widens nothing. See
    # services/page_masking.attach_masked_media.
    attach_masked_media(payload, audience=AUDIENCE_COACH)
    return jsonify(payload)


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


@quizzes_bp.post("/<int:quiz_id>/retests")
@jwt_required()
def create_retest(quiz_id: int):
    """Assemble a targeted draft from the players who missed a concept.

    PEIRA ASSEMBLES; THE COACH SENDS. This creates an ordinary draft quiz and
    stops. It does not activate, does not generate a code, and does not notify
    anyone - the coach lands in the normal editor, changes whatever they want,
    and sends it themselves. There is no retest editor and no retest mode: a
    retest is a quiz that happens to know which quiz it came from.

    NOTHING THE CLIENT SENDS IS TRUSTED AS A SELECTION. The server recomputes
    both the eligible players and the missed questions from the recorded
    answers; the request can only NARROW those sets. A question the group did
    not miss cannot be copied, and a player who missed nothing cannot be
    targeted, however the request is shaped.
    """
    original = get_visible_quiz(quiz_id)
    coach = current_coach()
    data = load_json_body(RetestCreateSchema())

    concept = db.session.get(Concept, data["concept_id"])
    if concept is None or concept.organization_id != coach.organization_id:
        raise ApiError("That concept does not exist", status_code=422)

    # WHO ACTUALLY MISSED SOMETHING, recomputed here rather than believed.
    # Keyed by player identity, so a player who took the original through two
    # access codes is one target rather than two.
    eligible = eligible_players(original, concept.id)

    chosen: dict[PlayerKey, object] = {}
    for player_id in data["player_ids"]:
        # A CANONICAL PLAYER IS ONLY REACHABLE BY ID. Their name is not a key,
        # so a request cannot target them by typing it.
        attempt = eligible.get(PlayerKey(player_id=player_id, legacy_name=None))
        if attempt is None:
            # Covers both "not in this organization" and "did not miss
            # anything" with one refusal, because the client is entitled to
            # neither answer - and distinguishing them would tell an outsider
            # whether a given player id exists at all.
            raise ApiError(
                "One or more selected players are not eligible for this retest",
                status_code=422,
                reason="player_not_eligible",
            )
        chosen[PlayerKey(player_id=player_id, legacy_name=None)] = attempt
    for name in data["player_names"]:
        # And a free-text participant is only reachable by name, because that
        # is the only identity they have. The two namespaces never meet.
        attempt = eligible.get(
            PlayerKey(player_id=None, legacy_name=name.strip().casefold())
        )
        if attempt is None:
            raise ApiError(
                "One or more selected players are not eligible for this retest",
                status_code=422,
                reason="player_not_eligible",
            )
        chosen[PlayerKey(player_id=None, legacy_name=name.strip().casefold())] = attempt

    if not chosen:
        # Defaulting to "everyone who missed" would be a different, larger send
        # than the coach asked for. Refuse rather than guess.
        raise ApiError("Choose at least one player to retest", status_code=422)

    copyable, skipped_retired = questions_to_copy(original, concept.id, set(chosen))
    if data["question_ids"] is not None:
        requested = set(data["question_ids"])
        outside = requested - copyable
        if outside:
            raise ApiError(
                "One or more selected questions are not part of this retest",
                status_code=422,
                reason="question_not_eligible",
            )
        copyable = requested
    if not copyable:
        raise ApiError(
            "There are no questions to retest for this concept",
            status_code=422,
            reason="no_questions_to_retest",
        )

    storage = get_file_storage()
    copied_keys: list[str] = []

    retest = Quiz(
        organization_id=coach.organization_id,
        coach_id=coach.id,
        title=data["title"] or _retest_title(concept, original),
        one_question_at_a_time=original.one_question_at_a_time,
        require_all_answers=original.require_all_answers,
        folder_id=original.folder_id,
        # THE IMMEDIATE PARENT, not the root. This records what actually
        # happened - this quiz re-asked THAT one - and the root stays derivable
        # by walking up. A root pointer would lose the round order, which
        # nothing else records.
        retest_of_quiz_id=original.id,
    )
    db.session.add(retest)
    db.session.flush()

    try:
        _copy_questions_into(original, retest, storage, copied_keys, only_question_ids=copyable)
        _seed_retest_roster(retest, list(chosen.values()), coach)
        db.session.commit()
    except StorageError as exc:
        db.session.rollback()
        for key in copied_keys:
            try:
                storage.delete_image(key)
            except Exception:
                pass
        raise ApiError(
            "Could not copy this quiz's images, so the retest was not created. "
            "Please try again.",
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

    body = retest.to_dict(include_questions=True, include_correct_answers=True)
    # Named so the coach is TOLD rather than left to notice. A stopped question
    # was stopped because it was broken; copying it would put an undeliverable
    # question in the retest, and dropping it silently would leave a coach
    # wondering why the question count does not match what they missed.
    body["skipped_retired_questions"] = [
        {"id": q.id, "question_text": q.question_text} for q in skipped_retired
    ]
    return jsonify(body), 201


def _retest_title(concept, original) -> str:
    """"Force / Contain - Retest", then "- Retest 2", "- Retest 3".

    Retesting the same concept twice used to produce two quizzes with the same
    title, indistinguishable in the quiz list. The round is counted by walking
    the lineage rather than by counting a coach's quizzes, so a title always
    describes this chain: a retest of a retest is round 2 even if the coach
    built ten unrelated ones in between.
    """
    round_number = 1
    ancestor = original
    seen: set[int] = set()
    while ancestor is not None and ancestor.retest_of_quiz_id is not None:
        # Defensive: lineage is a chain by construction, but a cycle here would
        # hang the request rather than mislabel a quiz.
        if ancestor.id in seen:
            break
        seen.add(ancestor.id)
        round_number += 1
        ancestor = ancestor.retest_of
    suffix = "" if round_number == 1 else f" {round_number}"
    return f"{concept.name} - Retest{suffix}"


def _seed_retest_roster(retest, attempts, coach) -> None:
    """Put exactly the retested players on the new quiz's own roster.

    THIS IS THE TARGETING MECHANISM, and it needs no new schema. Eligibility
    for an activation is "the linked groups, or else the quiz's own Roster"
    (services/access_codes.effective_roster_names). A retest is a NEW quiz, so
    its roster can say precisely who it is for, and activating it with no
    groups then admits exactly those players and nobody else.

    Deliberately NOT a temporary Group: a group is a squad a coach maintains,
    and manufacturing "Force / Contain retest, Tuesday" into that list would
    leave real clutter behind after a single send.

    Canonical players are linked by player_id so verification can recognise
    them across rounds. An attempt that joined under a free-text name has no
    Player row and is carried as a legacy name - exactly how it joined the
    first time.
    """
    if retest.roster is None:
        retest.roster = Roster(quiz_id=retest.id)

    position = 0
    seen: set[PlayerKey] = set()
    for attempt in attempts:
        # ONE ROW PER IDENTITY. Deduplicating on the key rather than on
        # player_id-or-name separately: the previous shape let a second attempt
        # by an already-added canonical player fall through to the name branch
        # and be appended a second time as a free-text row.
        key = PlayerKey.of(attempt)
        if key in seen:
            continue
        seen.add(key)

        if key.is_canonical:
            player = db.session.get(Player, key.player_id)
            # A player deleted from the master roster since they answered
            # cannot be targeted canonically; their name still can.
            if player is not None and player.organization_id == coach.organization_id:
                retest.roster.players.append(
                    RosterPlayer(
                        player_id=player.id,
                        player_name=player.full_name,
                        position=position,
                    )
                )
                position += 1
                continue

        retest.roster.players.append(
            RosterPlayer(player_name=attempt.player_name, position=position)
        )
        position += 1


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


def _copy_questions_into(
    original,
    copy_quiz,
    storage,
    copied_keys: list[str],
    only_question_ids: set[int] | None = None,
) -> None:
    """Copy authored questions onto `copy_quiz`. Does not commit.

    Split out of the route so the whole copy sits inside one try/except that
    can undo both halves - the DB session and the storage objects.

    `only_question_ids` narrows the copy to a subset, which is how a retest
    reuses this rather than growing a second implementation of it. None means
    every question, which is what duplicate_quiz has always asked for.

    THE FILTER IS THE ONLY DIFFERENCE, deliberately. Everything a duplicated
    question carries - type, text, options and their correctness, expected
    answers, matching mode, explanation, allows_multiple_answers, retirement
    state, regions, the copied image with its annotations and canvas_width, and
    the concept - a retested question must carry identically. Two copy paths
    would mean the next field added to one of them silently missing from the
    other, which is exactly how the explanation and the expected answers were
    each lost once before.

    Positions are copied VERBATIM, so a subset inherits gaps from the original
    (copying questions 3 and 7 yields positions 3 and 7). That is already the
    normal state of a quiz - deleting a question never renumbers the rest - and
    every surface that shows a question number derives it by enumerating the
    sorted list rather than reading position + 1. Renumbering here would be the
    change, not the fix.
    """
    for question in original.questions:
        if only_question_ids is not None and question.id not in only_question_ids:
            continue
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
            # THE COPY IS ABOUT THE SAME THING THE ORIGINAL WAS ABOUT.
            #
            # This list is explicit, so anything not named here is silently
            # dropped - which is exactly how the explanation and the expected
            # answers above were each lost once before. A duplicated quiz that
            # arrived fully untagged would be worse than either: the coach sees
            # a complete-looking copy, and the concept counts it should have
            # fed simply never happen.
            #
            # Safe without an ownership check because duplication stays inside
            # one organization - the copy belongs to the coach who made it, in
            # their own org, and concepts are scoped to exactly that.
            concept_id=question.concept_id,
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

        if question.clip is not None:
            # ITS OWN STORAGE OBJECT, for exactly the reason the image above
            # gets one. Every delete path assumes a single owner, so a shared
            # key means the first destructive edit on either copy blanks the
            # other - proven in both directions for images before it was
            # fixed, and there is no reason to relearn it here.
            #
            # A failure raises and aborts the whole duplicate, matching the
            # image rule: a copy that silently drops its football material is
            # the failure this behaviour exists to prevent.
            copied_clip_key = copy_clip_object(question.clip.storage_key)
            copied_keys.append(copied_clip_key)
            copied_poster_key = copy_poster_object(question.clip.poster_key)
            if copied_poster_key:
                copied_keys.append(copied_poster_key)
            db.session.add(
                QuestionClip(
                    question_id=copy_question.id,
                    storage_key=copied_clip_key,
                    poster_key=copied_poster_key,
                    content_type=question.clip.content_type,
                    duration_ms=question.clip.duration_ms,
                    width=question.clip.width,
                    height=question.clip.height,
                    # CARRIED DELIBERATELY. The copy points at a byte-identical
                    # clip, so the frame the coach chose is the same frame -
                    # and a duplicate that silently played the whole play would
                    # hand the outcome to the next squad.
                    decision_point_ms=question.clip.decision_point_ms,
                )
            )
