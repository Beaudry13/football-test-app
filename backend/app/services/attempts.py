"""Player-attempt lookup and answer-upsert logic shared by the /play routes
that write to an in-progress attempt (autosave and submit's final sync) -
both need identical question/option validation and identical is_correct
computation, so it lives here once rather than being duplicated per route.
"""

import random
from datetime import datetime, timezone

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.errors import ApiError
from app.extensions import db
from app.models import Answer, AnswerDrawing, PlayerAttempt, Question, QuestionType
from app.models.answer_drawing import document_has_strokes
from app.models.question import TEXT_ANSWER_TYPES
from app.services.answer_matching import matches


def find_attempt(
    access_code_id: int, player_name: str, player_id: int | None = None
) -> PlayerAttempt | None:
    """The attempt for this (access_code, player) pair, if one exists.

    Every mutating /play route re-derives the attempt this way rather than
    trusting a client-supplied attempt id - the id is a guessable
    sequential PK, and (access_code_id, player_name) [or, for a canonical
    player, (access_code_id, player_id)] is exactly the same
    proof-of-eligibility a player already demonstrated by holding a valid
    code and picking a roster-matched name, the same trust model /submit
    used even before attempts existed.

    `player_id`, when given, is checked first and is the only lookup that
    can tell two same-name canonical Players apart - falling through to
    `player_name` would ambiguously match either one. A legacy caller
    (no player_id) keeps the original name-only behavior unchanged.
    NEWEST FIRST. A graded code can only ever hold one attempt per player -
    the database enforces that - but a practice code holds one per retake, and
    an unordered `.first()` would resume whichever row Postgres happened to
    return, dropping the player back into an attempt they finished last week.
    """
    if player_id is not None:
        by_id = (
            PlayerAttempt.query.filter_by(access_code_id=access_code_id, player_id=player_id)
            .order_by(PlayerAttempt.id.desc())
            .first()
        )
        if by_id is not None:
            return by_id
        # Falls through only to an unlinked legacy attempt with this exact
        # name (player_id IS NULL) - e.g. one created before this player was
        # given a canonical id. Never to another canonical player's attempt
        # that merely happens to share a display name - that's exactly the
        # collision two same-name Players (e.g. two "Chris Smith"s) must
        # not hit, and the plain name-only query below would have matched
        # either one indiscriminately.
        return (
            PlayerAttempt.query.filter_by(
                access_code_id=access_code_id, player_name=player_name, player_id=None
            )
            .order_by(PlayerAttempt.id.desc())
            .first()
        )
    return (
        PlayerAttempt.query.filter_by(
            access_code_id=access_code_id, player_name=player_name
        )
        .order_by(PlayerAttempt.id.desc())
        .first()
    )


def upsert_answer(
    attempt: PlayerAttempt,
    question_id: int,
    selected_option_id: int | None,
    answer_text: str | None,
) -> Answer:
    """Create or update the one Answer row for (attempt, question_id).

    Grading for auto-gradable question types happens here, not deferred to
    submit - is_correct is a pure function of the current selection, so
    it's safe (and simpler) to compute it on every save rather than only
    once at the end.

    Does not commit - the caller owns the transaction boundary, since
    submit's final sync calls this once per answer and must commit exactly
    once, alongside locking the attempt.

    Uses a real upsert (INSERT ... ON CONFLICT DO UPDATE) rather than
    check-then-insert: two writes for the same question can race in
    practice (a debounce timer firing alongside a fresh option click, or a
    browser retry), and a naive insert-if-not-found would 500 against
    uq_one_answer_per_question_per_attempt under that race instead of
    just resolving to "whichever value arrived last wins."
    """
    question = Question.query.filter_by(id=question_id, quiz_id=attempt.quiz_id).first()
    if question is None:
        raise ApiError(f"Question {question_id} does not belong to this quiz", status_code=422)

    is_correct = None
    if selected_option_id is not None:
        option = next((o for o in question.options if o.id == selected_option_id), None)
        if option is None:
            raise ApiError(
                f"Option {selected_option_id} does not belong to question {question_id}",
                status_code=422,
            )
        is_correct = option.is_correct_answer
    elif question.question_type is QuestionType.FILL_BLANK:
        # Auto-graded here, on every save, exactly as a selected option is -
        # is_correct is a pure function of what the player has typed.
        #
        # Blank text stays None rather than becoming False. A player who never
        # answered has not answered *wrongly*, and scoring them 0 for it is
        # precisely the "fabricating 0% when nothing is graded" that CLAUDE.md
        # forbids. `score = correct / (correct + incorrect)` therefore ignores
        # them, as it does for every other type.
        if (answer_text or "").strip():
            is_correct = matches(
                answer_text, question.expected_answers, question.answer_matching
            )

    stmt = pg_insert(Answer).values(
        attempt_id=attempt.id,
        question_id=question_id,
        answer_text=answer_text,
        selected_option_id=selected_option_id,
        is_correct=is_correct,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["attempt_id", "question_id"],
        set_={
            "answer_text": stmt.excluded.answer_text,
            "selected_option_id": stmt.excluded.selected_option_id,
            "is_correct": stmt.excluded.is_correct,
        },
    ).returning(Answer.id)
    answer_id = db.session.execute(stmt).scalar_one()
    return db.session.get(Answer, answer_id)


