"""Platform-level adoption and usage metrics for the Peira Owner Dashboard.

THE DEFINITIONS LIVE HERE, ONCE
--------------------------------
Four endpoints report overlapping numbers. If each computed its own "last
activity" or its own 7-day boundary, the overview and the organizations table
would eventually disagree about the same organization and there would be no
way to tell which was right. Same reasoning as services/attempt_scope.py.

WHAT THIS MODULE MAY SELECT
---------------------------
Aggregates and account metadata ONLY. Never question text, answer text,
explanations, feedback, drawing documents, playbook filenames, player names,
or quiz titles. The Owner Dashboard answers "who is using Peira and how
much", not "what are they installing this week" - so the queries here select
counts and timestamps, and never call to_dict() on a content model, because
those serializers return exactly the fields that must not appear.
tests/test_owner_dashboard.py fails if any of them shows up in a response.

ACTIVITY IS DERIVED, NOT TRACKED
--------------------------------
Peira records no logins, sessions or page views, and V1 deliberately adds
none. Every figure below comes from timestamps that already existed for
their own reasons. That makes organization activity accurate and coach
activity PARTIAL - see attributed_coach_activity() for exactly why.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from app.extensions import db
from app.models import (
    AccessCode,
    Answer,
    Coach,
    Folder,
    GradeAuditLog,
    Group,
    Organization,
    Player,
    PlayerAttempt,
    Question,
    QuestionType,
    Quiz,
    SourceDocument,
)
from app.models.assessment_mode import GRADED, PRACTICE

#: The reporting windows the dashboard offers. Named once so "last 7 days"
#: cannot mean 7 days in one endpoint and 7 days minus a request round-trip
#: in another.
WINDOW_DAYS = (7, 30)


def window_start(days: int, now: datetime | None = None) -> datetime:
    """The inclusive lower bound of a rolling window.

    Rolling from *now*, not a calendar boundary: "last 7 days" on the
    dashboard should mean the previous week of use, not "since Monday".
    """
    return (now or datetime.now(timezone.utc)) - timedelta(days=days)


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------

#: Every timestamp that counts as an organization DOING something with Peira.
#:
#: Each entry is (column, join-path-to-organization_id). Deliberately excluded:
#: `coaches.updated_at`, because it is written when a coach dismisses the
#: onboarding checklist or opens What's New - reading help is not usage, and
#: counting it would make every organization look permanently active.
def _organization_activity_selects():
    """SELECT organization_id, MAX(timestamp) for each kind of real work.

    Returned as a list of separate selects rather than one giant UNION query
    so each source is readable on its own and a new one is a one-line
    addition.
    """
    return [
        # Quiz built or edited.
        select(Quiz.organization_id, func.max(Quiz.updated_at)).group_by(Quiz.organization_id),
        select(Quiz.organization_id, func.max(Quiz.created_at)).group_by(Quiz.organization_id),
        # Quiz sent to players.
        select(Quiz.organization_id, func.max(AccessCode.activated_at))
        .select_from(AccessCode)
        .join(Quiz, Quiz.id == AccessCode.quiz_id)
        .group_by(Quiz.organization_id),
        # A player actually took something.
        select(Quiz.organization_id, func.max(PlayerAttempt.started_at))
        .select_from(PlayerAttempt)
        .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .group_by(Quiz.organization_id),
        select(Quiz.organization_id, func.max(PlayerAttempt.submitted_at))
        .select_from(PlayerAttempt)
        .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .group_by(Quiz.organization_id),
        # A coach graded something.
        select(Quiz.organization_id, func.max(GradeAuditLog.changed_at))
        .select_from(GradeAuditLog)
        .join(Answer, Answer.id == GradeAuditLog.answer_id)
        .join(PlayerAttempt, PlayerAttempt.id == Answer.attempt_id)
        .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .group_by(Quiz.organization_id),
        # Playbook uploaded.
        select(SourceDocument.organization_id, func.max(SourceDocument.created_at)).group_by(
            SourceDocument.organization_id
        ),
        # Roster / group / folder work.
        select(Player.organization_id, func.max(Player.updated_at)).group_by(
            Player.organization_id
        ),
        select(Group.organization_id, func.max(Group.updated_at)).group_by(Group.organization_id),
        select(Folder.organization_id, func.max(Folder.updated_at)).group_by(
            Folder.organization_id
        ),
    ]


def organization_last_activity() -> dict[int, datetime]:
    """{organization_id: when it last did something meaningful}.

    Organizations that have never done anything are ABSENT from the mapping
    rather than present with a null - the caller renders "—", and the
    distinction between "no activity" and "activity we failed to compute"
    stays visible.
    """
    latest: dict[int, datetime] = {}
    for statement in _organization_activity_selects():
        for organization_id, stamp in db.session.execute(statement):
            if organization_id is None or stamp is None:
                continue
            current = latest.get(organization_id)
            if current is None or stamp > current:
                latest[organization_id] = stamp
    return latest


def attributed_coach_activity() -> dict[int, datetime]:
    """{coach_id: last activity ATTRIBUTABLE to that coach}.

    "ATTRIBUTED" IS THE LOAD-BEARING WORD, and the UI must use it. This is
    not "last active", "last login" or "last seen", and it will UNDERCOUNT.

    Only three things in the schema name the coach who did them:

      * a quiz they created        (quizzes.coach_id + created_at)
      * a playbook they uploaded   (source_documents.uploaded_by_coach_id)
      * an answer they graded      (grade_audit_logs.coach_id + changed_at)

    Everything else is either unattributed or unreliable:

      * quizzes.updated_at   - an org admin may edit another coach's quiz, so
                               the row's coach_id is the creator, not the editor
      * folders/groups       - org-shared and editable by any member, while
                               coach_id stays the creator
      * access_codes         - no coach_id column at all, so "who sent this
                               quiz" is genuinely unknown (adding
                               activated_by_coach_id would fix it prospectively)
      * coaches.updated_at   - written by What's New and onboarding dismissal
      * logins               - not recorded anywhere

    So a coach who signs in every day to read results and never creates,
    uploads or grades will show "—". That is a limitation of the data, and it
    is stated on screen rather than papered over with a fabricated number.
    """
    latest: dict[int, datetime] = {}
    statements = [
        select(Quiz.coach_id, func.max(Quiz.created_at)).group_by(Quiz.coach_id),
        select(
            SourceDocument.uploaded_by_coach_id, func.max(SourceDocument.created_at)
        ).group_by(SourceDocument.uploaded_by_coach_id),
        select(GradeAuditLog.coach_id, func.max(GradeAuditLog.changed_at)).group_by(
            GradeAuditLog.coach_id
        ),
    ]
    for statement in statements:
        for coach_id, stamp in db.session.execute(statement):
            if coach_id is None or stamp is None:
                continue
            current = latest.get(coach_id)
            if current is None or stamp > current:
                latest[coach_id] = stamp
    return latest


# ---------------------------------------------------------------------------
# Counting helpers
# ---------------------------------------------------------------------------


def _counts_by_organization(statement) -> dict[int, int]:
    return {org_id: count for org_id, count in db.session.execute(statement) if org_id is not None}


def _scalar(statement) -> int:
    return db.session.execute(statement).scalar() or 0


def _attempt_counts_by_organization(mode: str) -> dict[int, int]:
    """Attempts of one mode per organization.

    Attempts reach an organization only through their quiz - that join is the
    single path, and getting it wrong is how a metric would silently mix
    tenants.
    """
    return _counts_by_organization(
        select(Quiz.organization_id, func.count(PlayerAttempt.id))
        .select_from(PlayerAttempt)
        .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .where(PlayerAttempt.mode == mode)
        .group_by(Quiz.organization_id)
    )


# ---------------------------------------------------------------------------
# Feature adoption
# ---------------------------------------------------------------------------

#: Adoption is EVER-USED, not frequency. Each predicate answers "has this
#: organization ever produced a row that could only exist by using the
#: feature" - derived from records the product already writes, with no
#: telemetry added. Labelled as such in the UI so it is never read as
#: "actively uses".
def _feature_organization_ids() -> dict[str, set[int]]:
    def ids(statement) -> set[int]:
        return {row[0] for row in db.session.execute(statement) if row[0] is not None}

    practice = ids(
        select(Quiz.organization_id)
        .select_from(AccessCode)
        .join(Quiz, Quiz.id == AccessCode.quiz_id)
        .where(AccessCode.mode == PRACTICE)
        .distinct()
    ) | ids(
        select(Quiz.organization_id)
        .select_from(PlayerAttempt)
        .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .where(PlayerAttempt.mode == PRACTICE)
        .distinct()
    )

    return {
        # Sent at least one quiz as practice, or had one practice attempt.
        "practice_mode": practice,
        # Uploaded a playbook. The document's existence is the signal; its
        # filename is never read.
        "playbook_quiz": ids(select(SourceDocument.organization_id).distinct()),
        "draw_response": ids(
            select(Quiz.organization_id)
            .select_from(Question)
            .join(Quiz, Quiz.id == Question.quiz_id)
            .where(Question.question_type == QuestionType.DRAW_RESPONSE)
            .distinct()
        ),
        "groups": ids(select(Group.organization_id).distinct()),
        # A folder inside another folder - the nesting feature, as opposed to
        # merely having folders at all.
        "nested_folders": ids(
            select(Folder.organization_id).where(Folder.parent_folder_id.isnot(None)).distinct()
        ),
    }


#: Display labels, kept beside the predicates so a renamed feature cannot end
#: up labelled one way on the overview and another in a future export.
FEATURE_LABELS = {
    "practice_mode": "Practice Mode",
    "playbook_quiz": "Playbook Quiz",
    "draw_response": "Draw Response",
    "groups": "Groups",
    "nested_folders": "Nested Folders",
}


def feature_adoption() -> list[dict]:
    """[{key, label, organizations}] - how many organizations have EVER used
    each feature, most-adopted first."""
    by_feature = _feature_organization_ids()
    rows = [
        {"key": key, "label": FEATURE_LABELS[key], "organizations": len(by_feature[key])}
        for key in FEATURE_LABELS
    ]
    rows.sort(key=lambda row: (-row["organizations"], row["label"]))
    return rows


# ---------------------------------------------------------------------------
# The four payloads
# ---------------------------------------------------------------------------


def platform_overview(now: datetime | None = None) -> dict:
    """Totals, rolling windows, and feature adoption.

    Every window figure is a COUNT OF THINGS CREATED OR DONE in the window,
    derived from a real timestamp. There is deliberately no DAU/MAU or login
    metric: Peira records no sessions, and inventing one from account rows
    would be a fabricated number.
    """
    now = now or datetime.now(timezone.utc)
    last_activity = organization_last_activity()

    totals = {
        "organizations": _scalar(select(func.count(Organization.id))),
        "coaches": _scalar(select(func.count(Coach.id))),
        # "Active" here is the roster flag a coach controls, not an inferred
        # engagement signal - players never log in.
        "active_players": _scalar(
            select(func.count(Player.id)).where(Player.is_active.is_(True))
        ),
        "players": _scalar(select(func.count(Player.id))),
        "quizzes": _scalar(select(func.count(Quiz.id))),
        "graded_attempts": _scalar(
            select(func.count(PlayerAttempt.id)).where(PlayerAttempt.mode == GRADED)
        ),
        "practice_attempts": _scalar(
            select(func.count(PlayerAttempt.id)).where(PlayerAttempt.mode == PRACTICE)
        ),
        "documents": _scalar(select(func.count(SourceDocument.id))),
    }

    windows = {}
    for days in WINDOW_DAYS:
        since = window_start(days, now)
        windows[str(days)] = {
            "new_organizations": _scalar(
                select(func.count(Organization.id)).where(Organization.created_at >= since)
            ),
            "new_coaches": _scalar(
                select(func.count(Coach.id)).where(Coach.created_at >= since)
            ),
            "new_quizzes": _scalar(select(func.count(Quiz.id)).where(Quiz.created_at >= since)),
            "documents_uploaded": _scalar(
                select(func.count(SourceDocument.id)).where(SourceDocument.created_at >= since)
            ),
            # Submitted, not started: a completed attempt is the meaningful
            # unit, and it matches what the coach-facing analytics count.
            "graded_attempts": _scalar(
                select(func.count(PlayerAttempt.id)).where(
                    PlayerAttempt.mode == GRADED, PlayerAttempt.submitted_at >= since
                )
            ),
            "practice_attempts": _scalar(
                select(func.count(PlayerAttempt.id)).where(
                    PlayerAttempt.mode == PRACTICE, PlayerAttempt.submitted_at >= since
                )
            ),
            "active_organizations": sum(1 for stamp in last_activity.values() if stamp >= since),
        }

    return {
        "totals": totals,
        "windows": windows,
        "feature_adoption": feature_adoption(),
        "generated_at": now.isoformat(),
    }


def organization_rows() -> list[dict]:
    """One row per organization for the owner's table.

    Built from a handful of grouped aggregates merged in Python rather than a
    query per organization: at a dozen tenants either would do, but the
    per-organization loop is the version that quietly becomes 500 queries.
    """
    coaches = _counts_by_organization(
        select(Coach.organization_id, func.count(Coach.id)).group_by(Coach.organization_id)
    )
    active_players = _counts_by_organization(
        select(Player.organization_id, func.count(Player.id))
        .where(Player.is_active.is_(True))
        .group_by(Player.organization_id)
    )
    quizzes = _counts_by_organization(
        select(Quiz.organization_id, func.count(Quiz.id)).group_by(Quiz.organization_id)
    )
    graded = _attempt_counts_by_organization(GRADED)
    practice = _attempt_counts_by_organization(PRACTICE)
    last_activity = organization_last_activity()

    rows = []
    # Only id/name/created_at are selected - an Organization has no other
    # columns worth guarding, but the explicit list is the habit that keeps
    # content out of this file.
    for org_id, name, created_at in db.session.execute(
        select(Organization.id, Organization.name, Organization.created_at)
    ):
        graded_count = graded.get(org_id, 0)
        practice_count = practice.get(org_id, 0)
        stamp = last_activity.get(org_id)
        rows.append(
            {
                "id": org_id,
                # The organization's OWN name, as it registered itself. Never
                # inferred from an email domain, IP or location.
                "name": name,
                "coaches": coaches.get(org_id, 0),
                "active_players": active_players.get(org_id, 0),
                "quizzes": quizzes.get(org_id, 0),
                "graded_attempts": graded_count,
                "practice_attempts": practice_count,
                "last_activity": stamp.isoformat() if stamp else None,
                "created_at": created_at.isoformat(),
                # DATA-DERIVED, never name-derived. Probe organizations left
                # behind by verification are found by having nothing in them,
                # not by starting with "ZZ" - inferring identity from a name
                # is the same mistake as inferring a school from an email
                # domain.
                "is_empty": (
                    active_players.get(org_id, 0) == 0
                    and quizzes.get(org_id, 0) == 0
                    and graded_count == 0
                    and practice_count == 0
                ),
            }
        )
    return rows


def organization_detail(organization: Organization) -> dict:
    """Usage counts and the coach list for one organization.

    NO PLAYER LIST and NO CONTENT: how many players, never which ones; how
    many quizzes, never their titles; how many playbooks, never their
    filenames.
    """
    org_id = organization.id

    def count(statement) -> int:
        return _scalar(statement)

    def attempts_for(mode: str) -> int:
        return count(
            select(func.count(PlayerAttempt.id))
            .select_from(PlayerAttempt)
            .join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
            .where(Quiz.organization_id == org_id, PlayerAttempt.mode == mode)
        )

    usage = {
        "coaches": count(select(func.count(Coach.id)).where(Coach.organization_id == org_id)),
        "active_players": count(
            select(func.count(Player.id)).where(
                Player.organization_id == org_id, Player.is_active.is_(True)
            )
        ),
        "players": count(select(func.count(Player.id)).where(Player.organization_id == org_id)),
        "groups": count(select(func.count(Group.id)).where(Group.organization_id == org_id)),
        "folders": count(select(func.count(Folder.id)).where(Folder.organization_id == org_id)),
        "quizzes": count(select(func.count(Quiz.id)).where(Quiz.organization_id == org_id)),
        "documents": count(
            select(func.count(SourceDocument.id)).where(SourceDocument.organization_id == org_id)
        ),
        "graded_attempts": attempts_for(GRADED),
        "practice_attempts": attempts_for(PRACTICE),
    }

    stamp = organization_last_activity().get(org_id)
    return {
        "id": org_id,
        "name": organization.name,
        "created_at": organization.created_at.isoformat(),
        "last_activity": stamp.isoformat() if stamp else None,
        "usage": usage,
        "features": [
            {**row, "used": org_id in _feature_organization_ids()[row["key"]]}
            for row in feature_adoption()
        ],
        "coaches": coach_rows(organization_id=org_id),
    }


def coach_rows(organization_id: int | None = None) -> list[dict]:
    """Coach account metadata, platform-wide or for one organization.

    Name and email ARE included: identifying and supporting an account is the
    dashboard's job and there is no way to do it from an id. password_hash is
    never selected, and invitation codes are not touched at all.
    """
    quizzes_created = {
        coach_id: total
        for coach_id, total in db.session.execute(
            select(Quiz.coach_id, func.count(Quiz.id)).group_by(Quiz.coach_id)
        )
        if coach_id is not None
    }
    activity = attributed_coach_activity()

    statement = select(
        Coach.id,
        Coach.username,
        Coach.email,
        Coach.role,
        Coach.created_at,
        Coach.is_platform_owner,
        Coach.organization_id,
        Organization.name,
    ).join(Organization, Organization.id == Coach.organization_id)
    if organization_id is not None:
        statement = statement.where(Coach.organization_id == organization_id)

    rows = []
    for (
        coach_id,
        username,
        email,
        role,
        created_at,
        is_owner,
        org_id,
        org_name,
    ) in db.session.execute(statement):
        stamp = activity.get(coach_id)
        rows.append(
            {
                "id": coach_id,
                "username": username,
                "email": email,
                "role": role.value if hasattr(role, "value") else role,
                "is_platform_owner": is_owner,
                "organization_id": org_id,
                "organization_name": org_name,
                "joined_at": created_at.isoformat(),
                "quizzes_created": quizzes_created.get(coach_id, 0),
                # None, not a fabricated date, when nothing is attributable.
                # See attributed_coach_activity for what that can and cannot
                # mean.
                "last_attributed_activity": stamp.isoformat() if stamp else None,
            }
        )
    return rows
