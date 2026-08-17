# Manual testing checklist

Things that have shipped to production but have **not** been exercised by a
human on the real site.

## Why this file exists

Development used to stop after every phase for a hands-on production
walkthrough. That is now deliberately deferred: automated tests, gates,
browser automation and deployment probes carry the routine verification, and
this file records what genuinely still wants a person.

**The rule that makes this safe:** nothing here may be described as
"production verified". Accurate labels are:

| Label | Means |
|---|---|
| automated verified | covered by the test suites |
| dev/browser verified | driven in a browser against a dev server |
| deployed and health verified | deploy succeeded, health/bundle probed live |
| manual production verification deferred | **listed here, awaiting a person** |

Work through this in a batched hands-on session rather than item by item.
Tick items off by deleting them and noting the date in the git commit.

---

## PHASE 4A / ATTEMPT VERSION INVARIANT

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `94b63c2` (16 Aug 2026). Deployed and health verified.

The invariant: *once an attempt starts, it stays on the version it was
delivered.* Corrections reach a player only on a NEW attempt.

Use an existing safe test/dev quiz. **Text edits only** - do not change the
correct answer, question type, region geometry, scoring or exclusions, as
those are all still blocked after delivery by design.

- [ ] Start an attempt on version A; confirm it opens normally
- [ ] Answer at least two questions (needed for the saved-answer check below)
- [ ] Note Q1's exact wording and the question numbering
- [ ] While that attempt is still open, correct one question's TEXT to version B
- [ ] Refresh / rejoin the EXISTING attempt
- [ ] Confirm it still shows **version A** text
- [ ] Confirm the saved answers survived
- [ ] Confirm question order and Q# are unchanged
- [ ] Start a NEW attempt (different roster player)
- [ ] Confirm the new attempt shows **version B** text
- [ ] Confirm the old attempt can still be submitted

**Decisive result:** OLD ATTEMPT → OLD VERSION, NEW ATTEMPT → NEW VERSION.

**Failure signals - stop and report rather than patching:** the existing
attempt shows the new text; the new attempt shows the old text; resume
breaks; the player cannot submit; `/play/start` 500s.

### Already covered automatically - do NOT re-test by hand

- Both directions of the invariant (text, options, image) - `test_attempt_version_invariant.py`
- `/play/start` exposes no `is_correct_answer` / `expected_answers` - raw response body is grepped in the same file
- Saved answers survive resume and resolve to their delivered option
- `require_all_answers` validates the delivered set
- Legacy attempts (no snapshot) still play
- Historical Results / CSV / PDF read delivered content
- Query counts stay flat as quiz length grows

---

## PHASE 4B STEP 1 / DELIVERED ORDER

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `8063e31` (16 Aug 2026). Deployed and health verified.

An attempt's question ORDER now comes from its delivered snapshot rather than
from the live quiz. Backend only - no frontend change, no schema change.

**The one deliberate behaviour change a coach can notice:** a question added
to a quiz while an attempt is in progress no longer appears in that attempt.
It previously appeared at the end. New attempts receive it as before.

Best folded into the Phase 4A walkthrough above - same attempt, a few extra
steps:

- [ ] With an attempt in progress, reorder the live quiz; confirm the open
      attempt keeps its original order and Q# on refresh
- [ ] Confirm a NEW attempt shows the new order
- [ ] With an attempt in progress, add a question; confirm the open attempt
      does NOT gain it and can still be submitted
- [ ] Confirm a NEW attempt does receive it
- [ ] Randomized practice: confirm a resumed attempt keeps its shuffle

### Already covered automatically - do NOT re-test by hand

`test_delivered_order.py` (17 tests) covers every case above, including the
graded `question_order = NULL` path that made this necessary, snapshot
immutability, and the legacy fallback. Three of those tests were confirmed to
FAIL against the previous behaviour, so they are load-bearing rather than
decorative.

---

## PHASE 4B STEP 2 / STOP SENDING THIS QUESTION

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `0bef0e1` (16 Aug 2026). Deployed and health verified.

