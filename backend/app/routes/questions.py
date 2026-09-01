"""Question CRUD, reordering, and image/annotation management.

Nested under /api/quizzes/<quiz_id>/questions. Every route re-verifies that
the caller may edit the parent quiz, so a coach can never mutate another
organization's data - or a teammate's quiz they didn't create.
"""

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from marshmallow import ValidationError

from app.errors import ApiError
from app.services.clip_storage import (
    CLIP_CONTENT_TYPE,
    delete_clip_object,
    save_clip,
    save_poster,
    validate_duration_ms,
)
from app.extensions import db
from app.models import (
    Answer,
    Concept,
    DocumentPage,
    Question,
    QuestionImage,
    QuestionOption,
    QuestionRegion,
    QuestionType,
    Quiz,
)
from app.models import QuestionClip
from app.models.question_region import RegionRole
from app.schemas.question import (
    AnnotationsUpdateSchema,
    QuestionCreateSchema,
    QuestionReorderSchema,
    QuestionUpdateSchema,
    RegionQuestionCreateSchema,
    RegionQuestionUpdateSchema,
    validate_options_for_type,
)
from app.services.answer_matching import DEFAULT_MODE, clean_expected_answers
from app.services.document_geometry import NormalisedRectError, validate_normalised_rect
from app.services.page_masking import invalidate_masked_render
from app.services.file_storage import StorageError, get_file_storage
from app.services.question_snapshots import (
    has_been_delivered,
    has_history,
    historical_image_preserved,
)
from app.utils.auth import current_coach, get_editable_quiz
from app.utils.validation import load_json_body

questions_bp = Blueprint("questions", __name__)


def _get_editable_question(quiz_id: int, question_id: int) -> Question:
    quiz = get_editable_quiz(quiz_id)
    question = Question.query.filter_by(id=question_id, quiz_id=quiz.id).first()
    if question is None:
        raise ApiError("Question not found", status_code=404)
    return question


def _validated_concept_id(quiz, concept_id):
    """A concept id proven to belong to this quiz's organization, or None.

    IDS FROM A CLIENT ARE NEVER TRUSTED - the same rule the option ids follow.
    Without this check a coach could tag their question with another
    organization's concept, and every count built on it afterwards would be
    quietly wrong across a tenant boundary.

    None is a legitimate value meaning "General", so it passes straight
    through rather than being treated as absent.
    """
    if concept_id is None:
        return None
    concept = db.session.get(Concept, concept_id)
    if concept is None or concept.organization_id != quiz.organization_id:
        raise ApiError("That concept does not exist", status_code=422)
    return concept.id


def _replace_options(question: Question, options: list[dict]) -> None:
    question.options.clear()
    for index, option in enumerate(options):
        question.options.append(
            QuestionOption(
                option_text=option["option_text"],
                is_correct_answer=option["is_correct_answer"],
                position=index,
            )
        )


def _apply_option_edits(question: Question, incoming: list[dict]) -> None:
    """Edit the options of a question that HAS ALREADY BEEN DELIVERED.

    PHASE 4C. `_replace_options` above clears the list and rebuilds it, which
    mints NEW option rows with NEW ids - fine while nothing references them,
    fatal once an answer does. So a delivered question takes this path instead,
    which mutates in place and never deletes.

    Matched BY POSITION, because the update payload carries no option ids: the
    editor sends the list it rendered, in order. Incoming[i] is therefore the
    same option as existing[i], and anything past the end is an addition.

    Permitted (Phase 4C v1):
      * changing an existing option's TEXT - the player's selection still
        points at the same row, and the snapshot still holds the wording they
        actually saw
      * APPENDING a new option - no existing attempt gains it, because no
        existing attempt's snapshot contains it

    Refused, each for its own reason:
      * REMOVING an option. Deleting the row would strand
        `Answer.selected_option_id`, and whether the delivered snapshot alone
        can still identify what the player picked is an open question - it is
        the explicit follow-up audit in the Phase 4C brief, deliberately not
        answered here.
      * Changing WHICH option is correct, including adding a correct one.
        `answers.is_correct` is a stored column, so old answers keep their
        verdict while new ones get the new key - two players give the same
        answer and carry different results, permanently and invisibly. That
        needs a product decision about regrading, not a code change. The safe
        workflow today is Phase 4B ("stop sending it") plus Phase 3 ("don't
        count it").
    """
    existing = list(question.options)

    if len(incoming) < len(existing):
        raise ApiError(
            "Cannot remove an answer option from a question players have already "
            "received - a player may have chosen it. You can reword the options, "
            "add a new one, or stop sending this question.",
            status_code=422,
            reason="option_removal_blocked",
        )

    for option, update in zip(existing, incoming):
        if bool(update["is_correct_answer"]) != bool(option.is_correct_answer):
            raise ApiError(
                "Cannot change which answer is correct on a question players have "
                "already received - it would grade them differently from everyone "
                "who answers next. Stop sending this question, and use "
                "\"Don't count this question\" for the players who already have it.",
                status_code=422,
                reason="correct_answer_change_blocked",
            )
        # TEXT ONLY, in place. The row - and therefore every
        # `Answer.selected_option_id` pointing at it - survives untouched.
        option.option_text = update["option_text"]

    for position, update in enumerate(incoming[len(existing) :], start=len(existing)):
        if update["is_correct_answer"]:
            raise ApiError(
                "Cannot add a new correct answer to a question players have already "
                "received - everyone who answered under the old key would keep a "
                "different result. Add it as an ordinary option, or stop sending "
                "this question.",
                status_code=422,
                reason="correct_answer_change_blocked",
            )
        question.options.append(
            QuestionOption(
                option_text=update["option_text"],
                is_correct_answer=False,
                position=position,
            )
        )


