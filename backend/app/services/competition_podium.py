"""The ending: podium places and final standings.

THE SLOT RULE, WHICH IS THE WHOLE DESIGN
-----------------------------------------
Standings use standard competition ranking, so ranks skip after a tie: two
players tied at the top produce 1, 1, 3 - and there is NO SECOND PLACE. That
is not a gap to paper over; it is what actually happened.

So a podium place is defined as "whoever holds rank N", and a place with
nobody in it is EMPTY rather than filled by promoting the next player up.
Promoting somebody into a second place they did not earn would invent a result
the scoreboard never showed.

WHY EMPTY PLACES ARE ANNOUNCED RATHER THAN SKIPPED
---------------------------------------------------
The step sequence stays fixed - card, third, second, first, standings - even
when a place is empty. Two reasons:

  * `podium_step` keeps a stable meaning across a refresh, a second host tab
    and every phone in the room. A sequence whose length depends on the tie
    shape would have to be recomputed identically everywhere.
  * "There is no second place - two players tied for first" is a better
    moment than silently jumping from third to first, and it is true.

Nothing here ranks anything. It reads the standings the leaderboard already
produced, so the podium and the final table can never disagree about who won.
"""

from __future__ import annotations

from app.models import CompetitionSession
from app.models.competition import (
    PODIUM_FIRST,
    PODIUM_SECOND,
    PODIUM_STANDINGS,
    PODIUM_THIRD,
)
from app.services import competition_standings as standings_svc

#: Which rank each reveal step is about. The card and the standings step are
#: not about a single place, so they are absent.
STEP_PLACE = {
    PODIUM_THIRD: 3,
    PODIUM_SECOND: 2,
    PODIUM_FIRST: 1,
}


def place_holders(table: list[dict], place: int) -> list[dict]:
    """Everyone holding this exact rank. Possibly nobody.

    No promotion and no fallback: if the standings jump 1, 1, 3 then asking
    for second place correctly returns an empty list.
    """
    return [row for row in table if row["rank"] == place]


def podium(session: CompetitionSession) -> dict:
    """The ending, as the room is currently seeing it.

    Carries every place - not just the one on screen - so a client can render
    the current step and a refreshed client can render the same one without a
    second request. Which step is live is `podium_step`; the payload does not
    decide that.
    """
    table = standings_svc.standings(session)
    places = {
        place: place_holders(table, place) for place in (1, 2, 3)
    }
    return {
        "step": session.podium_step,
        "last_step": PODIUM_STANDINGS,
        "places": {
            str(place): [
                {
                    "participant_id": row["participant_id"],
                    "display_name": row["display_name"],
                    "rank": row["rank"],
                    "total_points": row["total_points"],
                    "correct_count": row["correct_count"],
                    "scored_rounds": row["scored_rounds"],
                }
                for row in rows
            ]
            for place, rows in places.items()
        },
        # A place nobody holds. The client says so out loud rather than
        # skipping the beat or promoting somebody into it.
        "empty_places": [place for place, rows in places.items() if not rows],
        "winners": [row["display_name"] for row in places[1]],
        "final_standings": [
            {
                "participant_id": row["participant_id"],
                "display_name": row["display_name"],
                "rank": row["rank"],
                "total_points": row["total_points"],
                "correct_count": row["correct_count"],
                "scored_rounds": row["scored_rounds"],
                "best_streak": _best_streak(session, row["participant_id"]),
            }
            # EVERYONE, not a top five. The competition is over; there is no
            # suspense left to protect, and a player who came 19th is still
            # part of the result.
            for row in table
        ],
    }


def _best_streak(session: CompetitionSession, participant_id: int) -> int:
    for participant in session.participants:
        if participant.id == participant_id:
            return participant.best_streak or 0
    return 0


def final_result_for(session: CompetitionSession, participant) -> dict | None:
    """One player's own ending. Never anybody else's.

    Reuses the leaderboard's own standing so the number on a phone and the
    number on the projector come from one calculation.
    """
    standing = standings_svc.standing_for(session, participant)
    if standing is None:
        return None
    return {
        **standing,
        "best_streak": participant.best_streak or 0,
        # Whether this player is part of the place currently being revealed,
        # so a phone can say "that's you" at the right moment.
        "is_winner": standing["rank"] == 1,
    }