Carries migration `eda136c89785` — additive nullable columns plus a partial
index. Render's pre-deploy `flask db upgrade` succeeded, so the migration
applied; the Alembic head is **inferred from that**, not read directly (no
shell access from here).

A coach can stop a question from going out in new Peiras without deleting it
or touching anything a player has already done.

- [ ] Stop a question; confirm it disappears from a NEW Peira
- [ ] Confirm an attempt already in progress still shows it and can be submitted
- [ ] Confirm the coach editor still SHOWS it, marked "Not sent to new Peiras"
- [ ] Confirm "Start sending it again" restores it to new Peiras
- [ ] Confirm existing results, scores and Q# are completely unchanged
- [ ] Confirm it is still listed on Results with the players' answers intact
- [ ] Duplicate the quiz; confirm the copy keeps the stopped state and can be
      restored independently of the original
- [ ] Stop EVERY question, then try to activate — expect a clean refusal that
      does not claim the quiz is empty
- [ ] With a code already active, stop every question, then try to join as a
      player — expect a clean refusal and NO attempt created

**THE ONE ITEM THAT GENUINELY NEEDS A HUMAN.** Verify that:

- **"Stop sending it"** (this feature — future delivery), and
- **"Don't count this question"** (Phase 3 — scoring for players who already
  answered)

feel clearly different in the real coach UI. They live on different screens
and use different words, but whether a coach actually reads them as two
distinct decisions is a product wording judgement, not an automated gate. No
test can make it, and getting it wrong means someone changes a score when they
meant to change a syllabus.

**Failure signals — stop and report:** a stopped question vanishes from an
attempt already underway; a past result loses a question; a score moves when
a question is stopped; a player gets a zero-question Peira.

### Already covered automatically - do NOT re-test by hand

`test_question_retirement.py` (40 tests) covers all of the above including the
legacy-attempt fallback, the zero-question refusal, activation renumbering,
practice Try Again, cross-org authorization, and that stopping a question
changes no existing grade. `QuestionsTabRetirement.test.tsx` (13 tests) covers
the coach UI, including that a stopped question stays visible and that the
editor never offers the Phase 3 exclusion action.

Migration rehearsed upgrade → downgrade → upgrade against a real Postgres.

---

## PHASE 4C / SAFE CORRECTIONS

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `6e38805` (16 Aug 2026). Deployed and health verified.
No migration - none was needed.

A coach can now reword an option, add an option, replace or delete the image
and redraw annotations on a question players have already received.

**API-level dev verification was performed** against a running local backend:
reword 200, add option 200, move-the-correct-answer 422, remove-option 422,
and the resumed attempt still served its delivered options. What was NOT done
is a visual browser pass - see below.

- [ ] Reword an option on a delivered question; confirm the notice appears
- [ ] Confirm the notice reads as an explanation, not a warning - it should
      not make a coach hesitate to fix a genuine mistake
- [ ] Confirm a brand-new question shows NO notice
- [ ] Confirm an in-progress attempt still shows the old wording on refresh
- [ ] Confirm a new attempt shows the corrected wording
- [ ] Add an option; confirm an in-progress attempt does not gain it
- [ ] Replace an image; confirm past results still show the old picture
- [ ] Confirm the refusal messages for correct-answer and option-removal read
      clearly and point at the right alternative

**THE VISUAL CHECK IS THE GAP.** The notice's wording is asserted by tests;
its *tone* is not, and cannot be. Whether it reassures or alarms is the thing
worth your eyes. I did not drive the coach UI in a browser because doing so
needs a login, and entering credentials is outside what I do.

### Already covered automatically - do NOT re-test by hand

`test_safe_corrections.py` (32 tests) covers every unlock and every remaining
block, including that the option ROW survives a reword so no answer is
detached, that a refused edit changes nothing at all, that snapshots are never
mutated, and that no answer row is touched by any correction.
`QuestionEditorDelivered.test.tsx` (7 tests) covers the notice, including that
it carries no alert role and none of the vocabulary of a hazard.

---

## DRAW RESPONSE PHASE A / HISTORICAL IMAGE BINDING

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `f588b7a` (16 Aug 2026). Deployed and health verified. No migration.

