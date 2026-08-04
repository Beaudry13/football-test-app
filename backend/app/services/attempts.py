"""Player-attempt lookup and answer-upsert logic shared by the /play routes
that write to an in-progress attempt (autosave and submit's final sync) -
both need identical question/option validation and identical is_correct
computation, so it lives here once rather than being duplicated per route.
"""

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.errors import ApiError
from app.extensions import db
from app.models import Answer, PlayerAttempt, Question


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
    """
    if player_id is not None:
        by_id = PlayerAttempt.query.filter_by(
            access_code_id=access_code_id, player_id=player_id
        ).first()
        if by_id is not None:
            return by_id
        # Falls through only to an unlinked legacy attempt with this exact
        # name (player_id IS NULL) - e.g. one created before this player was
        # given a canonical id. Never to another canonical player's attempt
        # that merely happens to share a display name - that's exactly the
        # collision two same-name Players (e.g. two "Chris Smith"s) must
        # not hit, and the plain name-only query below would have matched
        # either one indiscriminately.
        return PlayerAttempt.query.filter_by(
            access_code_id=access_code_id, player_name=player_name, player_id=None
        ).first()
    return PlayerAttempt.query.filter_by(
        access_code_id=access_code_id, player_name=player_name
    ).first()


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
