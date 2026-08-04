"""Player Progress Analytics: the one shared place average scores,
review-threshold flags, and roster/group/position/org rollups are
computed - so the Player Profile, the organization Player Progress page,
and any future surface never disagree the way separate ad-hoc
calculations across quiz cards / grading dashboard / player history used
to risk.

DEFINITIONS (audited against the existing codebase before writing this -
see the branch's own planning notes for the full reasoning):

- ASSIGNED: a PlayerAttempt row exists for this player_id (in_progress or
  submitted). NOT "was on the eligible roster for some past activation" -
  that's computed *live* from current Group membership with no historical
  snapshot (effective_roster_players() reads group.players as it is
  *today*), so using it would make a Player's assigned count silently
  drift when a coach edits Group membership later. That breaks "historical
  assignment must not disappear" the moment a removed Player's old,
  already-expired activation is re-evaluated. The attempt-row definition
  is also exactly what GET /players/<id>/history already implemented and
  what the FV-7 regression test already covers.
- COMPLETED: PlayerAttempt.status == SUBMITTED. Matches list_quizzes,
  quiz_dashboard, and get_player_history - all three already agree on
  this.
- AVERAGE SCORE: correct / graded, counting only Answer rows with
  is_correct set (auto-graded at answer time, or manually graded written
  answers) - "calculated from graded questions only", the exact rule
  list_quizzes and quiz_dashboard already use. A pending (ungraded)
  written answer is excluded from both the numerator and the denominator;
  it is never treated as incorrect.
- RESET ATTEMPTS: reset_attempt (grading.py) hard-deletes the row, so
  nothing extra is needed here - a reset attempt was never counted
  because it no longer exists by the time any of this runs.
- MULTIPLE ATTEMPTS: the DB allows at most one PlayerAttempt per
  (access_code_id, player_id), but a Player can attempt the *same* quiz
  again if a coach reactivates it later under a new access code. Each
  attempt is a separate, real assignment/completion - analytics never
  collapse to "latest" or "highest," matching how PlayerProfilePage's
  recent_results already displays every attempt without deduplication.
- INACTIVE PLAYERS: every function here works identically regardless of
  Player.is_active - history and analytics are always preserved. Only the
  org-wide roster list (compute_org_roster) defaults to active-only,
  matching the Master Roster page's own default filter.

REVIEW THRESHOLD: fixed at 80% (REVIEW_THRESHOLD_PERCENT below) - the
brief's own recommended lowest-risk first version. No existing
configurable-threshold setting was found anywhere in the codebase. An
org-level override is a reasonable next step but was deliberately
deferred to keep this change reviewable (see the final report).
"""

from __future__ import annotations

from sqlalchemy import case, func
from sqlalchemy.orm import contains_eager, selectinload

from app.extensions import db
from app.models import (
    AccessCode,
    Answer,
    AttemptStatus,
    GroupPlayer,
    Player,
    PlayerAttempt,
)

REVIEW_THRESHOLD_PERCENT = 80.0

# A trend needs at least this many chronological, *scored* (graded) results
# to say anything at all - one data point has no direction.
MIN_TREND_RESULTS = 2

# A comparison average (Group/position/org) needs at least this many
# distinct Players contributing before it's shown as meaningful, rather
# than a single Player's score dressed up as a "group average."
MIN_COMPARISON_SAMPLE_PLAYERS = 3

# A trend is only called "improving"/"declining" when the second-half vs
# first-half average differs by more than this many percentage points;
# anything smaller reads as "flat" rather than manufacturing noise into a
# direction.
TREND_FLAT_BAND_POINTS = 3.0


def _score_percent(correct: int, graded: int) -> float | None:
    """The one place `correct / graded` happens. `graded` is a count of
    Answer rows with is_correct set (not `None`) - see AVERAGE SCORE
    above. Returns None (never 0%) when nothing is graded yet."""
    return round(100 * correct / graded, 1) if graded else None