A drawing is now permanently bound to the image it was drawn on. The server
refuses a drawing bound to any other image.

- [ ] Draw on a question, submit, then replace that question's image as coach
- [ ] Confirm the coach's view still shows the OLD picture with the drawing
      correctly positioned on it - not the new picture

---

## DRAW RESPONSE PHASE B / SERVER-BACKED RESUME

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `d51736e` (16 Aug 2026). Deployed and health verified. No migration.

A drawing now comes back from the server, not just from the browser.

- [ ] Draw, wait for "Saved", clear site data, rejoin - drawing returns
- [ ] Draw on a phone, then resume the same attempt on a laptop - drawing follows
- [ ] Draw more strokes, refresh BEFORE the save lands - unsaved strokes survive
- [ ] Two devices: save on A, then resume on B which has older local work -
      B shows A's version and says so

**THE WORDING WORTH A HUMAN LOOK.** Two multi-device notices exist and must
read as one voice while telling the truth about different outcomes:

| When | Says |
|---|---|
| Resuming onto a newer server drawing | "...The latest saved version has been restored." |
| Conflict WHILE drawing | "...Your current changes are still here and will be saved when you submit." |

Both open "Your drawing was updated on another device." Whether that reads as
reassuring rather than alarming is a judgement no test can make.

### Already covered automatically - do NOT re-test by hand

`test_drawing_resume.py` (14), `test_drawing_image_binding.py` (18),
`resumeDrawing.test.ts` (14) and `QuizStepDrawingRestore.test.tsx` (18) cover
cross-device resume, cleared storage, all six precedence gates, recovered work
being re-saved, no redundant save, isolation between players and attempts, and
answer-key leakage.

**Backend note:** the `/play/start` drawing contract could not be probed
unauthenticated from here - the Render deploy succeeding and `/api/health`
returning 200 is the deployment evidence, not a contract probe.

---

## DRAW RESPONSE PHASE C / PLAYER DRAWING RESULTS

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `c1d3b6d` (17 Aug 2026). Deployed and health verified. No migration.

A player's results page now shows the drawing they made, over the image they
were given, instead of the words "Drawing submitted".

- [ ] Submit a Draw Response, then open the player results page - the drawing
      renders over the right picture, at the right scale
- [ ] Compare it side by side with the coach's expanded view of the same
      answer - the two must look identical
- [ ] Replace the question's image as coach, reload the player results - the
      player still sees the ORIGINAL picture with their strokes on it
- [ ] Exclude that question from scoring - the drawing stays visible, with the
      neutral "Excluded from scoring" badge
- [ ] A Draw Response the player skipped reads "No answer" with no broken
      viewer

**Worth a human eye:** whether the drawing is legible at phone width. The
viewer is shared with the coach's desktop view, and scaling is the one thing a
test cannot judge.

### Already covered automatically - do NOT re-test by hand

`test_player_results_drawing.py` (14) covers the delivered-image binding, the
coach/player payloads being identical, exclusion keeping the drawing, the
coach's private reason never leaking, empty and missing drawings degrading to
text, answer-key leakage, and drawings loading in one query.
`ResultsView.test.tsx` (5 new) covers the rendering choices.

---

## Known bounded gap - the Vitest collection flake

`QuestionEditor.test.tsx` did not run in the `npm run test:ci` that shipped
`94b63c2`, **nor in the one that shipped `8063e31`** - two consecutive runs,
the same file each time. It passes standalone (39 tests) and neither commit
touches it or anything it imports, but it was not part of either green run.

**The third run, shipping Phase 4B step 2, was CLEAN** - all 89 files ran,
1093 tests, exit 0. So it did not become a reproducible failure, and the
"worker starvation" hypothesis survives. Two drops then a clean run is
consistent with load-dependent flakiness and not with a broken file.

This is the documented collection flake (see CLAUDE.md), and the guard is
doing its job by refusing to call a short run green. Recorded rather than
chased, by instruction. Nothing here is outstanding - it is kept as the
history that makes the next occurrence readable.