# --- Answer presence ------------------------------------------------------
#
# The Phase 0 audit found sixteen places that decided, separately, whether a
# question had been answered. Every one of them missed drawings. This is the
# single backend rule; `require_all_answers` and anything else that asks the
# question calls it rather than re-deriving it.
#
# Deliberately NOT written as "if it is a drawing question, ignore text":
# a Draw Response question is planned to optionally also require a written
# explanation or a choice, so this asks what the type REQUIRES rather than
# assuming what it excludes.


def is_answered(question: Question, answer: Answer | None) -> bool:
    """Whether `answer` carries real content for `question`'s type.

    An Answer row existing is not enough - upsert_answer creates one for a
    blank autosave too, so a cleared text box or a deselected option must
    still count as unanswered.
    """
    if answer is None:
        return False

    if question.question_type is QuestionType.DRAW_RESPONSE:
        return answer.drawing is not None and document_has_strokes(answer.drawing.document)

    # Both typed types, asked together: a FILL_BLANK left blank is unanswered
    # for exactly the same reason a WRITTEN one is, and splitting them here
    # would be the first place the two could drift.
    if question.question_type in TEXT_ANSWER_TYPES:
        return bool((answer.answer_text or "").strip())

    return answer.selected_option_id is not None


class DrawingConflict(Exception):
    """Raised when a client saves against a revision the server has moved past."""

    def __init__(self, current_revision: int):
        super().__init__("This drawing was updated somewhere else")
        self.current_revision = current_revision


def upsert_drawing(
    attempt: PlayerAttempt,
    question_id: int,
    document: dict,
    base_revision: int | None,
    force: bool = False,
) -> AnswerDrawing:
    """Create or replace the one drawing for (attempt, question).

    Writes through an Answer row, creating a blank one if the player has not
    otherwise answered - the drawing IS the answer for a Draw Response
    question, and `answer_drawings.answer_id` is NOT NULL.

    Does not commit; the caller owns the transaction, so submit can write
    several drawings and lock the attempt in one go.

    `base_revision` is the revision the client last saw. Sending a stale one
    raises DrawingConflict rather than overwriting: autosave plus a player
    switching devices makes that race routine, and a drawing lost this way
    would be minutes of work with no undo.
    """
    question = Question.query.filter_by(id=question_id, quiz_id=attempt.quiz_id).first()
    if question is None:
        raise ApiError(f"Question {question_id} does not belong to this quiz", status_code=422)
    if question.question_type is not QuestionType.DRAW_RESPONSE:
        raise ApiError(f"Question {question_id} does not accept a drawing", status_code=422)

    answer = Answer.query.filter_by(attempt_id=attempt.id, question_id=question_id).first()
    if answer is None:
        answer = upsert_answer(attempt, question_id, None, None)

    existing = answer.drawing
    if existing is None:
        drawing = AnswerDrawing(answer_id=answer.id, document=document, revision=1)
        db.session.add(drawing)
        return drawing

    # `force` is submit's escape hatch. Submit re-sends the client's current
    # document as a safety net, and must not 409 against the player's OWN
    # earlier autosave - that would block them from finishing over a race
    # they caused themselves. Autosave never forces.
    if not force:
        # None means "I have no revision yet", which only a client that never
        # read one should send. Treated as a conflict when a drawing already
        # exists, since overwriting on the strength of "I did not check" is
        # exactly what this guard is for.
        if base_revision is None or base_revision < existing.revision:
            raise DrawingConflict(existing.revision)

    existing.document = document
    existing.revision = existing.revision + 1
    return existing


