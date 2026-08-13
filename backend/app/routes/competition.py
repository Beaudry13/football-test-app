"""Competition Mode HTTP surface.

TWO AUDIENCES, ONE BLUEPRINT
-----------------------------
Coach routes are JWT-authenticated and organization-scoped. Player routes are
public and authenticated by the join code alone - a player has no account, the
same as `/play`. They live together because they operate on one state machine
and splitting them invites a rule enforced on one side only.

THE POLL IS SEPARATE FROM THE PAYLOAD, DELIBERATELY
----------------------------------------------------
`GET /<code>/state` is the once-a-second heartbeat: one indexed row read, five
scalars, no joins. `GET /<code>` is the heavier view - roster, participants,
quiz title - and clients fetch it only when the poll's `version` changes.
Collapsing the two would put a participant join on every phone every second.

RATE LIMITING IS HANDLED, NOT DISABLED
---------------------------------------
A whole team shares one Wi-Fi NAT, so an IP-keyed limit would treat thirty
players as one abusive client and lock the room out of its own competition.
The rules below are therefore keyed by join code or by the acting player, and
the heartbeat carries no limit at all - it is cheaper than the 429 response
would be. Nothing global is loosened: `default_limits` is already empty and
stays that way.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db, limiter
from app.models import Group, Player
from app.models.competition import COMPLETE, LEADERBOARD, PODIUM
from app.schemas.competition import (
    CreateCompetitionSchema,
    JoinCompetitionSchema,
    SubmitAnswerSchema,
    TransitionSchema,
)
from app.services import competition as svc
from app.services import competition_answers as answers
from app.services import competition_round_view as round_view
from app.services import competition_podium as podium_svc
from app.services import competition_standings as standings_svc
from app.services import competition_rounds as rounds
from app.utils.auth import current_coach, get_visible_quiz
from app.utils.validation import load_json_body, load_optional_json_body

competition_bp = Blueprint("competition", __name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


#: Player-private requests carry the seat token in a header rather than the URL.
#: A path or query parameter would land in access logs, browser history and
#: Referer headers - a credential should not be written down in any of those.
PLAYER_TOKEN_HEADER = "X-Competition-Token"


def _player_token() -> str:
    return (request.headers.get(PLAYER_TOKEN_HEADER) or "").strip()


# ===========================================================================
# COACH
# ===========================================================================


@competition_bp.get("/quizzes/<int:quiz_id>/readiness")
@jwt_required()
def readiness(quiz_id: int):
    """Can this quiz be run as a competition, and if not, exactly why.

    The setup screen calls this before offering a Start button, so the coach
    learns which questions are unsupported while they can still act on it -
    not after gathering a room.
    """
    quiz = get_visible_quiz(quiz_id)
    return jsonify(svc.launch_readiness(quiz))


@competition_bp.post("/quizzes/<int:quiz_id>")
@jwt_required()
def create(quiz_id: int):
    quiz = get_visible_quiz(quiz_id)
    # load_json_body, not schema.load: the shared helper is what turns a
    # marshmallow ValidationError into a 422. Calling load() directly lets
    # it escape as a 500 - which is exactly what it did until a test caught it.
    data = load_optional_json_body(CreateCompetitionSchema())

    # Group ids are re-checked against this organization before they are
    # stored: a stored id from another tenant would be a permanent hole in
    # eligibility, and eligible_players() would have to defend against it on
    # every read instead of once here.
    group_ids = data.get("group_ids") or []
    if group_ids:
        coach = current_coach()
        owned = {
            g.id
            for g in Group.query.filter(
                Group.organization_id == coach.organization_id, Group.id.in_(group_ids)
            ).all()
        }
        unknown = set(group_ids) - owned
        if unknown:
            raise ApiError("One or more selected groups no longer exist.", status_code=404)

    session = svc.create_session(
        quiz,
        current_coach(),
        group_ids=group_ids,
        question_time_seconds=data.get("question_time_seconds"),
    )
    return jsonify(_host_view(session)), 201


@competition_bp.get("/sessions/<int:session_id>")
@jwt_required()
def host_view(session_id: int):
    """The host's full view. Fetched on version change, not on a timer."""
    session = svc.coach_session(session_id, current_coach())
    return jsonify(_host_view(session))


