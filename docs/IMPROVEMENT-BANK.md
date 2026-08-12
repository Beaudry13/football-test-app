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

## Quiz Editor

### Mirror every activation guard in the frontend

The server refuses to activate a quiz in three cases. The Activate button
currently mirrors only the first:

1. **No questions** — mirrored. `question_count` is on the payload the tab
   already has, so the button is disabled with a reason.
2. **A Draw Response question with no image** — *not* mirrored. That lives on
   the questions, which the access-codes tab does not load.
3. **No roster and no group selected** — *not* mirrored. It depends on the
   quiz's own roster, and `roster_size` is omitted from the single-quiz
   response (it is computed only for the quiz *list*).

*Do not hack around this.* Fetching the questions or the roster from that tab
just to grey out a button would add requests and put a second copy of the
server's rules in the client, which is how the two start disagreeing.

The clean fix is to expose activation readiness in the single-quiz payload —
a small object the server derives from the rules it already enforces, e.g.
`{ can_activate: bool, blockers: [...] }`. The frontend then mirrors the
server's own truth with no extra request and no duplicated rule. Until then
the note under the button states both remaining requirements, and the server
is still the enforcement point.

### Response rate with an empty roster

Results shows **0%** response rate when roster size is zero. Nobody was
eligible to respond, so 0% implies a failure that did not happen — "—" would
be truthful, matching the rule that a score is never fabricated when there is
nothing to score (see `_score_percent` in `services/export.py`).

Cosmetic, and a copy decision rather than a correctness one, which is why it
was left alone during the reliability audit.

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

---

## Frontend jsdom unhandled errors (deferred until Competition Mode ships)

`npx vitest run` exits non-zero on a fully passing suite, from ~8 unhandled
errors raised by jsdom rather than by any test. Two sources:

- `Image given has not completed loading` — Fabric calling canvas `drawImage`
  in `AnnotationCanvas.test.tsx`.
- `scrollIntoView is not a function` — jsdom implements no layout, so
  `QuizStep.tsx` and `QuestionEditor.tsx` hit it during real submit paths.

**Why this matters more than ordinary noise.** A permanently red exit code is
an unreadable one. A full run silently executed 75 of 76 files - dropping
`QuestionEditor.test.tsx` and its 39 tests - and nothing surfaced it, because
the only channel that could have was already failing for an unrelated reason.
That is now caught by `npm run test:ci`
(`frontend/scripts/verify-test-collection.mjs`), which asserts from the run's
own JSON report that every test file on disk actually ran and nothing failed.

**The guard makes the gate trustworthy; it does not remove the debt.** While
these errors exist, vitest's own exit code still cannot be used for anything.

### Known specific issue to fix as part of this

`QuestionEditor.test.tsx` assigns `window.HTMLElement.prototype.scrollIntoView`
in five places and never restores it - the only global prototype mutation in
the whole suite. It leaks into every file that runs after it, which is why the
unhandled-error count varies with test ordering (`QuizStep`'s rejection appears
only in orderings where `QuestionEditor` has not run yet). Restore it in an
`afterEach`, or stub it once in `src/test/setup.ts` where every file gets the
same environment.

### Also worth investigating at the same time

Both observed file-drops happened while a full backend `pytest` was saturating
the machine; three controlled runs on an idle machine were clean. Worker
starvation under host load is strongly indicated but was never reproduced on
demand. If it recurs, capture the run with `--pool=forks --poolOptions...`
diagnostics rather than re-running until it passes.

**Deferred deliberately: not blocking, and not to be picked up mid-Competition.**