def _review_status(score_percent: float | None) -> str | None:
    """Review status for one SUBMITTED attempt. None for an attempt that
    isn't submitted yet - review doesn't apply to something not turned
    in."""
    if score_percent is None:
        return "pending_grading"
    return "needs_review" if score_percent < REVIEW_THRESHOLD_PERCENT else "strong"


def _trend(scored_rows_chronological: list[dict]) -> dict:
    """`scored_rows_chronological`: oldest-first list of {..., "score_percent"}
    for SUBMITTED attempts only. Filters to the ones actually graded
    (score_percent is not None) before deciding whether there's enough
    data - an ungraded pending attempt contributes no signal either way.
    """
    scored = [r for r in scored_rows_chronological if r["score_percent"] is not None]
    if len(scored) < MIN_TREND_RESULTS:
        return {"available": False, "direction": None, "points": []}

    points = [{"date": r["submitted_at"], "score_percent": r["score_percent"]} for r in scored]
    mid = len(scored) // 2 or 1
    first_half = scored[:mid]
    second_half = scored[mid:] or scored[-1:]
    first_avg = sum(r["score_percent"] for r in first_half) / len(first_half)
    second_avg = sum(r["score_percent"] for r in second_half) / len(second_half)
    diff = second_avg - first_avg
    if diff > TREND_FLAT_BAND_POINTS:
        direction = "improving"
    elif diff < -TREND_FLAT_BAND_POINTS:
        direction = "declining"
    else:
        direction = "flat"
    return {"available": True, "direction": direction, "points": points}


def compute_player_analytics(player: Player) -> dict:
    """Everything the Player Profile needs in one pass over this Player's
    own attempts: summary, full history (most-recent-first), and trend.
    Bounded to one Player's attempts (realistically dozens, not
    thousands), so a straightforward eager-loaded ORM pass is appropriate
    here - the batched, query-count-sensitive path is compute_org_roster
    below, used for the whole-organization page instead.
    """
    attempts = (
        PlayerAttempt.query.filter_by(player_id=player.id)
        .options(
            selectinload(PlayerAttempt.answers),
            selectinload(PlayerAttempt.quiz),
            selectinload(PlayerAttempt.access_code).selectinload(AccessCode.groups),
        )
        .order_by(PlayerAttempt.started_at.asc())
        .all()
    )

    assigned_count = len(attempts)
    completed_count = 0
    total_correct = 0
    total_graded = 0
    below_threshold_count = 0
    pending_grading_count = 0
    history_chronological = []

    for attempt in attempts:
        correct = sum(1 for a in attempt.answers if a.is_correct is True)
        graded = sum(1 for a in attempt.answers if a.is_correct is not None)
        score_percent = _score_percent(correct, graded)
        is_completed = attempt.status == AttemptStatus.SUBMITTED

        review_status = None
        if is_completed:
            completed_count += 1
            total_correct += correct
            total_graded += graded
            review_status = _review_status(score_percent)
            if review_status == "needs_review":
                below_threshold_count += 1
            elif review_status == "pending_grading":
                pending_grading_count += 1

        groups = (
            [{"id": g.id, "name": g.name} for g in attempt.access_code.groups]
            if attempt.access_code
            else []
        )

        history_chronological.append(
            {
                "attempt_id": attempt.id,
                "quiz_id": attempt.quiz_id,
                "quiz_title": attempt.quiz.title if attempt.quiz else "Deleted quiz",
                "started_at": attempt.started_at.isoformat(),
                "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
                "completion_status": "completed" if is_completed else "incomplete",
                "score_percent": score_percent,
                "review_status": review_status,
                "correct_count": correct,
                "graded_count": graded,
                "group_source": groups,
            }
        )

    completion_percent = (
        round(100 * completed_count / assigned_count, 1) if assigned_count else None
    )
    average_score_percent = _score_percent(total_correct, total_graded)
    last_completed_at = next(
        (r["submitted_at"] for r in reversed(history_chronological) if r["completion_status"] == "completed"),
        None,
    )

    group_rows = (
        GroupPlayer.query.filter_by(player_id=player.id)
        .options(selectinload(GroupPlayer.group))
        .all()
    )
    current_groups = [{"id": gp.group.id, "name": gp.group.name} for gp in group_rows if gp.group]

    trend = _trend(history_chronological)

    return {
        "summary": {
            "assigned_count": assigned_count,
            "completed_count": completed_count,
            "completion_percent": completion_percent,
            "average_score_percent": average_score_percent,
            "below_threshold_count": below_threshold_count,
            "pending_grading_count": pending_grading_count,
            "last_completed_at": last_completed_at,
            "current_groups": current_groups,
            "review_threshold_percent": REVIEW_THRESHOLD_PERCENT,
        },
        "history": list(reversed(history_chronological)),
        "trend": trend,
    }