@competition_bp.get("/active")
@jwt_required()
def active():
    """Is there a competition this coach should be pulled back into?

    THE SMALLEST DISCOVERY SURFACE THAT WORKS. It answers one question - what
    is live for me right now - and returns only what a "Return to competition"
    banner needs to render: the code to navigate to, the quiz name, and how
    many players are waiting. No history, no other coach's rooms, no
    participant identities.

    Called on the coach screens where recovery makes sense, not polled.
    """
    sessions = svc.active_sessions_for(current_coach())
    return jsonify(
        [
            {
                "id": session.id,
                "join_code": session.join_code,
                "quiz_id": session.quiz_id,
                "quiz_title": session.quiz.title if session.quiz else None,
                "status": session.status,
                # A count, not a roster - the same rule as the poll.
                "participant_count": session.participant_count,
                "created_at": session.created_at.isoformat(),
                "expires_at": session.expires_at.isoformat(),
            }
            for session in sessions
        ]
    )


@competition_bp.get("/sessions/by-code/<join_code>")
@jwt_required()
def host_view_by_code(join_code: str):
    """Resolve a join code to the host view - the coach's reconnect path.

    The host lobby is addressed by join code (that is what is on the
    projector and in the coach's URL bar), but every other host route is
    addressed by session id, and the PUBLIC lobby payload deliberately does
    not carry an id. Without this, a coach who refreshed the page had no way
    back into their own room - which frontend work surfaced immediately.

    Ownership is not relaxed to make that convenient: this goes through the
    same coach_session() check as every other host route, so a coach from
    another organization gets the same 404 they would get from an id, and the
    join code reveals nothing it did not already reveal publicly.
    """
    session = svc.session_by_code(join_code)
    session = svc.coach_session(session.id, current_coach())
    return jsonify(_host_view(session))


@competition_bp.get("/sessions/<int:session_id>/state")
@jwt_required()
def host_state(session_id: int):
    """The host's heartbeat - the same tiny payload the players get."""
    session = svc.coach_session(session_id, current_coach())
    return jsonify(session.poll_state(_now()))


@competition_bp.delete("/sessions/<int:session_id>/participants/<int:participant_id>")
@jwt_required()
def remove_participant(session_id: int, participant_id: int):
    session = svc.coach_session(session_id, current_coach())
    svc.remove_participant(session, participant_id)
    return jsonify(_host_view(session))


@competition_bp.post("/sessions/<int:session_id>/transition")
@jwt_required()
def transition(session_id: int):
    """THE ONLY WAY THE ROOM MOVES FORWARD.

    One endpoint rather than six (start / reveal / leaderboard / next /
    finish / advance), because the legality of a move depends on the state
    it is made from, and that rule lives in exactly one table. Six endpoints
    would be six places for it to drift.
    """
    session = svc.coach_session(session_id, current_coach())
    data = load_json_body(TransitionSchema())
    rounds.transition(session, data["action"], data["expected_version"])
    return jsonify(_host_view(session))


@competition_bp.post("/sessions/<int:session_id>/end")
@jwt_required()
def end(session_id: int):
    session = svc.coach_session(session_id, current_coach())
    # THIS CONTROL ALWAYS ABANDONS. It is the "stop, we are not doing this"
    # button, wherever the room happens to be.
    #
    # It used to compute `abandoned = status == LOBBY`, which was correct in M1
    # because LOBBY was the only non-terminal state a session could be in - the
    # COMPLETE branch was unreachable. Once M2.1-M2.5 added rounds, standings
    # and the podium, ending mid-round started taking that branch and marking a
    # cancelled event COMPLETE.
    #
    # That became user-visible once M2.6 gave COMPLETE real meaning for
    # players: a coach who bailed out mid-question left every phone showing
    # "YOUR FINAL RESULT" and the projector showing a podium, for a
    # competition nobody finished.
    #
    # COMPLETE is now reachable only by walking the podium to its end, which
    # is the only place it means what it says.
    svc.end_session(session, abandoned=True)
    return jsonify(_host_view(session))


