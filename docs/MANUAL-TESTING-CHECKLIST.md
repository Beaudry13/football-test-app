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

## DRAW RESPONSE PHASE D / EXPORTS

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `f9d11a9` (17 Aug 2026). Deployed and health verified. No migration.
Backend only - no frontend change in this commit.

- [ ] Export the CSV for a quiz with a Draw Response - the Answer cell reads
      `Drawing submitted`
- [ ] A player who skipped it reads `No drawing`
- [ ] An excluded drawing keeps `Drawing submitted` in Answer AND `Excluded`
      in Correct - both facts, not one
- [ ] Export the DETAILED PDF - the drawing is visibly there, over the right
      picture, in the right place
- [ ] **Orientation:** a mark made near the top of the image appears near the
      top in the PDF, not mirrored to the bottom
- [ ] Stroke thickness looks natural - not hairline, not slab
- [ ] Replace the question's image as coach, re-export - the PDF still shows
      the ORIGINAL picture with the original drawing on it

**Why orientation is on this list.** PDF space measures y upward from the
bottom-left; a browser canvas measures it downward from the top-left. A flipped
drawing still looks like a plausible drawing, so it is worth one real glance
even though a test asserts it.

### Already covered automatically - do NOT re-test by hand

`test_export_drawings.py` (25 tests) covers all of the above, plus the failure
paths: malformed documents, invalid strokes, unloadable images, no mutation of
the stored document, and the delivered-image proof after a replacement.

---

## BUG - PLAYBOOK QUESTION INVISIBLE IN PREVIEW

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
No migration - one payload field plus one CSS class.

Preview showed an empty card for every playbook question. The masked page was
minted only on the two PLAYER routes, so the coach payload Preview builds its
screen from had no picture in it at all - and with the picture gone, the only
thing left was the Fill in the Blank answer field, which had wrongly inherited
the written-response box's 7em height. A tall empty rectangle.

The real player attempt was always correct, which is the part that made this
worth fixing quickly: Preview is what a coach checks before sending a Peira,
and it was the only surface lying.

- [ ] Preview a quiz containing a playbook question - the masked page appears
      immediately, first render, no navigation
- [ ] The mask still covers the answer (it must NOT be readable)
- [ ] Take the same quiz as a player - same picture, same mask
- [ ] The Fill in the Blank box looks like an answer field, not an empty panel
- [ ] A Written Response question still has its tall box
- [ ] An ordinary uploaded-image question is unchanged
- [ ] Check on a phone - the masked page is legible at that width

**Why your eyes:** the tests prove the same BYTES reach both audiences and
that the field carries the right class. Whether the mask reads as deliberate
on a real playbook page, and whether the answer field now looks right beside
it, are visual judgements no assertion here makes.

### Already covered automatically - do NOT re-test by hand

`test_preview_masked_media.py` (11) covers the coach payload carrying the URL
on first read, the URL actually serving an image, both audiences resolving to
byte-identical pixels, no storage key or unmasked page anywhere in the raw
coach body, the issued token decoding to the mask kind, the player payload
still carrying no answer key, and that the snapshot STILL records no region
geometry - so closing the region exception stays a separate decision.
`QuizPreviewPlaybook.test.tsx` (7) covers the client half, including that a
missing URL renders no picture rather than reaching for the raw page.

Five of the backend tests and one frontend test were confirmed to FAIL against
the unfixed code.

---

## BUG - IMAGE QUESTION FIRST VISIT

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `5d05c43` (18 Aug 2026). Deployed and health verified.
No migration - frontend only.

A question's picture did not appear the first time a player arrived at it.
Going forward a question and back made it appear, so the image existed and
could render - it was invisible until the player performed a navigation cycle
nobody told them about. Reported from a real Peira sent 17 Aug 2026, Q18.

Root cause was client-side only: Fabric restores a canvas element's inline
style on dispose, which wrote `display: none` back underneath React, and the
reload then set an already-true flag so React never re-applied the style. Only
questions whose image has COACH ANNOTATIONS were affected, and only when
arrived at from another annotated-image question.

- [ ] open the 17 Aug 2026 Peira, go to Q18, confirm the image appears
      immediately with no forward/back