def compute_missed_questions(player: Player, limit: int = 25) -> list[dict]:
    """Evidence-based only, per the brief: shows exact questions this
    Player answered incorrectly on a SUBMITTED attempt, and how many times
    that *exact* question (same question_id) was missed - never an
    inferred "concept," since no question tagging/category system exists
    to support that claim. Pending (ungraded) written answers are excluded
    by the is_correct.is_(False) filter itself - only a question that has
    actually been marked wrong counts as a miss.
    """
    answers = (
        Answer.query.join(PlayerAttempt, Answer.attempt_id == PlayerAttempt.id)
        .filter(
            PlayerAttempt.player_id == player.id,
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
            Answer.is_correct.is_(False),
        )
        .options(
            selectinload(Answer.question),
            contains_eager(Answer.attempt).selectinload(PlayerAttempt.quiz),
        )
        .order_by(PlayerAttempt.submitted_at.desc())
        .all()
    )

    by_question: dict[int, dict] = {}
    for answer in answers:
        question = answer.question
        if question is None:
            continue
        entry = by_question.get(question.id)
        if entry is None:
            preview = question.question_text.strip()
            if len(preview) > 120:
                preview = preview[:117].rstrip() + "…"
            entry = {
                "question_id": question.id,
                "quiz_id": question.quiz_id,
                "quiz_title": answer.attempt.quiz.title if answer.attempt.quiz else "Deleted quiz",
                "question_number": question.position + 1,
                "question_preview": preview,
                "miss_count": 0,
                "most_recent_missed_at": answer.attempt.submitted_at.isoformat()
                if answer.attempt.submitted_at
                else None,
            }
            by_question[question.id] = entry
        entry["miss_count"] += 1

    missed = sorted(by_question.values(), key=lambda e: (-e["miss_count"], e["quiz_title"]))
    return missed[:limit]