def _host_view(session) -> dict:
    data = session.to_dict(include_participants=True)
    eligible = svc.eligible_players(session)
    joined = {p.player_id for p in session.participants}
    data["eligible_count"] = len(eligible)
    # Who has NOT arrived yet - the thing a coach actually scans the room for.
    # NOTE this is the LOBBY roster, not "who has not answered": names of
    # players still answering are never published, on the projector or here.
    data["not_joined"] = [e for e in eligible if e["player_id"] not in joined]
    # The buttons this screen may offer, derived from the same transition
    # table the server enforces - so a button can never exist for a move that
    # would be refused.
    data["available_actions"] = rounds.available_actions(session)
    data["leaderboard_hint"] = rounds.leaderboard_hint(session)
    data["answered_count"] = session.answered_count
    data["all_in"] = session.all_in
    data["answering_open"] = session.answering_open
    # The current question, and - only once revealed - the correct option,
    # the explanation and the distribution. Gated in one place; see
    # competition_round_view.
    data["round"] = round_view.host_round(session)
    # The projector's table. Only while the room is being shown standings -
    # computing it during a question would be work nobody can see, and
    # exposing it would leak the suspense the reveal exists to build.
    data["standings"] = (
        standings_svc.top(session) if session.status == LEADERBOARD else None
    )
    data["scored_rounds"] = standings_svc.scored_round_count(session)
    data["last_leaderboard_round"] = session.last_leaderboard_round
    # The ending. Present once the room has reached the podium, and kept
    # available at COMPLETE so the final screen has something to render.
    data["podium"] = (
        podium_svc.podium(session) if session.status in (PODIUM, COMPLETE) else None
    )
    return data


# ===========================================================================
# PLAYER (public - the join code is the only credential)
# ===========================================================================


@competition_bp.get("/<join_code>/state")
def poll(join_code: str):
    """THE HOT PATH. One indexed row, five scalars, no joins, no rate limit.

    Thirty phones at 1 Hz is thirty requests a second, each cheaper than the
    429 an IP-keyed limit would have to generate for a team behind one NAT.
    Adding a limit here would not protect the database; it would break the
    feature for exactly the rooms it is built for.
    """
    session = svc.session_by_code(join_code)
    return jsonify(session.poll_state(_now()))


@competition_bp.get("/<join_code>")
# Keyed by join code, not IP: a whole team behind one Wi-Fi router must not
# share a bucket.
#
# THE NUMBER IS ARITHMETIC, NOT A GUESS. This is fetched on version change,
# and every arrival bumps the version, so an N-player lobby filling up costs
# roughly N x N fetches concentrated in the join window. A 60-player room is
# ~3600 requests over two or three minutes. The first version of this limit
# was 240/min and the load harness produced 150 rate-limited players in a
# thirty-player room - the feature limiting itself out of its own lobby.
#
# 1800/min covers a room twice the size we expect while still bounding a
# scripted client hammering one code. The client also coalesces these to at
# most one every two seconds (see useCompetitionPoll), so the realistic peak
# is well under this - the headroom is for the burst, not the steady state.
@limiter.limit("1800 per minute", key_func=lambda: (request.view_args or {}).get("join_code", ""))
def lobby(join_code: str):
    """The player-facing view: who may play, who has joined, and the state."""
    session = svc.session_by_code(join_code)
    if session.is_terminal:
        raise svc.CompetitionError(
            "This competition has ended.", status_code=410, reason="session_ended"
        )
    joined = {p.player_id for p in session.participants}
    return jsonify(
        {
            "join_code": session.join_code,
            "status": session.status,
            "version": session.version,
            "quiz_title": session.quiz.title if session.quiz else None,
            "question_time_seconds": session.question_time_seconds,
            "server_now": _now().isoformat(),
            # The identity picker. Canonical ids only - no free-text name box,
            # so a player cannot invent an identity or claim someone else's.
            "roster": [
                {**entry, "taken": entry["player_id"] in joined}
                for entry in svc.eligible_players(session)
            ],
            "participants": [
                {"id": p.id, "display_name": p.display_name} for p in session.participants
            ],
        }
    )


