"""LOAD A QUIZ'S RESULTS INPUTS ONCE, not once per question or per player.

The quiz dashboard (Results' weakest concepts, Home's Next up, an install's
meeting) and an install's quiz status read every question's options and
concept, and the quiz's roster with each player. Left to lazy loading that is
a query per question and per player - fine on a fixture, slow on a 100-player
roster (tests/test_connected_performance).

WHY set_committed_value, NOT A BARE PRELOAD QUERY: the session's identity map
holds objects WEAKLY. A preload whose result is thrown away is garbage
collected before the builders run, and the next lazy load makes fresh
instances without the eager-loaded attributes. Handing the loaded collections
to the quiz keeps them alive - and makes `quiz.questions` / `quiz.roster`
read them without another query.
"""

from sqlalchemy.orm import joinedload, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app.models import Answer, AttemptStatus, PlayerAttempt, Question, Quiz, Roster, RosterPlayer
from app.services.attempt_scope import official_only


def preload_results_inputs(quiz: Quiz) -> None:
    """quiz.questions (with options and concept) and quiz.roster (with each
    player), loaded in one query apiece and installed on the quiz. Read-only:
    for requests that build a report, never ones that edit the quiz."""
    questions = (
        Question.query.filter(Question.quiz_id == quiz.id)
        .options(selectinload(Question.options), joinedload(Question.concept))
        .order_by(Question.position, Question.id)
        .all()
    )
    set_committed_value(quiz, "questions", questions)
    roster = (
        Roster.query.filter(Roster.quiz_id == quiz.id)
        .options(selectinload(Roster.players).selectinload(RosterPlayer.player))
        .first()
    )
    set_committed_value(quiz, "roster", roster)


def submitted_official_attempts(quiz: Quiz) -> list[PlayerAttempt]:
    """The quiz's submitted official attempts, with everything a results
    builder reads loaded up front: each answer's selection set JOINED onto the
    answers (zero extra queries at any size), each attempt's player in one
    query, and the quiz's questions and roster via preload_results_inputs."""
    responses = (
        official_only(PlayerAttempt.query)
        .filter_by(quiz_id=quiz.id, status=AttemptStatus.SUBMITTED)
        .options(
            selectinload(PlayerAttempt.answers).joinedload(Answer.selected_options),
            selectinload(PlayerAttempt.player),
        )
        .all()
    )
    preload_results_inputs(quiz)
    return responses
