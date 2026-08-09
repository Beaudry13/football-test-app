# Improvement Bank

Ideas parked deliberately, not forgotten and not in progress.

Nothing in this file is approved work. An entry here means "we thought of it,
decided it was not V1, and wrote down enough that the next person does not
have to rediscover the reasoning." Moving something out of this file is a
separate decision.

Each entry records what it is, why it was deferred, and anything already
known that would shape the implementation.

---

## Cumulative Performance Report

Shipped V1: `GET /api/players/report.pdf?ids=…`, built by
`build_cumulative_performance_pdf` in `backend/app/services/export.py`, driven
from the roster page's selection bar.

**V1 is considered complete. Do not change the report without a specific
request.**

### Optional sorting before generating

Let a coach choose the order players appear in, rather than always
last-name-then-first:

- Jersey Number
- Alphabetical
- Highest Overall %
- Lowest Overall %
- Most Quizzes Completed

*Notes for whoever picks this up.* The ordering currently lives in one place —
`cumulative_performance_report` in `backend/app/routes/players.py` sorts the
players before building histories. Sorting by percentage or by quizzes
completed is different in kind from the other two: those figures only exist
*after* `build_player_history` has run for each player, so that sort has to
happen on the built histories rather than on the `Player` rows. Jersey number
is stored as a string and is not always numeric — `_player_sort_key` in
`export.py` already solves exactly this for the detailed results PDF, and
should be reused rather than re-derived.

A player with nothing graded has `average_score_percent = None`. Any
percentage sort needs to decide where those land; putting them at the end
regardless of direction is probably right, since they are "no data" rather
than "zero".

### Optional one-page summary at the front

An at-a-glance table before the per-player sections:

| Player | Overall | Quizzes Completed | Correct | Incorrect | Awaiting Grading |

*Notes for whoever picks this up.* Every column is already computed and
returned by `build_player_history` (`average_score_percent`,
`completed_count`, `total_correct_count`, `total_incorrect_count`,
`total_pending_grading_count`) — this is a rendering job with no new
analytics, and it must stay that way. `_dense_quiz_table` is close to the
right styling already.

It should be optional, and it interacts with the layout work done in V1: the
report deliberately has no forced page breaks, so a summary that runs onto a
second page must not push the first player onto a third. Worth deciding
whether "one page" is a promise (truncate past N players) or a description of
the common case.

---

## Onboarding / Help

### What's New

Listed in the Help menu as "Coming soon" (`kind: 'pending'` in
`frontend/src/help/registry.tsx`). Needs a versioned release-notes list plus
per-coach unread state.

*Decision already taken:* the unread state is stored **per coach**, not in
localStorage, so a coach reading the notes on one machine does not see them
unread on another. That means one nullable column on `coaches`. The shape —
version string versus timestamp — is deliberately undecided, because it
depends on how releases get authored.

Note this is *help* state, not onboarding state:
`coaches.onboarding_dismissed_at` remains the only thing onboarding persists,
and every checklist step stays derived (see
`backend/app/services/onboarding.py`).

### Auto-launching the Dashboard Tour for brand-new coaches

Raised and deliberately not built. The First Success checklist owns a new
coach's first screen; a dimmed overlay on top of it would recreate the exact
"the useful thing arrived behind a dialog" problem that retiring the
auto-opening "What is Peira?" modal removed.

The alternative already built instead: an opt-in link inside the checklist
("New here? Take the dashboard tour").