@competition_bp.post("/<join_code>/join")
# Keyed by (code, player) so one phone retrying cannot lock out the room, and
# so a script cannot walk the roster from a single IP unchecked.
@limiter.limit(
    "30 per minute",
    key_func=lambda: (
        f"{(request.view_args or {}).get('join_code', '')}:"
        f"{(request.get_json(silent=True) or {}).get('player_id', '')}"
    ),
)
def join(join_code: str):
    session = svc.session_by_code(join_code)
    data = load_json_body(JoinCompetitionSchema())
    participant = svc.join(
        session,
        data["player_id"],
        reconnect_token=data.get("reconnect_token") or _player_token() or None,
    )
    return jsonify(
        {
            "participant": participant.to_dict(),
            # THE ONLY RESPONSE THAT EVER CONTAINS THE TOKEN. The client stores
            # it and replays it as X-Competition-Token; it appears in no list,
            # no host view, and no other player's payload.
            "reconnect_token": participant.reconnect_token,
            "join_code": session.join_code,
            "status": session.status,
            "version": session.version,
        }
    ), 200


@competition_bp.post("/<join_code>/answer")
def submit_answer(join_code: str):
    """Answer the current question.

    Returns ONLY that the answer was accepted and what was chosen. Never
    whether it was right, never the correct option, never the explanation and
    never the points - a phone that knew the answer before the room did would
    leak it to anyone standing nearby. All of that arrives at the reveal.
    """
    session = svc.session_by_code(join_code)
    participant = svc.participant_by_token(session, _player_token())
    data = load_json_body(SubmitAnswerSchema())
    answer = answers.submit_answer(
        session,
        participant,
        round_index=data["round_index"],
        option_id=data["option_id"],
    )
    return jsonify(
        {
            "accepted": True,
            "locked": True,
            "round_index": answer.round_index,
            "selected_option_id": answer.selected_option_id,
            "status": session.status,
            "version": session.version,
        }
    ), 201


@competition_bp.get("/<join_code>/round")
def player_round(join_code: str):
    """The current question, for one player's phone.

    Token-addressed, because the payload contains that player's own answer
    state - and, after the reveal, their own verdict and points. Nothing in
    here describes anybody else.
    """
    session = svc.session_by_code(join_code)
    participant = svc.participant_by_token(session, _player_token())
    participant.last_seen_at = _now()
    db.session.commit()
    payload = round_view.player_round(session, participant, _now())
    # A player's OWN standing, resolved from the token - never from an id in
    # the request, and never anybody else's row. Present only once the room is
    # being shown standings, so a phone cannot read the ranking early.
    payload["standing"] = (
        standings_svc.standing_for(session, participant)
        if session.status == LEADERBOARD
        else None
    )
    # During the podium a phone follows the room: the same step, plus this
    # player's own final result so it can say "that's you" at the right beat.
    # Resolved from the token, like everything else private.
    payload["podium"] = (
        podium_svc.podium(session) if session.status in (PODIUM, COMPLETE) else None
    )
    payload["final_result"] = (
        podium_svc.final_result_for(session, participant)
        if session.status in (PODIUM, COMPLETE)
        else None
    )
    return jsonify(payload)


@competition_bp.get("/<join_code>/me")
def resume(join_code: str):
    """Reconnect. Addressed by TOKEN, never by player id.

    The previous version of this route took the player id in the path and
    authenticated with (join_code, player_id). Both are public - the code is
    read off a projector and the roster endpoint publishes every id so the
    picker can render - so it authenticated with nothing at all. It is gone.

    A refresh or a locked screen must not cost a player their seat, so this
    stays a cheap GET; it just requires the secret the seat was issued with.
    """
    session = svc.session_by_code(join_code)
    participant = svc.participant_by_token(session, _player_token())
    participant.last_seen_at = _now()
    db.session.commit()
    return jsonify(
        {
            "participant": participant.to_dict(),
            "status": session.status,
            "version": session.version,
            "server_now": _now().isoformat(),
            # So a refresh mid-question comes back to a locked screen rather
            # than an answerable one. Carries no verdict - see answer_state.
            "answer": answers.answer_state(session, participant),
        }
    )
