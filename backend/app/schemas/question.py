"""Question request schemas.

Cross-field business rules (how many options a question type needs, that
exactly one is correct, etc.) are enforced in the route layer via
`validate_options_for_type` rather than here, since marshmallow's
conditional validation across a polymorphic payload gets unreadable fast.
"""

from marshmallow import Schema, fields, validate

from app.errors import ApiError
from app.models import QuestionType
from app.models.question import OPTIONLESS_TYPES
from app.services.answer_matching import VALID_MODES

QUESTION_TYPE_VALUES = [t.value for t in QuestionType]
MATCHING_MODES = sorted(VALID_MODES)


class QuestionOptionSchema(Schema):
    option_text = fields.Str(required=True, validate=validate.Length(min=1, max=500))
    is_correct_answer = fields.Bool(required=False, load_default=False)


#: Optional coaching note shown in Practice Mode after a player answers.
#: Declared once and reused, so create and edit cannot drift apart -
#: a coach must be able to write it in the same flow either way.
_ANSWER_EXPLANATION = fields.Str(
    required=False, allow_none=True, load_default=None, validate=validate.Length(max=2000)
)


class QuestionCreateSchema(Schema):
    question_text = fields.Str(required=True, validate=validate.Length(min=1))
    question_type = fields.Str(required=True, validate=validate.OneOf(QUESTION_TYPE_VALUES))
    #: NULL is a real choice, not a missing value - it reads as "General".
    concept_id = fields.Int(required=False, load_default=None, allow_none=True)
    options = fields.List(fields.Nested(QuestionOptionSchema), required=False, load_default=list)
    #: "Select all that apply". Multiple choice only - validated below.
    allows_multiple_answers = fields.Bool(required=False, load_default=False)
    position = fields.Int(required=False, load_default=None)
    answer_explanation = _ANSWER_EXPLANATION
    document_page_id = fields.Int(required=False, load_default=None, allow_none=True)
    region = fields.Nested(lambda: RegionSchema(), required=False, load_default=None, allow_none=True)
    expected_answers = fields.List(
        fields.Str(), required=False, load_default=None, allow_none=True,
        validate=validate.Length(min=1, max=25),
    )
    answer_matching = fields.Str(
        required=False, load_default=None, allow_none=True,
        validate=validate.OneOf(MATCHING_MODES),
    )


class QuestionUpdateSchema(Schema):
    question_text = fields.Str(required=False, validate=validate.Length(min=1))
    question_type = fields.Str(required=False, validate=validate.OneOf(QUESTION_TYPE_VALUES))
    #: NULL is a real choice, not a missing value - it reads as "General".
    #: NO load_default: absence must remain absent, so a partial edit that
    #: never mentions the concept cannot silently clear an existing tag.
    concept_id = fields.Int(required=False, allow_none=True)
    options = fields.List(fields.Nested(QuestionOptionSchema), required=False)
    allows_multiple_answers = fields.Bool(required=False)
    # Editable in the same form that created it - no second screen.
    answer_explanation = fields.Str(
        required=False, allow_none=True, validate=validate.Length(max=2000)
    )


class RegionSchema(Schema):
    """A rectangle in normalised 0-1 page coordinates. The range is checked
    again in `document_geometry.validate_normalised_rect`, which owns the rule;
    these bounds only reject obvious nonsense before it gets that far."""

    x = fields.Float(required=True)
    y = fields.Float(required=True)
    width = fields.Float(required=True)
    height = fields.Float(required=True)


class RegionQuestionCreateSchema(Schema):
    """Creating a Fill in the Blank question from a rectangle on a page.

    `question_text` is required and typed by the coach. V1 deliberately does
    NOT generate it from the surrounding line: the spike measured reading order
    at 63-77% on every real playbook page, so a generated prompt would often be
    scrambled and the coach would be proof-reading rather than writing. See
    docs/DESIGN-playbook-quiz.md §0b decision 11.
    """

    document_page_id = fields.Int(required=True)
    question_text = fields.Str(required=True, validate=validate.Length(min=1))
    expected_answers = fields.List(
        fields.Str(), required=True, validate=validate.Length(min=1, max=25)
    )
    answer_matching = fields.Str(
        required=False, load_default=None, allow_none=True, validate=validate.OneOf(MATCHING_MODES)
    )
    region = fields.Nested(RegionSchema, required=True)
    position = fields.Int(required=False, load_default=None)
    # Fill in the Blank is auto-graded, which makes it the type where a
    # practice explanation is most useful - so it is offered here too rather
    # than only on the plain question form.
    answer_explanation = _ANSWER_EXPLANATION


class RegionQuestionUpdateSchema(Schema):
    """Editing a region-backed question. Every field optional - the editor
    sends only what changed."""

    question_text = fields.Str(required=False, validate=validate.Length(min=1))
    expected_answers = fields.List(
        fields.Str(), required=False, validate=validate.Length(min=1, max=25)
    )
    answer_matching = fields.Str(
        required=False, allow_none=True, validate=validate.OneOf(MATCHING_MODES)
    )
    region = fields.Nested(RegionSchema, required=False)
    answer_explanation = fields.Str(
        required=False, allow_none=True, validate=validate.Length(max=2000)
    )


class QuestionReorderSchema(Schema):
    question_ids = fields.List(fields.Int(), required=True, validate=validate.Length(min=1))


class AnnotationsUpdateSchema(Schema):
    annotations = fields.List(fields.Dict(), required=True)
    canvas_width = fields.Int(required=False, allow_none=True, load_default=None)


def validate_options_for_type(
    question_type: str, options: list[dict], allows_multiple_answers: bool = False
) -> None:
    """Raises ApiError(422) - same status as marshmallow validation failures,
    since this is the same class of error (semantically invalid payload),
    just enforced in Python because it's a cross-field business rule."""
    if question_type in {t.value for t in OPTIONLESS_TYPES}:
        # None of these is answered by picking from a list. A Draw Response
        # question may still HAVE option rows - one converted from multiple
        # choice by migration d2b5f8a41c32 keeps them, inert - but it never
        # requires them, and authoring one never creates them.
        return

    if question_type == QuestionType.TRUE_FALSE.value:
        if len(options) != 2:
            raise ApiError("True/false questions must have exactly 2 options", status_code=422)
    elif question_type == QuestionType.MULTIPLE_CHOICE.value:
        if len(options) < 2:
            raise ApiError("Multiple choice questions need at least 2 options", status_code=422)

    correct_count = sum(1 for option in options if option.get("is_correct_answer"))

    if allows_multiple_answers:
        # "SELECT ALL THAT APPLY". At least one correct answer, and at least two
        # options to choose between - anything less is not a question.
        #
        # EXACTLY ONE CORRECT ANSWER IS DELIBERATELY ALLOWED. "Select all that
        # apply" where only one does is a legitimate question, and refusing it
        # would be the product second-guessing the coach about their own
        # material.
        if correct_count < 1:
            raise ApiError(
                "Mark at least one option as correct", status_code=422
            )
        if len(options) < 2:
            raise ApiError(
                "A question needs at least 2 options", status_code=422
            )
        return

    if correct_count != 1:
        raise ApiError("Exactly one option must be marked as the correct answer", status_code=422)
