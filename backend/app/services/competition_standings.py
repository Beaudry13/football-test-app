"""Competition standings: ranking, ties and movement.

EVERYTHING HERE IS DERIVED
---------------------------
No rank is stored anywhere. Points, correct counts and ranks are all computed
from `competition_answers` rows, so standings cannot drift from the answers
that produced them, and a bug here is fixable by changing this file rather
than by repairing data.

RANKING IS POINTS ONLY, AND TIES ARE REAL
------------------------------------------
Model D already guarantees that more correct answers outrank fewer - the speed
budget is strictly smaller than one correct answer - so correct-count does not
need to participate in the sort to protect knowledge. Adding it as a
tiebreaker would only reorder players who genuinely scored the same, which is
precisely where a tie is the honest answer.

There is deliberately NO fallback tiebreaker: not participant id, not name,
not response time, not streak. Two players who scored the same share a rank.
Standard competition ranking, so three tied for second gives 1, 2, 2, 2, 5.

WHAT "PREVIOUS" MEANS
----------------------
The rank at the last leaderboard the ROOM WAS ACTUALLY SHOWN, which is what
`session.last_leaderboard_round` records. Not the previous round, and not a
live rank computed mid-question - either of those would make the arrows
describe a comparison nobody ever saw.
"""

from __future__ import annotations

from app.extensions import db
from app.models import CompetitionAnswer, CompetitionParticipant, CompetitionSession
from app.services.competition_round_view import is_revealed


def _totals(session: CompetitionSession, through_round: int | None) -> dict[int, dict]:
    """Points and correct count per participant, up to and including a round.

    `through_round` of None means "no rounds at all" - used for the previous
    standings of a competition whose leaderboard has never been shown.

    LEFT JOIN semantics by construction: every participant is seeded at zero
    first, so somebody who has never answered - because they disconnected, or
    because they simply have not got one right - still appears and still ranks.
    Dropping them would quietly shrink the room.
    """
    totals = {
        participant.id: {
            "participant_id": participant.id,
            "display_name": participant.display_name,
            "total_points": 0,
            "correct_count": 0,
            "current_streak": participant.current_streak or 0,
        }
        for participant in session.participants
    }
    if through_round is None or through_round < 0:
        return totals

    rows = (
        db.session.query(
            CompetitionAnswer.participant_id,
            db.func.coalesce(db.func.sum(CompetitionAnswer.points_awarded), 0),
            db.func.coalesce(
                db.func.sum(db.case((CompetitionAnswer.is_correct.is_(True), 1), else_=0)), 0
            ),
        )
        .filter(
            CompetitionAnswer.session_id == session.id,
            CompetitionAnswer.round_index <= through_round,
        )
        .group_by(CompetitionAnswer.participant_id)
        .all()
    )
    for participant_id, points, correct in rows:
        if participant_id in totals:
            totals[participant_id]["total_points"] = int(points or 0)
            totals[participant_id]["correct_count"] = int(correct or 0)
    return totals


def _rank(entries: list[dict]) -> list[dict]:
    """Standard competition ranking on points alone.

    Equal points share a rank, and the next distinct score skips - 1, 2, 2, 4.
    The sort key is the score and nothing else; the iteration order among
    equals is irrelevant precisely because they all receive the same rank.
    """
    ordered = sorted(entries, key=lambda entry: -entry["total_points"])
    ranked = []
    for index, entry in enumerate(ordered):
        if index > 0 and entry["total_points"] == ordered[index - 1]["total_points"]:
            entry = {**entry, "rank": ranked[-1]["rank"]}
        else:
            # Not index+1 among equals - the rank is the position of the FIRST
            # player with this score, which is what makes 1,2,2,4 come out.
            entry = {**entry, "rank": index + 1}
        ranked.append(entry)
    return ranked


def scored_through(session: CompetitionSession) -> int | None:
    """The last round whose answers have been scored.

    Scoring happens at SHOW_ANSWER, so an OPEN question contributes nothing -
    standings must not move while people are still answering, or the room
    would watch the suspense leak away a row at a time.
    """
    if not is_revealed(session):
        # Mid-question: the current round has not been revealed, so everything
        # up to the previous one is what counts.
        return session.current_round - 1 if session.current_round > 0 else None
    return session.current_round


def scored_round_count(session: CompetitionSession) -> int:
    """The denominator: how many rounds have actually been played and scored.

    Not the frozen quiz length - a competition that has played 9 of 15 shows
    "8 / 9", not "8 / 15" - and not counting the open round. Rounds skipped
    because their question was deleted are simply never reached, so they never
    enter this count either.
    """
    through = scored_through(session)
    return 0 if through is None else through + 1


def standings(session: CompetitionSession) -> list[dict]:
    """The full ranked table, with movement against the last shown leaderboard.

    Returned for everyone; the callers decide who sees how much of it. The
    host renders the top few, a player sees only their own row - but the
    ranking itself is computed once, here, so the two can never disagree.
    """
    current = _rank(list(_totals(session, scored_through(session)).values()))

    baseline = session.last_leaderboard_round
    previous_rank = {}
    if baseline is not None:
        for entry in _rank(list(_totals(session, baseline).values())):
            previous_rank[entry["participant_id"]] = entry["rank"]

    total_rounds_scored = scored_round_count(session)
    result = []
    for entry in current:
        was = previous_rank.get(entry["participant_id"])
        result.append(
            {
                **entry,
                "scored_rounds": total_rounds_scored,
                "previous_rank": was,
                # Positive = climbed. None when the room has never been shown
                # standings, which the client renders as NEW rather than
                # pretending somebody moved from a rank nobody saw.
                "movement": None if was is None else was - entry["rank"],
            }
        )
    return result


def top(session: CompetitionSession, limit: int = 5) -> list[dict]:
    """The projector's table.

    Five, not thirty: a wall of names is unreadable from the back of a room
    and makes placement meaningless. Everyone else sees their own position on
    their own phone.

    Ties at the boundary are kept whole - if three players are tied for fifth,
    showing two of them and cutting the third would be arbitrary.
    """
    table = standings(session)
    if len(table) <= limit:
        return table
    cutoff_rank = table[limit - 1]["rank"]
    return [entry for entry in table if entry["rank"] <= cutoff_rank]


def standing_for(session: CompetitionSession, participant: CompetitionParticipant) -> dict | None:
    """One player's own row. Never anybody else's.

    Carries the same aggregate numbers the projector shows, and nothing about
    how anyone answered - not even their own selections, which the round view
    already handles at the right moment.
    """
    # Computed ONCE. Counting the ties from a second standings() call ran the
    # whole ranking twice per player request - measured as 4 SELECTs against
    # 3, on a path that thirty phones hit simultaneously the moment the board
    # goes up. Constant-factor waste rather than an N x N, but free to remove.
    table = standings(session)
    for entry in table:
        if entry["participant_id"] == participant.id:
            return {
                **entry,
                # How many share this rank, so a phone can honestly say "tied
                # 2nd" rather than implying sole possession of the place.
                "tied": sum(1 for other in table if other["rank"] == entry["rank"]),
            }
    return None