IMAGE_PRESERVATION_FAILED = (
    "Could not preserve the copy of this image that already-delivered attempts "
    "depend on, so nothing was changed. Please try again."
)


def _refuse_rather_than_destroy_history(exc: StorageError) -> None:
    """Turn a failed preservation copy into a readable refusal.

    Same philosophy as the duplicate-quiz fix: when history cannot be preserved,
    the COACH'S DESTRUCTIVE OPERATION FAILS. Continuing would trade a retryable
    inconvenience for permanently destroyed evidence of what a player was shown.
    A 502 rather than a 500 because the failure is downstream storage, and the
    coach's correct response is to retry.
    """
    raise ApiError(
        IMAGE_PRESERVATION_FAILED,
        status_code=502,
        reason="image_preservation_failed",
    ) from exc


def _reject_if_already_answered(question: Question, action: str) -> None:
    # Answer.question_id cascades (ON DELETE / SET NULL) specifically so a
    # coach's edit/delete never crashes or errors - but that same cascade
    # silently detaches or destroys any player's already-recorded answer and
    # grade for this question, with no audit trail. Once a player has
    # actually answered, force the coach through the explicit attempt-reset
    # path instead of letting this happen invisibly.
    if Answer.query.filter_by(question_id=question.id).first() is not None:
        raise ApiError(
            f"Cannot {action} - one or more players have already answered it. "
            "Reset the affected player attempts first if you need to change it.",
            status_code=422,
        )


@dataclass
class _UploadedMedia:
    """Whatever visual material arrived with a create request.

    A question takes its picture from ONE source, so at most one of these is
    ever populated - but they travel together because they arrive together, in
    the single multipart request that makes "Add question" mean what a coach
    already thinks it means.
    """

    image: object | None = None
    clip: object | None = None
    poster: object | None = None
    duration_ms: str | None = None
    width: str | None = None
    height: str | None = None


def _create_payload() -> tuple[dict, object | None]:
    """The create body, from JSON or from multipart.

    ONE ENDPOINT, TWO ENVELOPES, on purpose. A question and its image used to
    be two requests, which meant a coach saved a question, reopened it, went to
    another page, uploaded, and came back - and it meant a half-made question
    existed in between. Accepting the image on create makes "save" mean what a
    coach already thinks it means.

    JSON stays exactly as it was, so every existing caller and every test that
    posts JSON is untouched. Multipart carries the same object as a `payload`
    field because options are a nested list, which form fields cannot express
    without inventing an encoding.
    """
    if request.files:
        raw = request.form.get("payload")
        if not raw:
            raise ApiError(
                "Multipart question create needs a 'payload' field with the question JSON",
                status_code=400,
            )
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise ApiError("'payload' must be valid JSON", status_code=400) from exc

        try:
            data = QuestionCreateSchema().load(parsed)
        except ValidationError as exc:
            raise ApiError("Validation failed", status_code=422, details=exc.messages) from exc
        return data, _UploadedMedia(
            image=request.files.get("image"),
            clip=request.files.get("clip"),
            poster=request.files.get("clip_poster"),
            duration_ms=request.form.get("clip_duration_ms"),
            width=request.form.get("clip_width"),
            height=request.form.get("clip_height"),
        )

    return load_json_body(QuestionCreateSchema()), None


