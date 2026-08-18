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

---

## Competition history needs immutable question snapshots (revisit in M3)

`competition_answers.question_id` has `ON DELETE CASCADE`. So if a coach deletes
a quiz question after a competition has played it:

- the participant's **points remain correct** - they are already accumulated on
  `competition_participants.total_points`, and deliberately not recomputed,
  because a coach tidying their quiz afterwards must never restate a result
  the room already watched happen;
- but the **answer rows for that question disappear**, so the audit trail
  explaining *how* those points were earned is gone.

The score survives; the explanation does not. Today that is the right trade -
M2 has no history UI, so nothing reads the audit trail, and the alternative
(blocking question deletion, or recomputing standings) is worse.

**Revisit when Competition History is built in M3.** A history screen that
cannot explain a score is barely a history screen. The likely answer is that a
competition should snapshot what it played - question text, options, and which
was correct - at the moment the order is frozen, so a finished competition
stays fully explainable no matter what happens to the quiz afterwards. That is
a schema change and a data-migration decision, which is exactly why it is not
being made mid-feature.

Related: `question_order` already snapshots WHICH questions were played, so
the ordering half of the problem is solved. What is missing is the CONTENT.

---

## Competition lobby — visual polish pass

Observed by the owner watching Competition Mode on a real production
projector, 13 August 2026, immediately after the M2.6 deploy. **Recorded, not
approved.** None of it was implemented at the time: the session it came from
was a functional production smoke test, and the only thing changed then was
the join-code overflow defect, which was a genuine bug rather than a taste
question.

Do these together as one deliberate pass, not piecemeal. They are all the
same judgement — *the lobby should feel like a room about to start* — and
solving them one at a time is how a coherent stage turns into a pile of
tweaks.

**1. The roster carries too much visual weight.** The wall of names competes
with the information that actually matters in a live room.

**2. "NOT HERE YET" is probably the wrong label.** It asserts those players
were expected, which is not true — the eligibility list is everyone who
*could* play, not everyone who was invited. Something closer to ROSTER or
AVAILABLE PLAYERS is more accurate. Wording deliberately NOT changed yet.

**3. IN THE ROOM should grow in importance as people arrive.** The lobby
currently gives equal billing to the people participating and the people who
are not. It should emphasise the former, increasingly so as the room fills.

**4. Arrivals should feel noticeable.** This is the pregame beat. Someone
entering the room deserves presence and energy — without becoming a
distraction on a projector that a coach is talking over.

**5. The lobby needs more of the Competition identity.** On-stage, bright
lights, anticipation, intensity, an event beginning; emotionally distinct
from ordinary Peira. **Not a Kahoot clone** — the existing constraint stands:
premium and athletic, not childish.

**6. The join code stays a visual hero.** Non-negotiable, and specifically
*not* to be solved by shrinking it. Note that M2.6 already made the code size
itself from its card rather than the viewport, so the hero can be made larger
purely by widening the left column — `.code` follows automatically and cannot
overflow. See the comment block on `.code` in `Competition.module.css` for the
measured glyph budget, and `Competition.layout.test.ts` for the guard.

**7. Removing ordinary Peira navigation from the Competition host experience
was correct.** Keep that architecture. Recorded so a future polish pass does
not "restore consistency" by putting the nav back.

---

### Found while running Competition in production, 13 August 2026

Three more, from the verification walkthrough itself rather than from looking
at the screen. Same polish pass, but these are **usability faults with
evidence**, not taste.

**8. Destructive and terminal controls have the wrong visual weight.** On the
reveal screen the buttons are `Show standings` (quiet), `Finish competition`
(quiet), `Next question` (ORANGE, primary) and `End competition` (red). So the
visually dominant action continues the quiz, while the irreversible ending is
one of the quiet ones.

*This is not hypothetical.* It cost two production verification runs. Both
times the intended `Finish competition` click landed on `Next question`
instead, and the run then had to be ended with `End competition` — the
ABANDONED path — because `Finish` is not offered during an open question.
A coach in front of a real room will do the same thing, and will lose a
competition's podium doing it.