- [ ] next/back, confirm the image remains correct
- [ ] confirm the annotations still sit in the right place on the picture
- [ ] confirm mobile sizing looks right

**Why your eyes and not a test:** the automated test proves the canvas is
displayed and that the delivered picture was the one requested. It cannot
judge whether the picture LOOKS right on a phone, and jsdom paints nothing -
annotation alignment is a visual property no assertion here covers.

### Already covered automatically - do NOT re-test by hand

`QuizStepQuestionImage.test.tsx` (6) drives the real player flow with the real
AnnotationViewer and the real Fabric StaticCanvas: first visit after another
annotated question, first visit after a question with no picture, the plain
unannotated path, next/back across annotated questions, the exact reported
sequence, and that the DELIVERED picture is the one loaded rather than the
live one. Four of the six fail against the unfixed code.

---

## MULTI-SELECT / SELECT ALL THAT APPLY

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped as M1 `5d2f266`, M2 `ed37eac`, M3 `949fc6d`, plus the wording change.
M4 (results and exports) is separate and NOT YET DEPLOYED.
Carries migration `a7fd4276c072` - one boolean column and one join table,
additive, with a backfill of every existing selection. M4 adds NO migration.

A multiple-choice question can now accept more than one correct answer.

**COACH**
- [ ] The "Select all that apply" control is obvious and does not clutter the
      editor
- [ ] Marking several correct answers feels natural
- [ ] Creating an ordinary single-choice question feels EXACTLY as it did

**PLAYER**
- [ ] "Select all that apply" is understandable at a glance
- [ ] Whole answer rows are easy to tap on a phone
- [ ] Selected state is obvious
- [ ] Selections toggle naturally; no confirmation step
- [ ] Refresh restores EVERY selection, not one

**PRACTICE**
- [ ] Check Answer gives an overall Correct / Incorrect
- [ ] It does NOT reveal which individual boxes were right

**GRADING**
- [ ] Exact correct set -> correct
- [ ] Missing one -> incorrect
- [ ] One extra -> incorrect

**COMPETITION**
- [ ] Starting a competition on a quiz containing one is clearly blocked, and
      the message says which question

**RESULTS AND EXPORTS (M4)**
- [ ] The player's own results page reads naturally: "Mike; Nickel; Boundary
      Safety" on one line, not a wall of text
- [ ] Three or four selections still fit on a phone without wrapping badly
- [ ] The coach's expanded response shows the same words in the same order
- [ ] The CSV cell is readable in Excel/Sheets and does not split the row
- [ ] The detailed PDF's stacked list looks right beside a long question, and
      the CORRECT ANSWER block reads as a comparable list rather than a wall

**The one thing worth your eyes most:** whether the editor still feels simple.
The feature is one contextual checkbox by design, and whether that reads as
"one more thing to understand" or as an obvious option is a judgement no test
can make.

### Already covered automatically - do NOT re-test by hand

`test_multi_select_storage.py` (13), `test_multi_select_authoring.py` (12),
`test_multi_select_play.py` (24), `test_multi_select_practice_and_competition.py`
(9), `QuestionEditorMultiSelect.test.tsx` (13) and
`QuestionInputMultiSelect.test.tsx` (12) cover exact-set grading in both
directions, order independence, empty-set-is-unanswered, resume of the complete
set, write-time validation of option ids, historical wording after a coach
edit, the Competition fence, and that practice reveals no per-option verdicts.

M4 adds `test_multi_select_results.py` (40),
`test_multi_select_results_performance.py` (4) and
`ResponseRowMultiSelect.test.tsx` (8): the full set on both results surfaces,
delivered wording surviving a later rename, delivered order surviving any tap
order, exclusion keeping the evidence, the CSV cell surviving a real CSV
parser, the PDF printing selections that appear nowhere in the answer key, no
answer-key leakage, snapshots unmodified by reading, and query counts that stay
flat from 6 answers to 120.

**The PDF tests were rewritten after they were caught passing against the
unfixed code** - the card prints the answer key too, so asserting that a
CORRECTLY selected option appears proves nothing. They now select only WRONG
options, which can reach the page no other way.

Migration rehearsed upgrade -> downgrade -> upgrade on real data: 20 answers
with a selection, 20 backfilled rows, zero mismatches.

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