@questions_bp.post("/<int:quiz_id>/questions")
@jwt_required()
def create_question(quiz_id: int):
    """Create a question, and its image if one was sent, in ONE operation."""
    data, uploaded_image = _create_payload()
    return create_question_from(quiz_id, data, uploaded_image)


def create_question_from(quiz_id: int, data: dict, uploaded_image=None):
    """THE ONE PLACE A QUESTION IS CREATED.

    `uploaded_image` is either a bare file (every existing caller, unchanged)
    or an `_UploadedMedia` carrying whichever single source of visual material
    the coach chose. Widening rather than adding a second create path: two
    would mean the next field added to one silently missing from the other,
    which is how the explanation and the expected answers were each lost once
    before.
    """
    media = (
        uploaded_image
        if isinstance(uploaded_image, _UploadedMedia)
        else _UploadedMedia(image=uploaded_image)
    )
    uploaded_image = media.image
    quiz = get_editable_quiz(quiz_id)
    # Only multiple choice can be a "select all that apply". Anything else
    # silently keeps the default rather than erroring: a client sending it on a
    # written question is confused, not malicious, and the question it actually
    # asked for is unambiguous.
    allows_multiple = bool(
        data.get("allows_multiple_answers")
        and data["question_type"] == QuestionType.MULTIPLE_CHOICE.value
    )
    validate_options_for_type(data["question_type"], data["options"], allows_multiple)

    # EVERY REJECTION HAPPENS BEFORE THE INSERT BELOW, and that ordering is
    # load-bearing rather than tidy. `db.session.add` + `flush` writes a row and
    # takes locks; a validation that raises after it leaves the request dead
    # with an open transaction, and the connection sits `idle in transaction`
    # until something else waits on it forever. Measured: the suite deadlocked
    # with `DELETE FROM quizzes` in teardown blocked by exactly that.
    #
    # The original route validated everything up front for this reason. The
    # shared path lost that ordering in the move - which is the sort of thing a
    # refactor drops silently, because every test that only exercises the happy
    # path still passes.
    # A PLAYBOOK PAGE AS THE PICTURE, and optionally one thing hidden on it.
    #
    # The presence of a rectangle IS the difference, which is why no "role"
    # crosses the API. A coach who picked a page and hid nothing sends a page;
    # a coach who hid something sends the rectangle they drew. Neither has to
    # know the words mask, region, crop or role - those are ours.
    #
    # A whole-page picture is stored as a CROP covering the page rather than as
    # "no region", so the delivered-visual freezing, the masked-media route and
    # the exports all keep working through exactly one path.
    rect = page = None
    region_role = RegionRole.MASK
    if data.get("document_page_id") is not None:
        page = _org_document_page(data["document_page_id"])
        if data.get("region") is not None:
            rect = _validated_rect(data["region"])
        else:
            rect = WHOLE_PAGE
            region_role = RegionRole.CROP

    expected = None
    if data["question_type"] == QuestionType.FILL_BLANK.value:
        expected = clean_expected_answers(data.get("expected_answers") or [])
        if not expected:
            raise ApiError(
                "Add at least one accepted answer that isn't blank.", status_code=422
            )

    # ONE SOURCE OF VISUAL MATERIAL, AND IT IS REFUSED BEFORE THE INSERT.
    #
    # This sits above `db.session.add` because of the ordering rule stated at
    # the top of this function, and it is here because an earlier draft broke
    # that rule. Checking after the flush returned the correct 422 and still
    # left the request holding an open transaction; the suite then hung for
    # five hours with `DELETE FROM quizzes` in teardown blocked on exactly
    # those row locks. The status code was right and the connection was
    # ruined - which is why rejecting before the insert is a rule here and not
    # a preference.
    #
    # Reading the type off `data` rather than off a Question is the point: at
    # this line there is no Question yet, and there must not be one.
    #
    # Checking the combination in one place also keeps the answer to "why was
    # this refused" about what the coach chose, rather than about which file
    # the server happened to validate first.
    has_clip = media.clip is not None and bool(getattr(media.clip, "filename", None))
    if has_clip:
        if data["question_type"] == QuestionType.DRAW_RESPONSE.value:
            raise ApiError(
                "A Draw Response question needs a still image to draw on, so it "
                "cannot use a recorded clip.",
                status_code=422,
            )
        if (uploaded_image is not None and getattr(uploaded_image, "filename", None)) or (
            page is not None
        ):
            raise ApiError(
                "A question shows one thing: an image, a playbook page, or a "
                "recorded clip.",
                status_code=422,
            )

    next_position = data["position"]
    if next_position is None:
        next_position = len(quiz.questions)

    question = Question(
        quiz_id=quiz.id,
        question_text=data["question_text"],
        answer_explanation=(data.get("answer_explanation") or None),
        question_type=QuestionType(data["question_type"]),
        position=next_position,
        allows_multiple_answers=allows_multiple,
        concept_id=_validated_concept_id(quiz, data.get("concept_id")),
    )
    db.session.add(question)
    db.session.flush()
    _replace_options(question, data["options"])

    if page is not None:
        # Already validated above, before the insert. Attaching is pure
        # mutation and cannot reject.
        _apply_region(question, page, rect, region_role)

    if expected is not None:
        question.expected_answers = expected
        question.answer_matching = data.get("answer_matching") or DEFAULT_MODE

    # Written to storage before the commit, so a commit failure would leave the
    # bytes orphaned. Tracked and removed on any failure - the same discipline
    # the document upload uses, and the reason the two halves cannot disagree.
    # Nothing here can reject: the combination was settled before the insert.
    stored_url: str | None = None
    stored_clip_key: str | None = None
    stored_poster_key: str | None = None
    try:
        if uploaded_image is not None and uploaded_image.filename:
            storage = get_file_storage()
            # Same save_image() the standalone upload route uses, so extension
            # checks, EXIF rotation and the size cap apply identically. A
            # second validation path here would be one that could drift.
            stored_url = storage.save_image(uploaded_image)
            db.session.add(
                QuestionImage(question_id=question.id, image_url=stored_url, annotations=[])
            )

        if has_clip:
            # The conflict checks already ran above, before anything was
            # written. This half only stores.
            stored_clip_key = save_clip(media.clip.read())
            poster_bytes = media.poster.read() if media.poster is not None else b""
            if poster_bytes:
                stored_poster_key = save_poster(poster_bytes)

            def _as_int(raw):
                try:
                    return int(raw) if raw not in (None, "") else None
                except (TypeError, ValueError):
                    return None

            db.session.add(
                QuestionClip(
                    question_id=question.id,
                    storage_key=stored_clip_key,
                    poster_key=stored_poster_key,
                    content_type=CLIP_CONTENT_TYPE,
                    duration_ms=validate_duration_ms(_as_int(media.duration_ms)),
                    width=_as_int(media.width),
                    height=_as_int(media.height),
                )
            )

        db.session.commit()
    except Exception:
        # Both halves undone together. The question never existed and neither
        # did its bytes - a coach whose "Add question" failed gets nothing
        # rather than a half-made question or an unreferenced object.
        db.session.rollback()
        if stored_url:
            get_file_storage().delete_image(stored_url)
        for key in (stored_clip_key, stored_poster_key):
            if key:
                delete_clip_object(key)
        raise

    return jsonify(question.to_dict(include_correct_answers=True)), 201