def existing_answer(attempt, question_id: int):
    """The answer already recorded for this question on this attempt, if any."""
    return Answer.query.filter_by(attempt_id=attempt.id, question_id=question_id).first()


def is_checked(attempt, question_id: int) -> bool:
    """Whether this practice question has already been checked, and is
    therefore locked. Cheap enough to call on every save."""
    answer = existing_answer(attempt, question_id)
    return answer is not None and answer.checked_at is not None


def mark_checked(attempt, question_id: int) -> Answer:
    """Stamp one practice answer as checked and return it.

    Idempotent on the timestamp - a double-tap on "Check Answer" re-reads the
    same feedback rather than moving the clock, so the record stays "when the
    player first saw this". Does not commit; the caller owns the transaction.

    Creates a blank answer row when none exists, which is what a player
    skipping a question and pressing Check looks like: they have used up their
    shot at it in this attempt, and the explanation is now visible.
    """
    answer = existing_answer(attempt, question_id)
    if answer is None:
        answer = upsert_answer(attempt, question_id, None, None)
    if answer.checked_at is None:
        answer.checked_at = datetime.now(timezone.utc)
    return answer


def practice_feedback(attempt, answer) -> dict:
    """What a player is told immediately after checking an answer.

    HONESTY IS THE WHOLE DESIGN. `is_correct` is returned ONLY for question
    types Peira can actually grade - the auto-gradable ones, where the value
    was already computed at save time. Short Answer and Draw Response return
    it as None, and the client shows "Response recorded" rather than inventing
    a verdict a coach has not given.

    The correct answer itself is never included. The coach's explanation is
    the teaching mechanism; if they want the answer revealed, they write it
    there.
    """
    from app.models.question import AUTO_GRADABLE_TYPES

    question = answer.question
    auto_gradable = question.question_type in AUTO_GRADABLE_TYPES

    return {
        "question_id": question.id,
        "auto_gradable": auto_gradable,
        # None for anything a coach must grade by hand.
        "is_correct": answer.is_correct if auto_gradable else None,
        "answer_explanation": question.answer_explanation or None,
    }

# ---------------------------------------------------------------------------
# Question order
# ---------------------------------------------------------------------------


def authored_question_ids(quiz) -> list[int]:
    """The quiz's own order. `Quiz.questions` is ordered by Question.position,
    so this is simply what the coach authored."""
    return [question.id for question in quiz.questions]


def frozen_question_order(quiz, *, randomize: bool, rng=None) -> list[int] | None:
    """The order to FREEZE on a new attempt, or None for authored order.

    Returning None rather than the authored list is deliberate: NULL already
    means "authored order" for every pre-existing attempt and every graded
    one, so storing an explicit copy would create a second representation of
    the same thing - and one that silently goes stale when the coach reorders
    the quiz.

    `rng` is the test seam. Production passes nothing and gets Python's
    `random.shuffle`, which is a Fisher-Yates over a Mersenne Twister - an
    unbiased permutation. The `sort(() => Math.random() - 0.5)` idiom is not
    just biased, it is undefined behaviour for a comparator; nothing here does
    that, and no ordering is ever computed in a SELECT.
    """
    if not randomize:
        return None
    ids = authored_question_ids(quiz)
    # Nothing to shuffle: an empty list would be indistinguishable from "no
    # questions yet" downstream, and a single question has exactly one order.
    if len(ids) < 2:
        return None
    shuffled = list(ids)
    (rng or random).shuffle(shuffled)
    return shuffled


def presented_question_ids(attempt, quiz) -> list[int]:
    """The order to SHOW, reconciled against the quiz as it exists now.

    The stored order is a historical fact and is never rewritten - a coach
    editing the quiz mid-attempt must not retroactively change what the player
    was given. So reconciliation happens here, at read time:

      1. stored ids that still exist, in the order they were frozen
      2. then any question added since, in current authored order
      3. deleted questions simply fall out

    That covers both directions of drift without corrupting the attempt: a
    deleted question disappears rather than 404-ing mid-quiz, and an added one
    appears at the end rather than vanishing from a quiz that claims to have
    it.
    """
    live = authored_question_ids(quiz)
    stored = attempt.question_order
    if not stored:
        return live

    live_set = set(live)
    kept = [qid for qid in stored if qid in live_set]
    seen = set(kept)
    appended = [qid for qid in live if qid not in seen]
    return kept + appended

