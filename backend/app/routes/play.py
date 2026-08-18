"""Public, unauthenticated endpoints players use to take a quiz.

No player accounts exist: identity is (access code + a name chosen from
the coach-uploaded roster), which is exactly what every route here checks.

Attempt lifecycle: /start creates or resumes a PlayerAttempt the moment a
player picks their name; /answers autosaves one answer at a time against
it; /submit locks it. Every mutating route re-derives the attempt from
(access_code_id, player_name) rather than trusting a client-supplied
attempt id - the id is a guessable sequential PK, and the composite key is
exactly the same proof-of-eligibility a player already demonstrated by
holding a valid code and picking a roster-matched name.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import (
    AccessCode,
    Answer,
    AnswerSelectedOption,
    AttemptStatus,
    PlayerAttempt,
    Question,
    QuestionType,
)
from app.models.question_region import QuestionRegion
from app.models.answer_drawing import AnswerDrawing, document_has_strokes
from app.models.question import TEXT_ANSWER_TYPES
from app.services.signed_media import (
    KIND_QUESTION_MASK,
    audience_for_access_code,
    sign_media_token,
)
from app.schemas.play import (
    CheckAnswerSchema,
    PlayerResultsSchema,
    SaveAnswerSchema,
    SaveDrawingSchema,
    StartAttemptSchema,
    SubmitQuizSchema,
    ValidateCodeSchema,
)
from app.services.access_codes import (
    effective_roster_names,
    effective_roster_players,
    find_access_code_by_code,
    reason_for_invalid,
)
from app.services.attempts import (
    DrawingConflict,
    deliverable_questions,
    find_attempt,
    frozen_question_order,
    presented_question_ids,
    is_answered,
    is_checked,
    mark_checked,
    practice_feedback,
    upsert_answer,
    upsert_drawing,
)
from app.services.drawing_documents import validate_document
from app.services.delivered_questions import (
    delivered_by_question_id,
    delivered_questions,
    selection_text,
    to_player_payload,
)
from app.services.page_masking import attach_masked_media
from app.services.question_exclusions import load_for_quizzes
from app.services.question_snapshots import capture_attempt_snapshots
from app.utils.validation import load_json_body

play_bp = Blueprint("play", __name__)

NO_RESULTS_FOUND = "No results found for that code and name"
ALREADY_SUBMITTED = "This player has already submitted this Peira"


def _invalid_code_error(reason: str) -> ApiError:
    # not_found and deactivated share one message deliberately - telling a
    # caller which of the two applies would let them enumerate which codes
    # are real. expired gets its own calmer, specific message since knowing
    # a code *used to* work leaks nothing new (the player just had it).
    message = "This access code has expired" if reason == "expired" else "Invalid access code"
    return ApiError(message, status_code=404, reason=reason)


def _resolve_answer_text(question, answer: Answer | None) -> str | None:
    """What to print as the player's answer.

    `question` is a DeliveredQuestion, not the live row: asking the DELIVERED
    type which column to read is what stops a later question-type change from
    displaying a correctly-answered multiple-choice question as "No answer".
    """
    if answer is None:
        return None
    if question.question_type is QuestionType.DRAW_RESPONSE:
        # A drawing has no text form, and the player results page renders this
        # verbatim - returning None there printed "No answer" to a player who
        # had just spent a minute drawing one. Showing the drawing itself on
        # the player's own results page belongs with the coach viewer work in
        # Phase 4; until then this at least tells them the truth.
        if answer.drawing is not None and document_has_strokes(answer.drawing.document):
            return "Drawing submitted"
        return None
    if question.is_text_answered:
        return answer.answer_text
    # Looked up in the DELIVERED options, so an option whose text was edited
    # afterwards still reads as the player saw it - falling back to the live
    # option only when the snapshot never saw that id at all.
    #
    # A "Select all that apply" answer reads as its whole set, joined on one
    # line: "Mike; Nickel; Boundary Safety". Same resolver as the CSV and the
    # coach's view, so a player and a coach discussing one answer are reading
    # the same words in the same order.
    return selection_text(question, answer)


def _delivered_payload(attempt: PlayerAttempt) -> list[dict]:
    """THE ATTEMPT VERSION INVARIANT, enforced here.

    Once an attempt starts, it stays on the version it was delivered. A coach
    correcting the quiz afterwards changes what NEW attempts receive and
    nothing else - so a resumed attempt must be handed its own snapshot rather
    than today's live questions.

    This is the first moment the server knows WHICH attempt belongs to the
    caller: /validate-code is identity-free by construction (it returns the
    roster the player then picks from), so it cannot serve versioned content.
    That is why the delivered questions ride on /start rather than there.

    Region-backed questions are the one documented seam: their picture is a
    signed masked render minted per access code, and the snapshot does not
    record region geometry. The live masked URL is attached here, which is
    truthful only because region editing stays blocked after delivery.
    """
    live_by_id = {question.id: question for question in attempt.quiz.questions}
    # Which questions are region-backed, in ONE query. Touching
    # `question.regions` per question instead would be an N+1 on the hottest
    # player route - /play/start runs once per join for a whole team.
    region_question_ids = {
        question_id
        for (question_id,) in db.session.query(QuestionRegion.question_id)
        .join(Question, Question.id == QuestionRegion.question_id)
        .filter(Question.quiz_id == attempt.quiz_id)
        .all()
    }

    payload = []
    for delivered in delivered_questions(attempt, attempt.quiz):
        # A question hard-deleted after this attempt started leaves a snapshot
        # with question_id NULL. It cannot be answered (upsert_answer rejects
        # an id that is not on the quiz), so it is dropped from what the player
        # is asked rather than rendered as an unanswerable card. The historical
        # record of it survives untouched in the snapshot.
        if delivered.question_id is None:
            continue
        live = live_by_id.get(delivered.question_id)
        masked = None
        if live is not None and live.id in region_question_ids:
            token = sign_media_token(
                KIND_QUESTION_MASK,
                live.id,
                audience=audience_for_access_code(attempt.access_code_id),
            )
            masked = f"/api/media/{token}"
        payload.append(to_player_payload(delivered, masked_image_url=masked))
    return payload


def _drawings_by_answer_id(attempt: PlayerAttempt) -> dict:
    """Every stored drawing for this attempt, in ONE query.

    Walking `answer.drawing` in the loop below would lazy-load once per
    answer - an N+1 on the route a whole squad hits when they join.
    """
    answer_ids = [a.id for a in attempt.answers]
    if not answer_ids:
        return {}
    return {
        drawing.answer_id: drawing
        for drawing in AnswerDrawing.query.filter(
            AnswerDrawing.answer_id.in_(answer_ids)
        ).all()
    }


def _selections_by_answer_id(attempt: PlayerAttempt) -> dict:
    """Every stored selection for this attempt, in ONE query.

    Walking `answer.selected_options` per answer would be an N+1 on the route a
    whole squad hits when they join - the same trap the drawings loader above
    exists to avoid.
    """
    answer_ids = [a.id for a in attempt.answers]
    if not answer_ids:
        return {}
    rows = AnswerSelectedOption.query.filter(
        AnswerSelectedOption.answer_id.in_(answer_ids)
    ).all()
    grouped: dict[int, list] = {}
    for row in rows:
        grouped.setdefault(row.answer_id, []).append(row)
    return grouped


def _attempt_state(attempt: PlayerAttempt) -> dict:
    """Player-safe attempt payload for /start and /answers.

    Unlike PlayerAttempt.to_dict() (coach-facing, used by the grading
    routes), this never includes is_correct/coach_feedback/graded_at -
    matching validate-code's existing include_correct_answers=False rule,
    a player must not be able to learn which of their answers are correct
    before they submit, even though is_correct is now computed at autosave
    time rather than deferred to submit.
    """
    drawings = _drawings_by_answer_id(attempt)
    selections = _selections_by_answer_id(attempt)

    return {
        "attempt_id": attempt.id,
        "status": attempt.status.value,
        # The attempt's own frozen mode, not the code's current one - if a
        # coach edits the code mid-session the work already done keeps the
        # rules it was started under.
        "mode": attempt.mode,
        # The order this attempt was given, reconciled against the quiz as it
        # exists now. Returned on BOTH a fresh start and a resume, which is
        # what makes a refresh reproduce the identical sequence without the
        # client storing anything.
        #
        # Question DELIVERY stays in /validate-code - this is only the order
        # to arrange the already-loaded questions by, so the join flow is
        # untouched.
        "question_order": presented_question_ids(attempt, attempt.quiz),
        # WHAT THIS ATTEMPT RECEIVED, player-safe. Returned on both a fresh
        # start and a resume, so a refresh mid-quiz re-renders the delivered
        # version rather than picking up a correction made since. The client
        # prefers this over the live questions /validate-code handed it before
        # the player had identified themselves.
        "questions": _delivered_payload(attempt),
        "answers": [
            {
                "question_id": a.question_id,
                "selected_option_id": a.selected_option_id,
                # THE COMPLETE SET, so a refresh restores every box a player
                # ticked rather than one of them. Single-choice answers report
                # their one selection here too, so the client has a single
                # shape to read.
                "selected_option_ids": sorted(
                    s.option_id for s in selections.get(a.id, ())
                ),
                "answer_text": a.answer_text,
                # Practice lock state, so a reload restores a checked
                # question as checked instead of handing the player a second
                # attempt at it. Always false on a graded attempt.
                "checked": a.checked_at is not None,
                # THE SERVER-STORED DRAWING, so resuming does not depend on
                # this device's localStorage. Before this, a drawing was safe
                # on the server but invisible to a player who cleared their
                # browser or picked up a different phone.
                #
                # BUILT, not `to_dict()`d: that serialiser carries `id`,
                # `answer_id` and `preview_url`, which are storage details a
                # player has no use for. Same discipline as to_player_payload -
                # the safe shape is constructed rather than filtered.
                #
                # `revision` is the ordering mechanism for the resume
                # precedence rule. NO TIMESTAMP is sent, deliberately: device
                # clocks are unreliable, and the client must not be tempted to
                # decide "newer" by comparing them.
                "drawing": (
                    {
                        "document": drawings[a.id].document,
                        "revision": drawings[a.id].revision,
                    }
                    if a.id in drawings
                    else None
                ),
            }
            for a in attempt.answers
        ],
        # Feedback already earned, so a refresh mid-practice does not wipe the
        # explanations the player was reading. Recomputed rather than stored:
        # practice_feedback is the single definition of what a player is told.
        "feedback": (
            [practice_feedback(attempt, a) for a in attempt.answers if a.checked_at is not None]
            if attempt.is_practice
            else []
        ),
    }


@play_bp.post("/validate-code")
# Codes are 6 characters from a 31-character alphabet (~887M combinations).
# Without a limit here, that space is guessable by brute force. Every limit
# in this file is keyed per-IP (see app/extensions.py's Limiter key_func) -
# a real team joining together from one shared field/gym/school WiFi
# network shares one public IP, so this has to comfortably cover an entire
# roster (sized for up to 100 players, matching backend/loadtest's largest
# stage) joining within the same short window, not just one player. At
# 200/minute per IP, brute-forcing the code space would still take roughly
# 8 years - the anti-brute-force purpose is unaffected by this headroom.
@limiter.limit("200 per minute")
def validate_code():
    data = load_json_body(ValidateCodeSchema())

    normalized_code = data["code"].strip().upper()
    access_code = AccessCode.query.filter_by(code=normalized_code).first()
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    quiz = access_code.quiz
    quiz_payload = quiz.to_dict(include_questions=True, include_correct_answers=False)
    attach_masked_media(quiz_payload, audience=audience_for_access_code(access_code.id))

    return jsonify(
        {
            "access_code_id": access_code.id,
            "expires_at": access_code.expires_at.isoformat(),
            # So the player is told, before they start, that this one is
            # practice and will not be graded.
            "mode": access_code.mode,
            "quiz": quiz_payload,
            "roster_players": effective_roster_names(access_code),
            # Additive, not a replacement for roster_players above (kept
            # unchanged for backward compatibility) - carries player_id
            # alongside each name so the frontend can distinguish two
            # canonical Players who share a display name, and submit the
            # right one back on /start. See effective_roster_players.
            "roster_players_v2": effective_roster_players(access_code),
        }
    )


@play_bp.post("/start")
# Once per name-selection (not per answer), so the same rate as
# validate-code/submit is the right ballpark - see validate-code's comment
# for why this needs to cover a whole team on one shared IP, not one player.
@limiter.limit("200 per minute")
def start_attempt():
    data = load_json_body(StartAttemptSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    player_id = data.get("player_id")
    if player_id is not None:
        # Never trust a client-supplied player_id as proof of eligibility on
        # its own - it must actually be one of this activation's effective
        # roster entries (same check `effective_roster_names` + membership
        # already enforces for a legacy name). Rejects both a genuinely
        # unrelated player_id and one belonging to another organization.
        canonical_ids = {p["player_id"] for p in effective_roster_players(access_code) if p["player_id"]}
        if player_id not in canonical_ids:
            raise ApiError("Player is not on this quiz's roster", status_code=422)
    else:
        roster_names = set(effective_roster_names(access_code))
        if data["player_name"] not in roster_names:
            raise ApiError("Player name is not on this quiz's roster", status_code=422)

    # SAFETY NET. If this activation's roster knows the chosen name as
    # exactly one canonical player, the attempt must carry that id - even
    # when the client omitted it (an older cached bundle, or a hand-made
    # request). An attempt with player_id NULL is invisible to the player
    # profile and the cumulative report, so losing it here silently costs a
    # coach the result of a quiz they watched somebody take.
    #
    # Derived from THIS ACTIVATION'S ROSTER, never guessed from the name at
    # large: the candidates come from `effective_roster_players`, and a name
    # matching two of them is left alone rather than resolved - picking one
    # would attribute a real player's score to someone else.
    if player_id is None:
        wanted = data["player_name"].strip().casefold()
        canonical = [
            entry["player_id"]
            for entry in effective_roster_players(access_code)
            if entry["player_id"] is not None and entry["name"].strip().casefold() == wanted
        ]
        if len(canonical) == 1:
            player_id = canonical[0]

    existing = find_attempt(access_code.id, data["player_name"], player_id)
    if existing is not None:
        if existing.status == AttemptStatus.SUBMITTED:
            # Practice is unlimited: a finished practice attempt is history,
            # not a blocker, so "Try Again" simply starts a new one. Graded
            # still refuses, and the database still enforces that through the
            # partial unique indexes.
            if not access_code.is_practice:
                raise ApiError(ALREADY_SUBMITTED, status_code=409)
        else:
            return jsonify(_attempt_state(existing))

    # NO ZERO-QUESTION ATTEMPTS. Placed deliberately AFTER the resume branch
    # above: an attempt already underway is never affected by retirement, so it
    # must be handed back before this can refuse anything.
    #
    # Activation checks the same thing, but activation is not enough on its own
    # - a code activated BEFORE the last question was stopped is still live, and
    # nothing revokes it.
    #
    # THIS IS NOT MERELY TIDY. `delivered_questions()` treats "zero snapshot
    # rows" as "pre-Phase-1 attempt" and falls back to the LIVE quiz. An
    # attempt legitimately delivered nothing would therefore render the live
    # quiz - retired questions included - which is the exact opposite of what
    # retirement means. Refusing here is what keeps "zero rows = legacy" true.
    # See docs/DESIGN-question-retirement.md §12.
    if not deliverable_questions(access_code.quiz):
        raise ApiError(
            "This Peira has no questions to send right now. Ask your coach.",
            status_code=422,
            reason="no_deliverable_questions",
        )

    attempt = PlayerAttempt(
        quiz_id=access_code.quiz_id,
        access_code_id=access_code.id,
        player_name=data["player_name"],
        player_id=player_id,
        # Copied from the code, never from the request. A player cannot ask
        # for an attempt to be practice, or for a practice attempt to count -
        # the assignment decides, and this freezes that decision so a later
        # edit to the code cannot reclassify work already done.
        mode=access_code.mode,
        # Shuffled ONCE, here, and never again. Graded attempts always get
        # None, so graded ordering is unchanged by construction rather than by
        # a filter somebody could forget to apply.
        question_order=frozen_question_order(
            access_code.quiz,
            randomize=access_code.is_practice and access_code.randomize_questions,
        ),
    )
    db.session.add(attempt)
    try:
        # Flushed, not committed, so the snapshot rows below join the SAME
        # transaction as the attempt they describe. Starting an attempt and
        # recording what it was delivered are one operation or neither.
        db.session.flush()
        capture_attempt_snapshots(attempt)
        db.session.commit()
    except IntegrityError:
        # Two concurrent "start" calls for the same name is a benign race
        # (e.g. a fast double-tap), not a genuine conflict - converge to
        # whichever one won instead of erroring.
        db.session.rollback()
        existing = find_attempt(access_code.id, data["player_name"], player_id)
        if existing is None:
            raise
        if existing.status == AttemptStatus.SUBMITTED:
            raise ApiError(ALREADY_SUBMITTED, status_code=409) from None
        return jsonify(_attempt_state(existing))
    except Exception as exc:
        # A NEW attempt must never become "legacy" because a write failed.
        # There is no backfill for a missing snapshot - a partially recorded
        # attempt would be indistinguishable, forever, from one that predates
        # the table - so an incomplete record fails the start outright rather
        # than handing the player a quiz whose delivery nobody wrote down.
        db.session.rollback()
        raise ApiError(
            "Could not start this Peira. Please try again.",
            status_code=500,
            reason="attempt_not_recorded",
        ) from exc

    return jsonify(_attempt_state(attempt)), 201


@play_bp.post("/answers")
# Fires once per answer change (debounced/blur-triggered client-side, plus
# an immediate save on every option pick), not once per session like
# /start or /submit, so this needs a higher ceiling than those even before
# accounting for shared-IP headroom (see validate-code's comment) - up to
# ~100 players each autosaving several answers within the same short
# window, all from one IP, easily exceeds a single-player-sized budget.
@limiter.limit("1000 per minute")
def save_answer():
    data = load_json_body(SaveAnswerSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        # Same check /submit already makes - without it a player could
        # autosave indefinitely past expiry, only discovering the code
        # expired at final submit instead of the moment it actually does.
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before saving an answer", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        # The hard lock: once submitted, no further edits.
        raise ApiError("This attempt has already been submitted", status_code=409)

    if attempt.is_practice and is_checked(attempt, data["question_id"]):
        # PRACTICE LOCK, enforced here rather than in the client. The player
        # has been shown the verdict and the coach's explanation for this
        # question; letting them rewrite the answer afterwards would turn the
        # teaching material into a way to score. Their next retake is a fresh
        # attempt with every question open again.
        raise ApiError(
            "This answer is locked for this practice attempt",
            status_code=409,
            reason="practice_answer_locked",
        )

    upsert_answer(
        attempt,
        data["question_id"],
        data["selected_option_id"],
        data["answer_text"],
        data.get("selected_option_ids"),
    )
    db.session.commit()
    # Identical shape in both modes: correctness is revealed by /check, never
    # by an autosave. A practice player who has not pressed Check Answer yet
    # must not be able to learn the verdict by watching the network tab.
    return "", 204


@play_bp.post("/check")
# Once per question rather than per keystroke, so a whole team working
# through a practice quiz on one shared IP still fits comfortably - see
# validate-code's comment for why these budgets are roster-sized.
@limiter.limit("600 per minute")
def check_answer():
    """Practice only: reveal how the player did on one question and lock it.

    Deliberately separate from autosave. Autosave answers "is my work safe";
    this answers "how did I do", and the two must not be the same request -
    a player mid-typing should never be shown a verdict they did not ask for,
    and a graded attempt must have no route that reveals one at all.
    """
    data = load_json_body(CheckAnswerSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before checking an answer", status_code=404)
    if not attempt.is_practice:
        # The attempt's frozen mode decides, not the code's current one. There
        # is no path from a graded attempt to a correct-answer reveal.
        raise ApiError("This quiz is graded - answers are checked by your coach", status_code=422)
    if attempt.status == AttemptStatus.SUBMITTED:
        raise ApiError("This attempt has already been submitted", status_code=409)

    answer = mark_checked(attempt, data["question_id"])
    db.session.commit()
    return jsonify(practice_feedback(attempt, answer)), 200


def _reject_drawing_bound_to_another_image(attempt, question_id, document) -> None:
    """A drawing must belong to the picture THIS attempt was delivered.

    PHASE A. `source.image_id` is authored on the client, and before this the
    client read it from the LIVE question - so a coach replacing the image
    mid-attempt could produce a drawing whose strokes were made on one picture
    while claiming another. Nothing downstream would ever notice: the coach's
    viewer renders the delivered image and the stored strokes side by side and
    trusts that they belong together.

    The delivered snapshot already records which image was sent. This makes
    that record ENFORCED rather than merely available, which is what turns
    "drawing + delivered image + delivered coordinate space" from a convention
    into an invariant.

    Silent on legacy data BY DESIGN. A snapshot written before Phase A has no
    `image_id`, and a pre-Phase-1 attempt has no snapshot at all. `None` means
    "not recorded", never "matches anything" - so those attempts keep working
    exactly as they did, and no history is invented for them.
    """
    delivered = delivered_by_question_id(attempt, attempt.quiz).get(question_id)
    if delivered is None or delivered.image is None:
        return
    if delivered.image.image_id is None:
        return

    claimed = (document.get("source") or {}).get("image_id")
    # Compared as strings: the document carries it as a string (it is a client
    # -authored JSON field), the snapshot as an int.
    if str(claimed) != str(delivered.image.image_id):
        raise ApiError(
            "This drawing was made on a different version of the image. "
            "Reload the page and try again.",
            status_code=409,
            reason="drawing_image_mismatch",
        )


@play_bp.put("/drawing")
# Same per-IP budget as the text autosave: a whole team drawing at once must
# not trip it, and a drawing save is debounced far more heavily than a
# keystroke, so the request rate per player is lower than /answers.
@limiter.limit("300 per minute")
def save_drawing():
    """Autosave one Draw Response answer.

    The server becomes authoritative here, but the client keeps its local
    draft: this endpoint failing must never be the difference between a
    player having their drawing and losing it.
    """
    data = load_json_body(SaveDrawingSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    # Re-derived, never trusted from the client - the same rule every mutating
    # /play route follows.
    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before saving a drawing", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        raise ApiError("This attempt has already been submitted", status_code=409)
    if attempt.is_practice and is_checked(attempt, data["question_id"]):
        # Same lock as a text answer. A drawing autosaves continuously, so
        # without this a player could keep editing after reading the
        # explanation - which is exactly what checking is meant to close.
        raise ApiError(
            "This drawing is locked for this practice attempt",
            status_code=409,
            reason="practice_answer_locked",
        )

    document = validate_document(data["document"])
    _reject_drawing_bound_to_another_image(attempt, data["question_id"], document)

    try:
        drawing = upsert_drawing(attempt, data["question_id"], document, data["base_revision"])
    except DrawingConflict as conflict:
        db.session.rollback()
        # 409 with the current revision, so the client can tell the player
        # their drawing was changed elsewhere rather than silently discarding
        # one of the two versions.
        raise ApiError(
            "This drawing was updated on another device",
            status_code=409,
            reason="stale_revision",
        ) from conflict

    db.session.commit()
    return jsonify({"revision": drawing.revision, "updated_at": drawing.updated_at.isoformat()}), 200


@play_bp.post("/submit")
# See validate-code's comment - keyed per-IP, needs to cover a whole team
# submitting within the same short window, not one player.
@limiter.limit("200 per minute")
def submit_quiz():
    data = load_json_body(SubmitQuizSchema())

    access_code = db.session.get(AccessCode, data["access_code_id"])
    reason = reason_for_invalid(access_code)
    if reason is not None:
        raise _invalid_code_error(reason)

    attempt = find_attempt(access_code.id, data["player_name"], data.get("player_id"))
    if attempt is None:
        raise ApiError("Start the quiz before submitting", status_code=404)
    if attempt.status == AttemptStatus.SUBMITTED:
        raise ApiError(ALREADY_SUBMITTED, status_code=409)

    submitted_question_ids = [a["question_id"] for a in data["answers"]]
    if len(submitted_question_ids) != len(set(submitted_question_ids)):
        raise ApiError("Each question can only be answered once per submission", status_code=422)

    if access_code.quiz.require_all_answers:
        # A question counts as answered only if the submission actually
        # carries content for it - an autosaved-then-cleared text box or a
        # deselected option must still block submission, not just "some
        # Answer row exists in the database for this question" (which
        # upsert_answer creates even for a blank autosave).
        #
        # Evaluated per question TYPE rather than by looking for text or an
        # option, because a Draw Response question is answered by strokes and
        # carries neither. The rule lives in services/attempts.py so this and
        # the frontend's guard cannot drift.
        submitted_by_question = {a["question_id"]: a for a in data["answers"]}
        missing = []
        # THE DELIVERED SET, not today's quiz. An attempt that started with
        # three questions must be able to finish after answering three, even
        # if the coach has since added a fourth - it was never given one, and
        # blocking the submit would strand a player on a question they cannot
        # see. A NEW attempt receives the fourth and is held to all four.
        for question in delivered_questions(attempt, access_code.quiz):
            submitted = submitted_by_question.get(question.id)
            if submitted is None:
                missing.append(question.id)
                continue
            if question.question_type is QuestionType.DRAW_RESPONSE:
                # Read from the payload, not the database: the drawings in
                # this submission have not been written yet (that happens
                # below, inside the transaction), and an earlier autosave may
                # have stored an empty document the player has since drawn on.
                if not document_has_strokes(submitted.get("drawing")):
                    missing.append(question.id)
            elif question.question_type in TEXT_ANSWER_TYPES:
                if not (submitted.get("answer_text") or "").strip():
                    missing.append(question.id)
            elif question.allows_multiple_answers:
                # ANSWERED, NOT CORRECT. Any selection satisfies this; the
                # player is never forced to find every right answer merely to
                # be allowed to submit.
                if not submitted.get("selected_option_ids"):
                    missing.append(question.id)
            elif submitted.get("selected_option_id") is None:
                missing.append(question.id)

        if missing:
            raise ApiError("Please answer all questions before submitting.", status_code=422)

    # Everything from here writes. If anything raises partway through - an
    # invalid question/option in a *later* answer after an *earlier* one in
    # this same payload already upserted cleanly, or the IntegrityError
    # below - the session must not be left holding an uncommitted write:
    # that leaves the connection "idle in transaction", holding a lock that
    # blocks later work on the same rows (this attempt's own teardown
    # included) until something eventually tears it down. The original
    # single-insert version of this route avoided the problem by
    # validating every answer *before* writing any of them; looping over
    # the shared validate-and-upsert helper reintroduces the same failure
    # mode, so every exit past this point goes through one rollback.
    try:
        # Final sync: upsert whatever the client currently has, so submit
        # is robust even if an individual autosave call failed transiently
        # along the way - not solely reliant on every autosave succeeding.
        for submitted_answer in data["answers"]:
            upsert_answer(
                attempt,
                submitted_answer["question_id"],
                submitted_answer["selected_option_id"],
                submitted_answer["answer_text"],
                submitted_answer.get("selected_option_ids"),
            )
            # Re-sent by the client as the same safety net the text answers
            # get: an autosave may have failed on a flaky connection and this
            # is the player's last chance to be heard. base_revision is None
            # deliberately - submit is authoritative over whatever the server
            # happens to hold, so it must not 409 against the player's own
            # earlier autosave.
            drawing = submitted_answer.get("drawing")
            if drawing is not None:
                upsert_drawing(
                    attempt,
                    submitted_answer["question_id"],
                    validate_document(drawing),
                    base_revision=None,
                    force=True,
                )

        # A conditional UPDATE, not a plain read-then-write: a debounced
        # autosave and this submit can race within the same network
        # window. Checking rowcount makes the two requests serialize
        # correctly regardless of commit order, instead of risking a
        # lost-update where an autosave silently attaches an answer after
        # the attempt is already shown elsewhere as locked.
        result = db.session.execute(
            sa_update(PlayerAttempt)
            .where(PlayerAttempt.id == attempt.id, PlayerAttempt.status == AttemptStatus.IN_PROGRESS)
            .values(status=AttemptStatus.SUBMITTED, submitted_at=datetime.now(timezone.utc))
        )
        if result.rowcount == 0:
            # Lost the race to a concurrent submit between the status
            # check above and this update.
            raise ApiError(ALREADY_SUBMITTED, status_code=409)

        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ApiError(ALREADY_SUBMITTED, status_code=409) from exc
    except Exception:
        db.session.rollback()
        raise

    # Reloaded with the answers' SELECTION SETS attached. Answer.to_dict emits
    # them, and without the eager load it lazy-loads once per answer - on the
    # request an entire squad fires within the same minute.
    attempt = (
        PlayerAttempt.query.populate_existing()
        .options(selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options))
        .filter(PlayerAttempt.id == attempt.id)
        .one()
    )
    return jsonify(attempt.to_dict(include_answers=True)), 201


@play_bp.get("/quiz-by-code/<code>")
# A lightweight, read-only lookup (title only) fired automatically on page
# load to set the browser tab title - fires for every player the instant
# they open the link, before they've done anything else, so this needs the
# same whole-team-on-one-IP headroom as validate-code's comment describes.
@limiter.limit("200 per minute")
def quiz_by_code(code: str):
    """Quiz title for a code, for tab-title purposes only - deliberately not
    the full validate-code payload (no questions/roster), and deliberately
    never errors on an invalid/expired/deactivated code: callers fall back
    to generic branding on a null title rather than surfacing a lookup
    failure before the player has done anything."""
    access_code = AccessCode.query.filter_by(code=code.strip().upper()).first()
    reason = reason_for_invalid(access_code)
    if reason is not None:
        return jsonify({"quiz_title": None})

    return jsonify({"quiz_title": access_code.quiz.title})


@play_bp.post("/results")
# See validate-code's comment - a whole team may check results within the
# same short window right after everyone submits.
@limiter.limit("200 per minute")
def player_results():
    """A player's own graded results - revisitable after the code expires,
    since grading (especially of written answers) can happen well after."""
    data = load_json_body(PlayerResultsSchema())

    access_code = find_access_code_by_code(data["code"])
    if access_code is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    query = PlayerAttempt.query.filter(
        PlayerAttempt.access_code_id == access_code.id,
        PlayerAttempt.status == AttemptStatus.SUBMITTED,
    )
    player_id = data.get("player_id")
    if player_id is not None:
        # Disambiguates two same-name canonical Players - a name-only match
        # below can't tell them apart and would silently return whichever
        # row the query happens to find first. See PlayerResultsSchema.
        query = query.filter(PlayerAttempt.player_id == player_id)
    else:
        query = query.filter(
            db.func.lower(PlayerAttempt.player_name) == data["player_name"].strip().lower()
        )
    attempt = query.options(
        # `question_snapshots` is what delivered_questions() reads, and
        # `answers.selected_option` is the compatibility fallback in
        # _resolve_answer_text - both would otherwise lazy-load per question
        # and turn one results page into an N+1.
        selectinload(PlayerAttempt.answers).selectinload(Answer.selected_option),
        # The SET a "Select all that apply" answer stores. Without this,
        # resolving each one walks `answer.selected_options` and fires a query
        # per question - the same N+1 the two loaders around it exist to avoid.
        #
        # Joined rather than selectin so the cost is zero extra queries at any
        # size; see the note in routes/grading._load_responses_for_export.
        selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options),
        # The player's own drawings, for the Draw Response cards below. Walking
        # `answer.drawing` per answer would be one query per question on the
        # page a whole squad opens the moment they finish.
        selectinload(PlayerAttempt.answers).selectinload(Answer.drawing),
        selectinload(PlayerAttempt.question_snapshots),
    ).first()
    if attempt is None:
        raise ApiError(NO_RESULTS_FOUND, status_code=404)

    quiz = access_code.quiz
    answers_by_question = {a.question_id: a for a in attempt.answers}
    exclusions = load_for_quizzes([quiz.id])

    # WHAT THIS PLAYER RECEIVED, not what the quiz says today. A coach fixing
    # the quiz for future players must not rewrite the page this player is
    # looking at.
    answer_details = []
    for question in delivered_questions(attempt, quiz):
        answer = answers_by_question.get(question.question_id)
        correct_option_text = question.correct_option_text
        # A question the coach has stopped counting. The player still sees the
        # question and their own answer - nothing is hidden or deleted - but it
        # is no longer presented as right or wrong, because it no longer is
        # either. The coach's optional private reason is deliberately NOT in
        # this payload; it is a note to themselves, not an explanation owed to
        # the player.
        excluded = exclusions.excludes(question.question_id, attempt.access_code_id)

        answer_details.append(
            {
                "question_id": question.question_id,
                "question_number": question.number,
                "question_text": question.text,
                "question_type": question.question_type.value,
                "your_answer": _resolve_answer_text(question, answer),
                # Withheld for an excluded question: showing "the correct
                # answer was B" next to a neutral chip invites the player to
                # score it themselves, which is the confusion exclusion exists
                # to remove.
                "correct_answer": (None if excluded else correct_option_text),
                # None, exactly as an ungraded answer reports - `is_excluded`
                # is what tells the two apart, so no client can mistake an
                # excluded question for one still awaiting a coach.
                "is_correct": None if excluded else (answer.is_correct if answer else None),
                "is_excluded": excluded,
                "coach_feedback": answer.coach_feedback if answer else None,
                "graded_at": answer.graded_at.isoformat() if answer and answer.graded_at else None,
                # THE PLAYER'S OWN DRAWING, over the image they were given.
                #
                # Both halves come from the same delivered record the coach's
                # view reads, so the two cannot show different pictures for the
                # same answer. The image is the DELIVERED one - after a coach
                # replaces the picture, Phase 1's preserved copy - and the
                # drawing is bound to it by Phase A.
                #
                # Only present for a drawing question that actually has one.
                # A missing drawing stays None so the client can say so plainly
                # rather than mounting a viewer over nothing.
                "drawing": (
                    {
                        "document": answer.drawing.document,
                        "image_url": question.image.image_url,
                    }
                    if question.question_type is QuestionType.DRAW_RESPONSE
                    and answer is not None
                    and answer.drawing is not None
                    and document_has_strokes(answer.drawing.document)
                    and question.image is not None
                    else None
                ),
            }
        )

    return jsonify(
        {
            "quiz_title": quiz.title,
            "player_name": attempt.player_name,
            "submitted_at": attempt.submitted_at.isoformat(),
            "answers": answer_details,
        }
    )