def _org_document_page(page_id: int) -> DocumentPage:
    """A page belonging to the caller's organization.

    Checked explicitly rather than trusted from the request: without this, a
    coach could name any page id and build a question from another program's
    playbook - the masked render would then be served to their players.
    404, not 403, so an id cannot be probed for existence.
    """
    coach = current_coach()
    page = db.session.get(DocumentPage, page_id)
    if page is None or page.source_document.organization_id != coach.organization_id:
        raise ApiError("Document page not found", status_code=404)
    return page


def _validated_rect(rect: dict) -> dict:
    """Check the rectangle BEFORE anything is written.

    Ordering matters here and is not cosmetic: validating after
    `db.session.add()` + `flush()` leaves an inserted-but-uncommitted question
    row behind when the check fails, and the request then returns 422 without
    rolling back - holding locks on `questions` until the session is finally
    torn down. Rejecting first means a bad rectangle touches the database not
    at all.
    """
    try:
        validate_normalised_rect(rect["x"], rect["y"], rect["width"], rect["height"])
    except NormalisedRectError as exc:
        raise ApiError(str(exc), status_code=422) from exc
    return rect


#: The rectangle for "use this whole page". Stored rather than left implicit so
#: every downstream reader - the delivered snapshot, the media route, the PDF -
#: sees one shape of region instead of two.
WHOLE_PAGE = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}