Worth considering together: whether `Finish competition` should be reachable
during `QUESTION_OPEN` at all (arguably not — finishing with a question open
and unscored is incoherent), and if not, whether the UI should say so rather
than leaving the coach hunting for a button that only exists after the reveal.
A confirm was added to `Finish` in `4be2069`; that guards the misclick but does
not fix the hierarchy.

**9. "Start Competition" means two different things on consecutive screens.**
On the setup screen it CREATES the lobby; on the lobby screen a button with the
identical label OPENS THE FIRST QUESTION. One click apart, same words. This
also caught us during verification. A coach who has gathered a room and is
looking for the button that begins play has no way to tell from the label which
one they are about to press.

**10. The solo-room podium blames a tie that did not happen.** With one
participant the ranks are just `[1]`, so second and third are genuinely empty —
correct, and correctly announced rather than promoted into. But the copy reads
*"A tie at the top means second place was never awarded"* / *"A tie above means
this place was never awarded"*, and in a one-player room there was no tie;
there was simply nobody else. `PodiumStages.tsx` chooses that wording purely
from the place number, without consulting the shape of the standings. Cosmetic,
and only at an edge case, but it states something untrue on a projector.


---

## Competition session cleanup / deletion / retention

**Not a blocker for M2, and deliberately not implemented.** Raised by the
owner on 13 August 2026 during the M2.6 production verification, once it
became clear what the smoke-test sessions would leave behind.

**The situation today.** A Competition session persists permanently once it
reaches COMPLETE or ABANDONED, along with its `competition_participants` and
`competition_answers` rows. There is no coach-side way to remove one. The only
DELETE route on the Competition surface is
`/sessions/<id>/participants/<id>`, and `remove_participant()` refuses unless
the session is still in LOBBY. Nothing else deletes anything — `end_session()`
only sets a status. So every competition a coach ever runs accumulates
forever, and the coach has no view of them and no control over them.

**Why it has not bitten yet.** `GET /competition/active` is deliberately
live-sessions-only, so finished sessions are invisible rather than cluttering
anything, and Competition rows touch no ordinary Peira surface (see the
analytics isolation section of COMPETITION-API.md). The cost today is storage
and an absence of control, not a wrong number anywhere — which is exactly why
this is a retention decision rather than a bug.

**The decision to make later**, as one deliberate design pass rather than
piecemeal. Some combination of:

- coach-side deletion of completed/abandoned sessions;
- an archive / history view (note this overlaps with the Competition History
  work already parked for M3, and with the question-content snapshot problem
  recorded above — a history screen and a retention policy want deciding
  together, because a policy that deletes what history wants to show is a
  policy nobody can use);
- automatic retention or scheduled cleanup.

**Careful with the third one.** `expire_stale_sessions()` already exists,
is dead code, and is deliberately unwired: it filters on *status not terminal*
rather than *status is LOBBY*, so calling it today would mark a LIVE
mid-round competition ABANDONED. Any retention work must fix that predicate
before wiring anything to a schedule. See COMPETITION-API.md §13.

Also note organizations do not cascade — the production cleanup audit
(CLAUDE.md) had to delete across 22 tables in order. Any deletion tool here
must handle `competition_answers` before `competition_participants` before
`competition_sessions`.

---

## Competition: confirm identity before claiming the seat

**Requested 13 August 2026. Higher priority than podium photos. NOT approved
for implementation.**

**The problem.** Tapping a name on the roster picker claims that seat
immediately - `CompetitionJoinPage` line 198's `onClick` runs `choose(...)`,
which calls `joinCompetition` at line 81. One mistaken tap creates the
participant, issues the reconnect token, and marks that identity taken. The
real player then gets `409 identity_taken` and the coach has to remove the
wrong participant to free the name. In a room of thirty that is a genuine
disruption, not a cosmetic annoyance.

**Wanted flow:** scan/code -> roster picker -> tap a name -> **IS THIS YOU?**
(photo + name) -> explicit *Yes, that's me* claims the seat; *Go back* returns
to the roster having claimed nothing.