def _comparison_stats(player_ids: list[int]) -> dict:
    """One aggregate query: average score, how many graded answers it's
    based on, and how many distinct Players actually contributed a
    SUBMITTED attempt - the "explain the sample size" requirement. Never
    averages individual Players' percentages together (which would
    mis-weight a Player with 2 attempts the same as one with 20) - it sums
    raw correct/graded counts across every attempt first, matching the
    exact same building block every other average in this module uses.
    """
    if not player_ids:
        return {
            "average_score_percent": None,
            "graded_answer_count": 0,
            "player_count": 0,
            "sufficient_data": False,
        }

    correct, graded, player_count = (
        db.session.query(
            func.coalesce(func.sum(case((Answer.is_correct.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((Answer.is_correct.isnot(None), 1), else_=0)), 0),
            func.count(func.distinct(PlayerAttempt.player_id)),
        )
        .select_from(PlayerAttempt)
        .outerjoin(Answer, Answer.attempt_id == PlayerAttempt.id)
        .filter(
            PlayerAttempt.player_id.in_(player_ids),
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
        )
        .first()
    )
    correct, graded, player_count = int(correct), int(graded), int(player_count)
    return {
        "average_score_percent": _score_percent(correct, graded),
        "graded_answer_count": graded,
        "player_count": player_count,
        "sufficient_data": player_count >= MIN_COMPARISON_SAMPLE_PLAYERS,
    }


def compute_comparisons(player: Player) -> dict:
    """Player-vs-Group(s)/position/organization, all from the same
    _comparison_stats building block so none of them can disagree on what
    "average" means. If the Player belongs to more than one Group, every
    Group is shown separately rather than picking one or blending them."""
    own = _comparison_stats([player.id])

    group_rows = (
        GroupPlayer.query.filter_by(player_id=player.id)
        .options(selectinload(GroupPlayer.group))
        .all()
    )
    group_comparisons = []
    for gp in group_rows:
        if gp.group is None:
            continue
        member_ids = [
            m.player_id
            for m in GroupPlayer.query.filter_by(group_id=gp.group_id)
            .filter(GroupPlayer.player_id.isnot(None))
            .all()
        ]
        group_comparisons.append(
            {"group_id": gp.group.id, "group_name": gp.group.name, **_comparison_stats(member_ids)}
        )

    position_comparison = None
    if player.position:
        position_ids = [
            p.id
            for p in Player.query.filter_by(
                organization_id=player.organization_id, position=player.position
            ).all()
        ]
        position_comparison = {"position": player.position, **_comparison_stats(position_ids)}

    org_ids = [p.id for p in Player.query.filter_by(organization_id=player.organization_id).all()]
    org_comparison = _comparison_stats(org_ids)

    return {
        "player": own,
        "groups": group_comparisons,
        "position": position_comparison,
        "organization": org_comparison,
    }


def compute_org_roster(organization_id: int, include_inactive: bool = False) -> dict:
    """Batched, N+1-free rollup for the whole organization's Player
    Progress page. Every Player's assigned/completed/average/trend/last-
    activity comes from at most a handful of queries total, regardless of
    how many Players or attempts exist - see the module docstring's
    ASSIGNED/COMPLETED/AVERAGE SCORE definitions, applied identically here.
    """
    players_query = Player.query.filter_by(organization_id=organization_id)
    if not include_inactive:
        players_query = players_query.filter_by(is_active=True)
    players = players_query.all()
    player_ids = [p.id for p in players]

    if not player_ids:
        return {"players": [], "summary": _org_summary([], None, REVIEW_THRESHOLD_PERCENT)}

    # 1. Assigned count per player (every attempt, any status).
    assigned_counts = dict(
        db.session.query(PlayerAttempt.player_id, func.count(PlayerAttempt.id))
        .filter(PlayerAttempt.player_id.in_(player_ids))
        .group_by(PlayerAttempt.player_id)
        .all()
    )

    # 2. One row per SUBMITTED attempt (player_id, submitted_at, correct,
    # graded) - grouped in Python below per player so completed count,
    # average, trend, and last-activity all come from this single query.
    attempt_rows = (
        db.session.query(
            PlayerAttempt.player_id,
            PlayerAttempt.submitted_at,
            func.coalesce(func.sum(case((Answer.is_correct.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((Answer.is_correct.isnot(None), 1), else_=0)), 0),
        )
        .select_from(PlayerAttempt)
        .outerjoin(Answer, Answer.attempt_id == PlayerAttempt.id)
        .filter(
            PlayerAttempt.player_id.in_(player_ids),
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
        )
        .group_by(PlayerAttempt.id, PlayerAttempt.player_id, PlayerAttempt.submitted_at)
        .order_by(PlayerAttempt.submitted_at.asc())
        .all()
    )
    by_player: dict[int, list[dict]] = {pid: [] for pid in player_ids}
    for player_id, submitted_at, correct, graded in attempt_rows:
        by_player[player_id].append(
            {
                "submitted_at": submitted_at.isoformat() if submitted_at else None,
                "score_percent": _score_percent(int(correct), int(graded)),
            }
        )

    # 3. Current Group memberships, for the Group filter/column.
    group_rows = (
        GroupPlayer.query.filter(GroupPlayer.player_id.in_(player_ids))
        .options(selectinload(GroupPlayer.group))
        .all()
    )
    groups_by_player: dict[int, list[dict]] = {}
    for gp in group_rows:
        if gp.group is None:
            continue
        groups_by_player.setdefault(gp.player_id, []).append({"id": gp.group.id, "name": gp.group.name})

    # 4. Weighted correct/graded per player, from the same underlying
    # answer counts as above but grouped only by player_id - this is the
    # one query the per-player average AND the org-wide average both read
    # from, so neither can end up using a differently-weighted number.
    weighted: dict[int, tuple[int, int]] = {pid: (0, 0) for pid in player_ids}
    weighted_query = (
        db.session.query(
            PlayerAttempt.player_id,
            func.coalesce(func.sum(case((Answer.is_correct.is_(True), 1), else_=0)), 0),
            func.coalesce(func.sum(case((Answer.is_correct.isnot(None), 1), else_=0)), 0),
        )
        .select_from(PlayerAttempt)
        .outerjoin(Answer, Answer.attempt_id == PlayerAttempt.id)
        .filter(
            PlayerAttempt.player_id.in_(player_ids),
            PlayerAttempt.status == AttemptStatus.SUBMITTED,
        )
        .group_by(PlayerAttempt.player_id)
        .all()
    )
    for player_id, correct, graded in weighted_query:
        weighted[player_id] = (int(correct), int(graded))

    result_rows = []
    for player in players:
        scored_attempts = by_player.get(player.id, [])
        assigned_count = assigned_counts.get(player.id, 0)
        completed_count = len(scored_attempts)
        completion_percent = (
            round(100 * completed_count / assigned_count, 1) if assigned_count else None
        )
        correct, graded = weighted.get(player.id, (0, 0))
        average_score_percent = _score_percent(correct, graded)
        below_threshold_count = sum(
            1
            for a in scored_attempts
            if a["score_percent"] is not None and a["score_percent"] < REVIEW_THRESHOLD_PERCENT
        )
        last_activity = scored_attempts[-1]["submitted_at"] if scored_attempts else None
        trend = _trend(scored_attempts)

        result_rows.append(
            {
                "player": player.to_dict(),
                "assigned_count": assigned_count,
                "completed_count": completed_count,
                "completion_percent": completion_percent,
                "average_score_percent": average_score_percent,
                "below_threshold_count": below_threshold_count,
                "needs_review": below_threshold_count > 0,
                "last_activity_at": last_activity,
                "trend_direction": trend["direction"],
                "current_groups": groups_by_player.get(player.id, []),
            }
        )

    # Org-wide average score: sum the same weighted correct/graded pairs
    # every row above was built from, rather than averaging the per-player
    # percentages together (which would let a Player with 2 attempts count
    # as much as one with 200).
    org_correct = sum(c for c, _ in weighted.values())
    org_graded = sum(g for _, g in weighted.values())
    org_average_score_percent = _score_percent(org_correct, org_graded)

    return {
        "players": result_rows,
        "summary": _org_summary(result_rows, org_average_score_percent, REVIEW_THRESHOLD_PERCENT),
    }


def _org_summary(rows: list[dict], average_score_percent: float | None, threshold: float) -> dict:
    total_active = len(rows)
    incomplete = sum(1 for r in rows if r["assigned_count"] > r["completed_count"])
    below_threshold = sum(1 for r in rows if r["needs_review"])
    no_recent_activity = sum(1 for r in rows if r["last_activity_at"] is None)

    total_assigned = sum(r["assigned_count"] for r in rows)
    total_completed = sum(r["completed_count"] for r in rows)
    completion_rate = round(100 * total_completed / total_assigned, 1) if total_assigned else None

    return {
        "total_active_players": total_active,
        "players_with_incomplete_assignments": incomplete,
        "players_below_threshold": below_threshold,
        "average_score_percent": average_score_percent,
        "completion_rate": completion_rate,
        "players_with_no_recent_activity": no_recent_activity,
        "review_threshold_percent": threshold,
    }