def _apply_region(
    question: Question, page: DocumentPage, rect: dict, role: str = RegionRole.MASK
) -> QuestionRegion:
    """Create or move this question's single region. `rect` must already have
    been through `_validated_rect`.

    THE ROLE DECIDES WHAT THE PLAYER SEES, and defaulting it to MASK is what
    keeps the playbook's bulk authoring identical: there, the rectangle IS the
    thing being hidden. A question that simply USES a page as its picture
    passes CROP, which renders the page untouched - a whole-page MASK would
    black the entire thing out.

    V1 permits exactly one region per question. The schema allows several so
    that hotspots and multi-part questions are additive later; the limit lives
    here, where it can be lifted without a migration.
    """
    region = question.regions[0] if question.regions else None
    if region is None:
        region = QuestionRegion(question_id=question.id, position=0, role=role)
        db.session.add(region)
        question.regions.append(region)
    else:
        # The rectangle moved, so the cached masked render is now covering the
        # wrong pixels. Dropping it here rather than lazily is the difference
        # between a resized mask and a mask that still shows the answer.
        invalidate_masked_render(region)

    region.role = role
    region.document_page_id = page.id
    region.x = rect["x"]
    region.y = rect["y"]
    region.width = rect["width"]
    region.height = rect["height"]
    return region


@questions_bp.post("/<int:quiz_id>/questions/from-region")
@jwt_required()
def create_region_question(quiz_id: int):
    """COMPATIBILITY CALLER. Translates and delegates; owns no creation logic."""
    data = load_json_body(RegionQuestionCreateSchema())
    return create_question_from(
        quiz_id,
        {
            "question_text": data["question_text"],
            "question_type": data.get("question_type") or QuestionType.FILL_BLANK.value,
            "options": [],
            "allows_multiple_answers": False,
            "position": data["position"],
            "answer_explanation": data.get("answer_explanation"),
            "document_page_id": data["document_page_id"],
            "region": data["region"],
            "expected_answers": data["expected_answers"],
            "answer_matching": data["answer_matching"],
        },
    )


