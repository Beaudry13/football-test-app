"""What a coach still has to do before Peira is working for them.

DERIVED, NEVER STORED
---------------------
Every step's completion is computed from real application data on each
request. Nothing anywhere records "step 3 is done". That is the central
decision in this file and it buys three things:

  * A coach who joins an organization that already has a roster and groups
    is past those steps on their very first login - no backfill, no special
    case, no "invited coach" branch. The org-scoped steps simply read as
    complete because the data is there.
  * It cannot go stale. Delete every player and the roster step un-ticks,
    which is the truth. A stored flag would keep claiming a roster exists.
  * It was already correct for every account that existed before this file
    did, retroactively, at zero cost.

The single exception is dismissal (`coaches.onboarding_dismissed_at`).
That is a preference, not a fact about the data, so there is nothing to
derive it from. It is the ONLY onboarding state this system persists, and
new steps must not add more.

SCOPE IS THE "JOINED AN EXISTING ORG" FEATURE
---------------------------------------------
Each step is scoped to either the coach or the organization:

  COACH        first quiz, first question, activate, assign to a group
  ORGANIZATION roster, groups, players in groups

Roster and groups are shared infrastructure - if the team already has them,
you are done, whoever built them. Quizzes are not: Coach View is own-only
(see services/quiz_scope), so a teammate's quiz is genuinely not *your*
first quiz and ticking that step off the back of one would be a lie.

That single field is the whole of the "an invited coach only sees the steps
they actually need" requirement. There is no separate code path for it.

ONBOARDING ENDS WHERE THE COACH'S CONTROL ENDS
-----------------------------------------------
Every step here is something a coach can finish alone, at their desk, right
now. "A player completed a quiz" deliberately is NOT a step - it depends on
a teenager picking up a phone, and a checklist that cannot be finished by
the person looking at it reads as failure rather than progress. It is
returned separately as a `milestone`: a suggested next thing, surfaced only
once onboarding is complete, and never able to hold onboarding open.

ADDING A STEP
-------------
Append one `OnboardingStep` to `STEPS`. Nothing else in this file, and
nothing outside it, needs to change - the route maps over the registry and
the frontend renders whatever it is handed. If a new step needs a new fact,
add a field to `OnboardingFacts` and one query to `gather_facts`; the cost
of a step stays one query, not one query per coach per step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.extensions import db
from app.models import (
    AccessCode,
    AttemptStatus,
    Group,
    GroupPlayer,
    Player,
    PlayerAttempt,
    Question,
)
from app.models.access_code import access_code_groups
from app.services.quiz_scope import owned_quiz_ids

# Step scopes. Strings rather than an enum: they are part of the JSON
# contract, and a native Postgres enum here would buy nothing since this
# is never stored (see the module docstring).
COACH = "coach"
ORGANIZATION = "organization"


@dataclass(frozen=True)
class OnboardingFacts:
    """Everything the step predicates are allowed to look at.

    Gathered ONCE per request and handed to every predicate. The alternative -
    each step running its own query - turns a nine-step checklist into nine
    round trips and makes the cost of adding a step invisible until it is
    already shipped.
    """

    quiz_ids: tuple[int, ...]
    group_ids: tuple[int, ...]
    question_count: int
    player_count: int
    grouped_player_count: int
    access_code_count: int
    group_assigned_code_count: int

    @property
    def latest_quiz_id(self) -> int | None:
        """The coach's most recently created quiz, or None.

        `max(id)` is the newest row because quiz ids come from a Postgres
        sequence. Used to deep-link the action buttons: "add your first
        question" should open the quiz they just made, not the quiz list.
        """
        return max(self.quiz_ids) if self.quiz_ids else None

    @property
    def latest_group_id(self) -> int | None:
        """The organization's most recently created group, by the same rule.

        Deep-links "add players to a group" at the group itself, which is
        where members are actually managed - the groups list has no way to
        add anybody.
        """
        return max(self.group_ids) if self.group_ids else None


@dataclass(frozen=True)
class OnboardingStep:
    """One row of the checklist.

    `route` is a function of the facts, not a constant, because the useful
    destination often depends on what the coach already has - there is no
    fixed URL for "the quiz you just created".
    """

    id: str
    title: str
    description: str
    scope: str
    action_label: str
    is_complete: Callable[[OnboardingFacts], bool]
    route: Callable[[OnboardingFacts], str]
    # A second, equally valid way to finish the step. Only "build your roster"
    # has one today (type them in, or upload a file) - a coach with a
    # spreadsheet and a coach with three names should each see their own path
    # rather than one of them being told to go and find it.
    #
    # One optional field rather than a list of actions: a step with two front
    # doors is the exception, and modelling every step as a collection to
    # serve one of them costs every reader of this file.
    secondary_action: Callable[[OnboardingFacts], dict] | None = None


def _quiz_tab(tab: str) -> Callable[[OnboardingFacts], str]:
    """Deep-link into a tab of the coach's newest quiz.

    Falls back to the dashboard when they have no quiz yet, which can happen
    for a later step whose earlier ones are undone (delete the quiz, keep the
    roster). A button that 404s is worse than one that lands a click early.

    NOTE: these are FRONTEND paths, which is the one place this backend knows
    any. `tests/test_onboarding.py` pins every route string so renaming a
    React Router path fails a test here rather than silently shipping a dead
    button.
    """

    def route(facts: OnboardingFacts) -> str:
        if facts.latest_quiz_id is None:
            return "/dashboard"
        return f"/quizzes/{facts.latest_quiz_id}?tab={tab}"

    return route


# The checklist, in the order a coach actually works through it. Order here
# is the order rendered; `next_step_id` is the first incomplete one.
STEPS: tuple[OnboardingStep, ...] = (
    OnboardingStep(
        id="create_quiz",
        title="Create your first quiz",
        description="A quiz is a set of questions you assign to your players.",
        scope=COACH,
        action_label="Create a quiz",
        is_complete=lambda f: bool(f.quiz_ids),
        route=lambda f: "/dashboard",
    ),
    OnboardingStep(
        id="add_question",
        title="Add your first question",
        description="Ask about a formation, a call, or anything from your install.",
        scope=COACH,
        action_label="Add a question",
        is_complete=lambda f: f.question_count > 0,
        route=_quiz_tab("questions"),
    ),
    OnboardingStep(
        id="build_roster",
        title="Build your roster",
        description="Add your players by hand, or upload the whole team at once.",
        scope=ORGANIZATION,
        action_label="Add players",
        is_complete=lambda f: f.player_count > 0,
        route=lambda f: "/roster",
        # `?import=1` opens the roster page with its import panel already
        # expanded - see MasterRosterPage. Without it "Upload a roster" lands
        # on the same page as "Add players" and the coach has to find the
        # button that makes the two options different.
        secondary_action=lambda f: {"label": "Upload a roster", "route": "/roster?import=1"},
    ),
    OnboardingStep(
        id="create_group",
        title="Create your first group",
        description="Groups let you assign a quiz to a position or unit.",
        scope=ORGANIZATION,
        action_label="Create a group",
        is_complete=lambda f: bool(f.group_ids),
        route=lambda f: "/groups",
    ),
    OnboardingStep(
        id="add_players_to_group",
        title="Add players to a group",
        description="Put players from your roster into that group.",
        scope=ORGANIZATION,
        action_label="Add players to the group",
        is_complete=lambda f: f.grouped_player_count > 0,
        # Straight to the group itself: members are managed on the group page,
        # and the groups list has no way to add anybody.
        route=lambda f: f"/groups/{f.latest_group_id}" if f.latest_group_id else "/groups",
    ),
    OnboardingStep(
        id="activate_quiz",
        title="Activate your quiz",
        description="Activating creates the code your players use to join.",
        scope=COACH,
        action_label="Activate",
        is_complete=lambda f: f.access_code_count > 0,
        route=_quiz_tab("activate"),
    ),
    OnboardingStep(
        id="assign_to_group",
        title="Assign your quiz to a group",
        description="Restrict the quiz to a group so only those players can take it.",
        scope=COACH,
        action_label="Assign to a group",
        is_complete=lambda f: f.group_assigned_code_count > 0,
        route=_quiz_tab("activate"),
    ),
)


def gather_facts(coach) -> OnboardingFacts:
    """One pass over the data behind every step.

    Counts rather than EXISTS: the tables are small, the numbers are useful
    to any future step that wants a threshold instead of a presence check,
    and "does the org have players" is not a hot path.
    """
    org_id = coach.organization_id
    quiz_ids = tuple(owned_quiz_ids(coach))

    # Guarded because `IN ()` on an empty list is a needless round trip for
    # the single most common case this endpoint sees - a brand-new coach.
    question_count = 0
    access_code_count = 0
    group_assigned_code_count = 0
    if quiz_ids:
        question_count = Question.query.filter(Question.quiz_id.in_(quiz_ids)).count()
        access_code_count = AccessCode.query.filter(AccessCode.quiz_id.in_(quiz_ids)).count()
        group_assigned_code_count = (
            db.session.query(db.func.count(db.distinct(AccessCode.id)))
            .select_from(AccessCode)
            .join(access_code_groups, access_code_groups.c.access_code_id == AccessCode.id)
            .filter(AccessCode.quiz_id.in_(quiz_ids))
            .scalar()
        ) or 0

    # Active players only. A roster emptied down to archived players has not
    # been "built" in any sense a coach would recognise.
    player_count = Player.query.filter_by(organization_id=org_id, is_active=True).count()
    group_ids = tuple(
        row[0]
        for row in Group.query.with_entities(Group.id)
        .filter(Group.organization_id == org_id)
        .all()
    )
    grouped_player_count = (
        db.session.query(db.func.count())
        .select_from(GroupPlayer)
        .join(Group, Group.id == GroupPlayer.group_id)
        .filter(Group.organization_id == org_id)
        .scalar()
    ) or 0

    return OnboardingFacts(
        quiz_ids=quiz_ids,
        group_ids=group_ids,
        question_count=question_count,
        player_count=player_count,
        grouped_player_count=grouped_player_count,
        access_code_count=access_code_count,
        group_assigned_code_count=group_assigned_code_count,
    )


def _first_completion_milestone(facts: OnboardingFacts) -> dict:
    """"Have your first player complete a quiz."

    Deliberately NOT a step - see the module docstring. Shaped like one so
    the frontend can render it with the same component, but carried in its
    own field so it can never contribute to `complete`.
    """
    submitted = 0
    if facts.quiz_ids:
        submitted = (
            db.session.query(db.func.count())
            .select_from(PlayerAttempt)
            .join(AccessCode, AccessCode.id == PlayerAttempt.access_code_id)
            .filter(
                AccessCode.quiz_id.in_(facts.quiz_ids),
                PlayerAttempt.status == AttemptStatus.SUBMITTED,
                # THE ONE INTENTIONAL OMISSION of attempt_scope.official_only.
                # This milestone asks "has a player actually used this?", not
                # "how did they score", so a practice completion counts. See
                # the note in app/services/attempt_scope.py.
            )
            .scalar()
        ) or 0

    return {
        "id": "first_player_completion",
        "title": "Have your first player complete a quiz",
        "description": "Share the access code with your team, then check the results.",
        "action_label": "View the code",
        "route": _quiz_tab("activate")(facts),
        "complete": submitted > 0,
    }


def build_progress(coach) -> dict:
    """The whole `GET /api/onboarding` payload.

    The route is a thin wrapper around this so the rules stay testable
    without HTTP, and so nothing else in the app is ever tempted to
    re-derive "is this coach set up" a second way.
    """
    facts = gather_facts(coach)

    steps = []
    for step in STEPS:
        steps.append(
            {
                "id": step.id,
                "title": step.title,
                "description": step.description,
                "scope": step.scope,
                "action_label": step.action_label,
                "route": step.route(facts),
                "secondary_action": (
                    step.secondary_action(facts) if step.secondary_action else None
                ),
                "complete": step.is_complete(facts),
            }
        )

    completed_count = sum(1 for step in steps if step["complete"])
    complete = completed_count == len(steps)
    next_step = next((step["id"] for step in steps if not step["complete"]), None)

    return {
        "steps": steps,
        "completed_count": completed_count,
        "total_count": len(steps),
        "complete": complete,
        "next_step_id": next_step,
        "dismissed": coach.onboarding_dismissed_at is not None,
        "dismissed_at": (
            coach.onboarding_dismissed_at.isoformat()
            if coach.onboarding_dismissed_at
            else None
        ),
        # Null until onboarding is finished: suggesting what to do next while
        # the setup is half-built is noise, and computing it costs a join we
        # can skip entirely in the common early case.
        "milestone": _first_completion_milestone(facts) if complete else None,
    }