**The good news, from tracing it: this is almost certainly frontend-only.**
Selection is already just a click handler; nothing is sent until
`joinCompetition` runs. Deferring that call behind a confirmation button
changes no route, no schema and no contract. `POST /<code>/join` stays the one
irreversible step.

**Do NOT add reservations or seat locks.** The server is already authoritative
and correct for the race: if two devices sit on the confirmation screen for the
same player, the first to confirm wins and the second gets `409
identity_taken`, which the picker already knows how to explain (see the
`keepError` handling that exists precisely because a roster refresh used to
wipe that message). The losing player just picks again. A reservation would
introduce expiry, cleanup and a whole new class of stuck seat, to solve a race
the database's unique constraint already handles.

**Because nothing is claimed until confirm, the confirmation state is
disposable** - refresh, Back, or closing the tab need no cleanup at all. That
is the main argument for this shape over any server-side alternative.

Worth deciding: what the confirmation screen does if the room leaves LOBBY
while it is open (the 1 Hz poll already knows), and whether *Go back* should
re-fetch the roster so a name taken in the meantime shows as unavailable.

---

## Competition: player photos on the podium

**Requested 13 August 2026. NOT approved for implementation.** Wanted for the
payoff moment - 3rd/2nd/1st with the player's face, so the podium reads like a
team event rather than a list.

**Peira already has player photos. Reuse them; do not build anything new.**
`Player.photo_url` (`models/player.py:29`), uploaded via
`POST /api/players/<id>/photo`, stored through the same `FileStorage`
abstraction as question images, and already exposed by `Player.to_dict()`.
There is no case for a Competition-specific photo column, upload path or
storage lifecycle.

**What would actually need to change.** `eligible_players()` in
`services/competition.py` returns exactly `{player_id, display_name}` - the
photo is not in any Competition payload today. The podium builds from
`competition_participants`, which snapshots `display_name` at join and holds
`player_id`, so the join back to `Player.photo_url` exists. Adding it is a
payload change plus rendering; no schema change.

**One safe display representation should serve both features.** The
confirmation screen and the podium want the same thing - display name plus a
safe photo - so define it once rather than fetching photos two ways. That is
the main reason to design these two together even though they ship separately.

**Ties are the design constraint, not an edge case.** Competition allows
genuine large ties, and a place belongs to whoever holds rank N with nobody
promoted into an unearned place. A six-way tie for first is not hypothetical -
it happened during M2.6 verification. So the component cannot assume one place
means one face: it needs a deliberate answer for 2, 3, and many, and "shrink
until it fits" is not one. If very large ties need a different presentation
(names only above a threshold, say), that is a decision to take rather than
guess. Adding photos must change no ranking, scoring or tie semantics.

**No-photo fallback is required, not optional** - many players will have none,
and the projector must still look intentional. Use whatever the roster already
does for a photo-less player rather than inventing a second treatment. No
broken-image icons, no empty frames.

**Privacy.** Photos are additional roster information, so this needs checking
rather than assuming: `photo_url` is a public storage URL carrying no token,
which is consistent with how question images already reach unauthenticated
players. The projector is meant to be seen by the room. What must NOT happen is
a player's own phone receiving other players' photos beyond what the podium
legitimately shows - the player-private standing rule stays as it is.

---

## `docs/API.md` does not document `selected_option_ids`

Recorded 18 Aug 2026, when Multi-Select v1 closed. **Not a blocker for
Multi-Select v1** - the API accepts and returns the field correctly and it is
covered by tests; only the written contract lags.

`/api/play/submit` and `/api/play/answers` both accept `selected_option_ids`
(the complete set for a "Select all that apply" question), and the attempt
state returned by `/api/play/start` reports it back for every answer so a
resumed attempt restores every ticked box. API.md's request example still
shows only `selected_option_id`.

Two other M4 additions are equally undocumented there: `Answer.selected_option_ids`
on the coach-facing response payload, and `allows_multiple_answers` on the
delivered-question objects. Both are additive.

**Why it was left.** The gap predates M4 - it arrived with M3, which built the
write path - and closing it is a documentation pass rather than a code change,
so folding it into the deployment of a working feature would have mixed two
unrelated risks. Worth doing next time API.md is touched for any reason.