@questions_bp.patch("/<int:quiz_id>/questions/<int:question_id>/region")
@jwt_required()
def update_region_question(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    if question.question_type is not QuestionType.FILL_BLANK or not question.regions:
        raise ApiError("This question was not built from a playbook page", status_code=422)

    data = load_json_body(RegionQuestionUpdateSchema())
    # Editing the accepted answers re-grades nobody: answers already recorded
    # keep the is_correct they were given at the time. Silently re-scoring a
    # completed attempt would change a result a coach may already have acted
    # on, which is the same reasoning behind _reject_if_already_answered.
    _reject_if_already_answered(question, "change this question")

    if "allows_multiple_answers" in data:
        question.allows_multiple_answers = allows_multiple
    if "question_text" in data:
        question.question_text = data["question_text"]
    if "concept_id" in data:
        # Only when SENT, matching every other field here. The update schema
        # deliberately has no load_default, so an edit that never mentions the
        # concept leaves the key absent and the existing tag alone.
        question.concept_id = _validated_concept_id(question.quiz, data.get("concept_id"))

    # Deliberately NOT guarded by _reject_if_already_answered: the explanation
    # is teaching material shown after the fact, so improving it changes
    # nobody's score and a coach should be able to refine it at any time.
    if "answer_explanation" in data:
        question.answer_explanation = data["answer_explanation"] or None
    if "expected_answers" in data:
        expected = clean_expected_answers(data["expected_answers"])
        if not expected:
            raise ApiError("Add at least one accepted answer that isn't blank.", status_code=422)
        question.expected_answers = expected
    if "answer_matching" in data and data["answer_matching"]:
        question.answer_matching = data["answer_matching"]
    if "region" in data:
        _apply_region(
            question, question.regions[0].document_page, _validated_rect(data["region"])
        )

    db.session.commit()
    return jsonify(question.to_dict(include_correct_answers=True))


@questions_bp.patch("/<int:quiz_id>/questions/<int:question_id>")
@jwt_required()
def update_question(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    data = load_json_body(QuestionUpdateSchema())

    question_type = data.get("question_type", question.question_type.value)
    allows_multiple = bool(
        data.get("allows_multiple_answers", question.allows_multiple_answers)
        and question_type == QuestionType.MULTIPLE_CHOICE.value
    )
    # PHASE 4C. Whether this question already has recorded history decides
    # WHICH edit path it takes, not whether it may be edited at all.
    #
    # `has_history`, not `has_been_delivered`: a legacy pre-Phase-1 attempt has
    # answers and no snapshot, and a snapshot-only check would wave an unsafe
    # edit through on a question answered last year. Locks fail closed; the
    # coach WARNING uses the honest snapshot-based check instead.
    delivered = has_history(question)
    if "options" in data:
        validate_options_for_type(question_type, data["options"], allows_multiple)

    # THE HOLE THIS CLOSES. The guard above only fires when `options` is in the
    # payload, so a question_type change ON ITS OWN walked straight past it -
    # and past validate_options_for_type with it. Measured damage: converting
    # an answered multiple-choice question to `written` made every player's
    # correct answer display as "No answer", because the display consulted the
    # live type and then read the empty text column.
    #
    # Phase 4a makes historical surfaces read the DELIVERED type, so that
    # particular symptom is fixed at the display end too. This stays blocked
    # anyway: the type decides how an answer is stored and graded, so changing
    # it under recorded answers leaves rows whose shape no longer matches the
    # question that produced them. Unlike text, there is no version of that
    # which is merely cosmetic.
    if "question_type" in data and data["question_type"] != question.question_type.value:
        _reject_if_already_answered(question, "change this question's type")
        # THE OTHER DIRECTION OF THE CLIP RULE. The upload route refuses a clip
        # on a Draw Response question; without this, a coach could record a
        # clip first and then switch the type, arriving at the same
        # unsupported state by a different door. A drawing has no frame to
        # bind to, so both doors are shut.
        if (
            data["question_type"] == QuestionType.DRAW_RESPONSE.value
            and question.clip is not None
        ):
            raise ApiError(
                "This question shows a recorded clip, so it cannot become a "
                "Draw Response question. Remove the clip first.",
                status_code=422,
            )

    if "allows_multiple_answers" in data:
        question.allows_multiple_answers = allows_multiple
    if "question_text" in data:
        question.question_text = data["question_text"]
    if "concept_id" in data:
        # Only when SENT, matching every other field here. The update schema
        # deliberately has no load_default, so an edit that never mentions the
        # concept leaves the key absent and the existing tag alone.
        question.concept_id = _validated_concept_id(question.quiz, data.get("concept_id"))

    # Deliberately NOT guarded by _reject_if_already_answered: the explanation
    # is teaching material shown after the fact, so improving it changes
    # nobody's score and a coach should be able to refine it at any time.
    if "answer_explanation" in data:
        question.answer_explanation = data["answer_explanation"] or None
    if "question_type" in data:
        question.question_type = QuestionType(data["question_type"])
    if "options" in data:
        if delivered:
            # In place: reword and append only, never delete, never re-key.
            _apply_option_edits(question, data["options"])
        else:
            # Nothing has seen this question, so the whole list is still the
            # coach's to rewrite - including which answer is correct.
            _replace_options(question, data["options"])

    db.session.commit()
    return jsonify(question.to_dict(include_correct_answers=True))


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>")
@jwt_required()
def delete_question(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    _reject_if_already_answered(question, "delete this question")

    # ANSWERED is not the same as DELIVERED. This guard only fires once a
    # player has an Answer row, but a question delivered and skipped has a
    # snapshot and no answer - so deleting it here would still destroy the
    # image that snapshot points at. The question row going away is fine
    # (question_id is ON DELETE SET NULL and the snapshot's content survives);
    # the bytes going away is not.
    storage = get_file_storage()
    try:
        with historical_image_preserved(question, storage):
            db.session.delete(question)
    except StorageError as exc:
        _refuse_rather_than_destroy_history(exc)

    return "", 204


@questions_bp.post("/<int:quiz_id>/questions/<int:question_id>/retire")
@jwt_required()
def retire_question(quiz_id: int, question_id: int):
    """STOP SENDING THIS QUESTION TO NEW ATTEMPTS.

    Deliberately NOT guarded by `_reject_if_already_answered`. Every other
    guard on this route exists because the operation would corrupt an attempt
    that already happened; this one cannot. Retirement changes only which
    questions a FUTURE attempt is built from - it does not touch a delivered
    snapshot, an answer, a grade or a score. Being usable precisely when
    players have already taken the quiz is the entire point: that is when a
    coach discovers the question was broken.

    It is also the one action here that is not destructive, which is why it can
    be offered where editing options cannot.

    Distinct from Phase 3 exclusion, and neither implies the other. Stopping a
    question does NOT stop it counting for players who already answered it; a
    coach who wants both does both, and the UI keeps them apart.
    """
    question = _get_editable_question(quiz_id, question_id)

    # Idempotent: re-stopping an already-stopped question keeps the ORIGINAL
    # timestamp and coach. Overwriting them would rewrite the record of when
    # the decision was actually made, for no gain.
    if question.retired_at is None:
        question.retired_at = datetime.now(timezone.utc)
        # From the session, never the payload - a client cannot attribute this
        # decision to another coach.
        question.retired_by_coach_id = current_coach().id
        db.session.commit()

    return jsonify(question.to_dict(include_correct_answers=True))


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>/retire")
@jwt_required()
def restore_question(quiz_id: int, question_id: int):
    """START SENDING THIS QUESTION AGAIN.

    Safe by definition and needs no guard: retirement only ever affected future
    delivery, so undoing it cannot alter a past attempt, an answer or a score.
    Nothing is un-deleted here because nothing was deleted.
    """
    question = _get_editable_question(quiz_id, question_id)

    if question.retired_at is not None:
        question.retired_at = None
        question.retired_by_coach_id = None
        db.session.commit()

    return jsonify(question.to_dict(include_correct_answers=True))


@questions_bp.post("/<int:quiz_id>/questions/reorder")
@jwt_required()
def reorder_questions(quiz_id: int):
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(QuestionReorderSchema())

    question_ids = data["question_ids"]
    quiz_question_ids = {q.id for q in quiz.questions}
    # Length check catches duplicate ids too: set() would dedupe them, letting a
    # payload like [1, 1, 2] slip past a set-only comparison against {1, 2}.
    if len(question_ids) != len(quiz_question_ids) or set(question_ids) != quiz_question_ids:
        raise ApiError(
            "question_ids must include every question in the quiz exactly once",
            status_code=422,
        )

    questions_by_id = {q.id: q for q in quiz.questions}
    for position, question_id in enumerate(question_ids):
        questions_by_id[question_id].position = position

    db.session.commit()
    return jsonify([q.to_dict() for q in sorted(quiz.questions, key=lambda q: q.position)])


@questions_bp.post("/<int:quiz_id>/questions/<int:question_id>/image")
@jwt_required()
def upload_question_image(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)

    # A question gets its picture from EITHER an uploaded still OR a document
    # page region - never both. Allowing both would leave two answers to "what
    # image does this question show", and the player renderer would have to
    # pick one; whichever it picked would be wrong half the time. The rule is
    # stated in models/question.py and enforced here.
    if question.regions:
        raise ApiError(
            "This question already gets its image from a playbook page. Edit its "
            "region from Playbooks instead of uploading a separate image.",
            status_code=422,
        )
    if question.clip is not None:
        raise ApiError(
            "This question already shows a recorded clip. Remove the clip "
            "before uploading a still image.",
            status_code=422,
        )

    if "image" not in request.files:
        raise ApiError("No image file provided under the 'image' field", status_code=400)

    storage = get_file_storage()
    # REPLACING a delivered image used to physically destroy the object every
    # snapshot of that delivery points at - the old code unlinked it here,
    # before anything was committed. `historical_image_preserved` copies it
    # first, repoints the affected snapshots at the copy, and defers the
    # unlink until after this transaction has actually landed.
    try:
        with historical_image_preserved(question, storage) as preserved:
            if question.image is not None:
                db.session.delete(question.image)
                db.session.flush()

            image_url = storage.save_image(request.files["image"])
            # Registered so a failed commit removes the replacement too. Saved
            # to storage before the commit, exactly as create_question does, so
            # the bytes need the same undo.
            preserved.track(image_url)
            image = QuestionImage(question_id=question.id, image_url=image_url, annotations=[])
            db.session.add(image)
    except StorageError as exc:
        _refuse_rather_than_destroy_history(exc)

    return jsonify(image.to_dict()), 201


@questions_bp.put("/<int:quiz_id>/questions/<int:question_id>/image/annotations")
@jwt_required()
def update_question_image_annotations(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    if question.image is None:
        raise ApiError("Question has no image to annotate", status_code=404)

    data = load_json_body(AnnotationsUpdateSchema())
    question.image.annotations = data["annotations"]
    # Only overwrite when the caller actually sent a value - an older
    # frontend bundle mid-rollout that omits this field shouldn't wipe out
    # a width already pinned by a previous save.
    if data["canvas_width"] is not None:
        question.image.canvas_width = data["canvas_width"]
    db.session.commit()
    return jsonify(question.image.to_dict())


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>/image")
@jwt_required()
def delete_question_image(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    if question.image is None:
        raise ApiError("Question has no image", status_code=404)

    try:
        with historical_image_preserved(question, get_file_storage()):
            db.session.delete(question.image)
    except StorageError as exc:
        _refuse_rather_than_destroy_history(exc)

    return "", 204


# ---------------------------------------------------------------------------
# Recorded clips
# ---------------------------------------------------------------------------
#
# A clip is the THIRD source of a question's visual material, and it is an
# alternative to the other two rather than an addition. The rule is the same
# one models/question.py states for image-versus-region, extended by one:
# still, OR playbook region, OR clip. Enforced here, in the service layer,
# because the schema does not express it - exactly as the existing rule is.


@questions_bp.post("/<int:quiz_id>/questions/<int:question_id>/clip")
@jwt_required()
def upload_question_clip(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)

    # DRAW RESPONSE CANNOT USE A CLIP, and this is checked on the server
    # rather than only hidden in the editor.
    #
    # A drawing binds to `image_id` and lives in a coordinate space pinned to
    # one still. Over a moving picture there is no answer to "which frame was
    # this drawn against", and the delivered-snapshot model has nowhere to
    # record one. Refusing is the honest outcome; half-supporting it would
    # produce strokes that mean nothing.
    if question.question_type == QuestionType.DRAW_RESPONSE:
        raise ApiError(
            "A Draw Response question needs a still image to draw on, so it "
            "cannot use a recorded clip.",
            status_code=422,
        )

    if question.regions:
        raise ApiError(
            "This question already gets its image from a playbook page. Remove "
            "the playbook region before recording a clip.",
            status_code=422,
        )
    if question.image is not None:
        raise ApiError(
            "This question already has an image. Remove it before recording a clip.",
            status_code=422,
        )

    if "clip" not in request.files:
        raise ApiError("No clip file provided under the 'clip' field", status_code=400)

    clip_bytes = request.files["clip"].read()
    # Validates size AND container. The multipart Content-Type and the
    # filename are both client claims; the `ftyp` box is not.
    storage_key = save_clip(clip_bytes)

    poster_key = None
    if "poster" in request.files:
        poster_bytes = request.files["poster"].read()
        if poster_bytes:
            poster_key = save_poster(poster_bytes)

    def _int_or_none(name):
        raw = request.form.get(name)
        try:
            return int(raw) if raw not in (None, "") else None
        except (TypeError, ValueError):
            return None

    clip = QuestionClip(
        question_id=question.id,
        storage_key=storage_key,
        poster_key=poster_key,
        content_type=CLIP_CONTENT_TYPE,
        duration_ms=validate_duration_ms(_int_or_none("duration_ms")),
        width=_int_or_none("width"),
        height=_int_or_none("height"),
    )
    # Replacing keeps the OLD object in storage on purpose. A delivered
    # snapshot may point at it, and historical integrity outranks reclaiming a
    # megabyte. Recorded as cleanup debt in docs/KNOWN-ISSUES.md rather than
    # solved with a delete that could blank a past attempt's evidence.
    if question.clip is not None:
        db.session.delete(question.clip)
        db.session.flush()
    db.session.add(clip)
    db.session.commit()

    return jsonify(clip.to_dict()), 201


@questions_bp.delete("/<int:quiz_id>/questions/<int:question_id>/clip")
@jwt_required()
def delete_question_clip(quiz_id: int, question_id: int):
    question = _get_editable_question(quiz_id, question_id)
    if question.clip is None:
        raise ApiError("Question has no clip", status_code=404)

    # The row goes; the stored object stays. See the note on replacement above.
    db.session.delete(question.clip)
    db.session.commit()
    return "", 204
