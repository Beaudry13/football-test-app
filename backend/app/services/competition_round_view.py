"""What a host and a player may see of the current round.

THE GATE THIS MODULE EXISTS TO ENFORCE
---------------------------------------
The correct option, the explanation, the distribution and a player's own
verdict are all THE SAME SECRET, and they are released at exactly one moment:
when the coach reveals. Before that, a phone that knew any of them would leak
the answer to whoever was standing next to it.

So there is one function that decides "has the answer been revealed", and
every field that depends on it is assembled here rather than in the routes -
two payloads deciding this separately is how one of them eventually forgets.

Peira's existing `Question.to_dict(include_correct_answers=...)` draws the same
line for the same reason; this reuses that flag rather than inventing a second
rule about what a correct answer is.
"""

from __future__ import annotations

from datetime import datetime

from app.extensions import db
from app.models import CompetitionAnswer, CompetitionParticipant, CompetitionSession, Question
from app.models.competition import LEADERBOARD, PODIUM, QUESTION_REVEAL, COMPLETE

#: Statuses in which the answer is public. QUESTION_OPEN is deliberately not
#: here - that is the whole point.
REVEALED_STATUSES = (QUESTION_REVEAL, LEADERBOARD, PODIUM, COMPLETE)


def is_revealed(session: CompetitionSession) -> bool:
    return session.status in REVEALED_STATUSES


def current_question(session: CompetitionSession) -> Question | None:
    question_id = session.question_id_for_round(session.current_round)
    return db.session.get(Question, question_id) if question_id else None


def _question_payload(question: Question, *, revealed: bool) -> dict:
    """The question as a client may render it.

    Options carry no `is_correct_answer` until the reveal - the flag comes
    from Question.to_dict's own gate, so Competition cannot accidentally
    disagree with the rest of Peira about what counts as giving the answer
    away.

    The image is passed through exactly as `/play` already serves it to
    unauthenticated players: an opaque storage URL. Competition supports only
    MULTIPLE_CHOICE and TRUE_FALSE, and a playbook-region render can only ever
    belong to a FILL_BLANK, so no signed-media audience is involved here.
    """
    data = question.to_dict(include_correct_answers=revealed)
    payload = {
        "id": data["id"],
        "question_text": data["question_text"],
        "question_type": data["question_type"],
        "image": data["image"],
        "options": [
            {
                "id": option["id"],
                "option_text": option["option_text"],
                "position": option["position"],
                **(
                    {"is_correct_answer": option.get("is_correct_answer", False)}
                    if revealed
                    else {}
                ),
            }
            for option in data["options"]
        ],
    }
    if revealed:
        # The teaching material. Withheld entirely until the reveal, exactly
        # as a graded attempt withholds it.
        payload["answer_explanation"] = data.get("answer_explanation")
        correct = next(
            (o["id"] for o in data["options"] if o.get("is_correct_answer")), None
        )
        payload["correct_option_id"] = correct
    return payload


def distribution(session: CompetitionSession) -> list[dict]:
    """How the room answered. AFTER THE REVEAL ONLY.

    Counts per option, never who chose what: publishing individual answers on
    a wall would make a wrong answer a public event with a name attached.
    Callers must not ask for this before `is_revealed`.
    """
    question = current_question(session)
    if question is None:
        return []
    counts = dict(
        db.session.query(CompetitionAnswer.selected_option_id, db.func.count())
        .filter(
            CompetitionAnswer.session_id == session.id,
            CompetitionAnswer.round_index == session.current_round,
        )
        .group_by(CompetitionAnswer.selected_option_id)
        .all()
    )
    return [
        {
            "option_id": option.id,
            "option_text": option.option_text,
            "count": counts.get(option.id, 0),
            "is_correct_answer": bool(option.is_correct_answer),
        }
        for option in question.options
    ]


def host_round(session: CompetitionSession) -> dict | None:
    """Everything the projector needs for the current round."""
    question = current_question(session)
    if question is None:
        return None
    revealed = is_revealed(session)
    payload = {
        "round_index": session.current_round,
        "round_number": session.current_round + 1,
        "total_rounds": session.total_rounds,
        "question": _question_payload(question, revealed=revealed),
        # Counts only. The host never learns WHO has not answered - naming
        # stragglers on a wall is not something this product does.
        "answered_count": session.answered_count,
        "participant_count": session.participant_count,
        "all_in": session.all_in,
        "answering_open": session.answering_open,
        "question_opened_at": (
            session.question_opened_at.isoformat() if session.question_opened_at else None
        ),
        "question_closes_at": (
            session.question_closes_at.isoformat() if session.question_closes_at else None
        ),
    }
    payload["distribution"] = distribution(session) if revealed else None
    return payload


def player_round(
    session: CompetitionSession, participant: CompetitionParticipant, now: datetime
) -> dict:
    """Everything ONE player's phone needs, and nothing about anyone else.

    Carries the player's own verdict, points and streak - but only once the
    room has seen the answer. Before that it says whether they are locked in
    and what they picked, which is all their own screen needs to render.
    """
    question = current_question(session)
    revealed = is_revealed(session)

    answer = CompetitionAnswer.query.filter_by(
        session_id=session.id,
        participant_id=participant.id,
        round_index=session.current_round,
    ).first()

    result = None
    if revealed:
        result = {
            # None rather than False when they never answered: "no answer" and
            # "wrong" deserve different words on the screen, and conflating
            # them would tell a player they got something wrong that they were
            # never given the chance to get right.
            "answered": answer is not None,
            "is_correct": bool(answer.is_correct) if answer else None,
            "points_earned": answer.points_awarded if answer else 0,
            "total_points": participant.total_points,
            "current_streak": participant.current_streak,
            "best_streak": participant.best_streak,
        }

    return {
        "round_index": session.current_round,
        "round_number": session.current_round + 1,
        "total_rounds": session.total_rounds,
        "status": session.status,
        "server_now": now.isoformat(),
        "question": _question_payload(question, revealed=revealed) if question else None,
        "question_opened_at": (
            session.question_opened_at.isoformat() if session.question_opened_at else None
        ),
        "question_closes_at": (
            session.question_closes_at.isoformat() if session.question_closes_at else None
        ),
        "answering_open": session.answering_open,
        "answered": answer is not None,
        "selected_option_id": answer.selected_option_id if answer else None,
        "result": result,
    }
