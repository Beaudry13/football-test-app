"""Question CRUD, reordering, and image/annotation management.

Nested under /api/quizzes/<quiz_id>/questions. Every route re-verifies that
the caller may edit the parent quiz, so a coach can never mutate another
organization's data - or a teammate's quiz they didn't create.
"""

import json

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required
from marshmallow import ValidationError

from app.errors import ApiError
from app.extensions import db
from app.models import (
    Answer,
    DocumentPage,
    Question,
    QuestionImage,
    QuestionOption,
    QuestionRegion,
    QuestionType,
    Quiz,
)
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
from app.services.question_snapshots import historical_image_preserved
from app.utils.auth import current_coach, get_editable_quiz
from app.utils.validation import load_json_body

questions_bp = Blueprint("questions", __name__)


def _get_editable_question(quiz_id: int, question_id: int) -> Question:
    quiz = get_editable_quiz(quiz_id)
    question = Question.query.filter_by(id=question_id, quiz_id=quiz.id).first()
    if question is None:
        raise ApiError("Question not found", status_code=404)
    return question


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
        return data, request.files.get("image")

    return load_json_body(QuestionCreateSchema()), None


@questions_bp.post("/<int:quiz_id>/questions")
@jwt_required()
def create_question(quiz_id: int):
    """Create a question, and its image if one was sent, in ONE operation.

    Everything commits together or nothing does. A rejected image - wrong type,
    too large, corrupt - leaves no question behind, which is the whole point:
    the old two-request flow could not fail halfway without stranding a
    placeholder that a coach then had to find and delete.
    """
    quiz = get_editable_quiz(quiz_id)
    data, uploaded_image = _create_payload()
    validate_options_for_type(data["question_type"], data["options"])

    next_position = data["position"]
    if next_position is None:
        next_position = len(quiz.questions)

    question = Question(
        quiz_id=quiz.id,
        question_text=data["question_text"],
        answer_explanation=(data.get("answer_explanation") or None),
        question_type=QuestionType(data["question_type"]),
        position=next_position,
    )
    db.session.add(question)
    db.session.flush()
    _replace_options(question, data["options"])

    # Written to storage before the commit, so a commit failure would leave the
    # bytes orphaned. Tracked and removed on any failure - the same discipline
    # the document upload uses, and the reason the two halves cannot disagree.
    stored_url: str | None = None
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

        db.session.commit()
    except Exception:
        db.session.rollback()
        if stored_url:
            get_file_storage().delete_image(stored_url)
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


def _apply_region(question: Question, page: DocumentPage, rect: dict) -> QuestionRegion:
    """Create or move this question's single region. `rect` must already have
    been through `_validated_rect`.

    V1 permits exactly one region per question. The schema allows several so
    that hotspots and multi-part questions are additive later; the limit lives
    here, where it can be lifted without a migration.
    """
    region = question.regions[0] if question.regions else None
    if region is None:
        region = QuestionRegion(question_id=question.id, position=0, role=RegionRole.MASK)
        db.session.add(region)
        question.regions.append(region)
    else:
        # The rectangle moved, so the cached masked render is now covering the
        # wrong pixels. Dropping it here rather than lazily is the difference
        # between a resized mask and a mask that still shows the answer.
        invalidate_masked_render(region)

    region.document_page_id = page.id
    region.x = rect["x"]
    region.y = rect["y"]
    region.width = rect["width"]
    region.height = rect["height"]
    return region


@questions_bp.post("/<int:quiz_id>/questions/from-region")
@jwt_required()
def create_region_question(quiz_id: int):
    """Create a Fill in the Blank question from a rectangle on a playbook page.

    Separate from `create_question` rather than folded into it: this one needs
    a page, a rectangle and a set of accepted answers, none of which any other
    question type has, and merging them would make both signatures a union of
    fields that are each only valid for one branch.
    """
    quiz = get_editable_quiz(quiz_id)
    data = load_json_body(RegionQuestionCreateSchema())
    page = _org_document_page(data["document_page_id"])
    rect = _validated_rect(data["region"])

    expected = clean_expected_answers(data["expected_answers"])
    if not expected:
        raise ApiError(
            "Add at least one accepted answer that isn't blank.", status_code=422
        )

    position = data["position"]
    if position is None:
        position = len(quiz.questions)

    question = Question(
        quiz_id=quiz.id,
        question_text=data["question_text"],
        question_type=QuestionType.FILL_BLANK,
        position=position,
        expected_answers=expected,
        answer_matching=data["answer_matching"] or DEFAULT_MODE,
        answer_explanation=(data.get("answer_explanation") or None),
    )
    db.session.add(question)
    db.session.flush()

    _apply_region(question, page, rect)
    db.session.commit()
    return jsonify(question.to_dict(include_correct_answers=True)), 201


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

    if "question_text" in data:
        question.question_text = data["question_text"]

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
    if "options" in data:
        validate_options_for_type(question_type, data["options"])
        _reject_if_already_answered(question, "change this question's answer options")

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

    if "question_text" in data:
        question.question_text = data["question_text"]

    # Deliberately NOT guarded by _reject_if_already_answered: the explanation
    # is teaching material shown after the fact, so improving it changes
    # nobody's score and a coach should be able to refine it at any time.
    if "answer_explanation" in data:
        question.answer_explanation = data["answer_explanation"] or None
    if "question_type" in data:
        question.question_type = QuestionType(data["question_type"])
    if "options" in data:
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
