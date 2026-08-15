# Delivered-question snapshots — approved design

**Status: APPROVED. PHASE 1 SHIPPED (write + preserve, production verified).
PHASE 2 SHIPPED (unified score helper, zero behaviour change).
PHASE 3 SHIPPED ("don't count this question", production verified).
PHASE 4a + 4a-bis IMPLEMENTED (snapshots become readable; attempt version
invariant), awaiting review.**
13-14 August 2026. Baseline `a002fdf`; Phase 1 is `25a383c`; Phase 2 is `e81397b`.

Phase 4b (remove from future attempts) and 4c (broader editing unlocks) remain
designed and NOT authorised. **Read "THE ATTEMPT VERSION INVARIANT" and "THE
REGION EXCEPTION" at the bottom before touching question editing or region
corrections.** Scoring still reads answer rows, not snapshots - see "THE PHASE
3 BOUNDARY".

## The problem

Peira stores WHETHER an answer was correct (`answers.is_correct` is a stored
column) but preserves no record of WHAT the player saw when that grade was
earned. `answers` holds `question_id` and `selected_option_id` pointing at LIVE
rows, so editing a question makes Results show an old answer against a question
the player never saw, and deleting one cascades the answers away entirely.

This is the shared gap behind BOTH queued issues - active-quiz correction needs
it so a fix does not rewrite history, and "don't count this question" needs
somewhere to record an exclusion that is not the live question.

## Approved architecture

**Delivered-question snapshot.** Copy-on-write question versioning was
considered and REJECTED: Peira is not versioning quizzes as documents, it is
recovering from a mistake, and A is reversible into B later while B is not
undoable.

### Why a sibling table, not a column on `answers`

Phase 0 traced the lifecycle and found `Answer(...)` is constructed in ZERO
places in the app - the only path is `upsert_answer`, called when a player
actually answers. **An unanswered question has no Answer row.** A snapshot
living on `answers` therefore could not describe a skipped question, which
breaks "don't count this question" precisely, because exclusion changes the
DENOMINATOR and the denominator includes unanswered questions.

```
attempt_question_snapshots
  id
  attempt_id    FK player_attempts ON DELETE CASCADE
  question_id   FK questions      ON DELETE SET NULL   -- survives deletion
  position      int                                    -- as delivered
  snapshot      JSONB
  captured_at   timestamptz
  UNIQUE (attempt_id, question_id)
```

### Timing

Written at **`POST /play/start`**, one row per question in the frozen
`question_order` - the same moment the order is frozen. One definition:
**starting an attempt freezes what that attempt received.**

Not lazy/first-view: that would miss questions the player never opened.

### Snapshot contents (minimum trustworthy set)

`question_text`, `question_type`, `options[]` (id, text, `is_correct_answer`),
`expected_answers`, `answer_matching`, and where applicable `image_url`,
`canvas_width`, `annotations`.

Deliberately EXCLUDED: `answer_explanation` (post-answer teaching material,
already freely editable and safe to improve), `position` beyond the column,
timestamps, region geometry beyond the rendered image. Do not expand this into
a copy of every Question column.

### Historical image lifetime — the trap

`_reject_if_already_answered` does NOT guard the image routes. `POST .../image`
and `DELETE .../image` both call `storage.delete_image` unconditionally, so a
coach replacing an image after delivery physically destroys the object a
snapshot points at. **This is the Duplicate Quiz bug in a different costume.**

**Copy-on-write at replace/delete time, not at delivery.** When a live image is
replaced or removed AND a snapshot references it: `copy_image` the old object
first (the R2-proven path from `0f146bd`), repoint the affected snapshots at
the copy, and only then let the live delete proceed.

Cost is paid only when a coach edits a delivered image (rare) rather than per
attempt (common). Snapshotting bytes eagerly would copy an image per attempt -
the expensive, wrong direction.

**Fail-safe, same philosophy as the duplicate fix:** if historical preservation
fails, the coach's destructive image operation FAILS rather than destroying
evidence. Must be transactional enough that we cannot get: snapshot updated but
copy missing, original deleted before preservation succeeded, orphaned copies
after DB failure, or some snapshots on the old asset and some on the copy.

### Attempt-start failure behaviour

Snapshot creation is part of starting the attempt. If a complete trustworthy
snapshot cannot be written, **fail the start and roll back** - do not create a
partially snapshotted attempt. A NEW attempt must never become "legacy"
because a write failed.

### Legacy data

**NO BACKFILL.** Manufacturing snapshots from current questions would create
false history. Pre-existing attempts have no rows and read honestly as
"delivered content not recorded" - exposed quietly where it matters, without
making old results look broken.

## Phase 1 scope (authorised)

Table + migration; snapshot creation at `/play/start`; the content above;
historical image preservation; tests. **WRITE + PRESERVE ONLY** - nothing reads
snapshots for product behaviour yet, so Phase 1 ships with ZERO user-visible
change.

Must NOT change: scores, grading, Results, exports, analytics, player history,
Practice, Graded, Competition, the editor, current edit locks, correct-answer
editing, or deletion UX. Hard deletion of answered questions stays blocked -
that belongs to Phase 4.

## Later phases (approved sequence, not authorised)

2. ~~**Unify the score helper.**~~ **DONE** - see "What Phase 2 actually
   shipped" below. The rule lived in four places; it now lives in
   `services/scoring.py`.
3. **"Don't count this question."** `question_exclusions` (question,
   `access_code_id` nullable, coach, reason, `excluded_at`, `restored_at`).
   Default scope is THIS ASSIGNMENT, not quiz-wide - a bad Monday delivery must
   not rewrite Tuesday's results. Reversible via `restored_at`, never deletion.
   The row is its own audit record; do NOT force it into the answer-scoped
   `GradeAuditLog`.

   **The player wording in the original design - "Your score is now out of 9" -
   was WRONG and was not built.** Today's denominator is GRADED ANSWERS, not
   the delivered question count, so "out of 9" is simply untrue for a player
   who left two questions blank. The player results page also shows no
   aggregate score at all, so there was no number to update. What shipped
   instead: the excluded question carries a neutral "Excluded from scoring"
   badge with the player's own answer still shown, and one plain sentence.
4. **Safe question correction.** Text / explanation / image / option text
   become correctable under snapshot protection. **Correct-answer changes stay
   BLOCKED** (two cohorts graded under different rules needs explicit product
   treatment). Hard delete is replaced by two distinct concepts, deliberately
   not one overloaded button: REMOVE FROM FUTURE DELIVERY vs EXCLUDE FROM
   EXISTING RESULTS.

## Competition

**Untouched. M2 stays frozen.** Forward-compatible only: the same table could
later snapshot at `_freeze_question_order`, which would fix a deleted question
breaking `question_order` and make finished competitions explainable. Do not
build that now. A test asserts no competition module references this table.

## What Phase 1 actually shipped

Backend only; the frontend is byte-for-byte unchanged.

| | |
|---|---|
| Table | `attempt_question_snapshots`, migration `f9a3c07b21de` |
| Model | `models/attempt_question_snapshot.py`; `PlayerAttempt.question_snapshots` |
| Capture | `services/question_snapshots.capture_attempt_snapshots`, called from `POST /play/start` inside the attempt's own transaction |
| Preservation | `services/question_snapshots.historical_image_preserved`, used by the two image routes AND by `delete_question` |
| Tests | `tests/test_delivered_question_snapshots.py` |

Two things the design implied rather than stated, decided during implementation:

1. **`delete_question` preserves too.** The design named `POST .../image` and
   `DELETE .../image`. But `_reject_if_already_answered` fires on ANSWERED, not
   on DELIVERED - so a question delivered and skipped can still be deleted, and
   deleting it destroyed its image the same way. Same trap, third door. No UX
   changed: the delete still succeeds.
2. **`delete_quiz` deliberately does NOT preserve.** Deleting a quiz deletes its
   attempts, and an attempt takes its snapshots with it, so there is no history
   left to point at those images. Noted in a comment there so it reads as a
   decision rather than an omission.

The ordering that makes preservation safe is: **copy → repoint → COMMIT →
unlink**. The code it replaces unlinked first. One copy serves every affected
snapshot, so no failure can leave some attempts on the old asset and some on a
copy. A crash between the commit and the unlink leaks one unreferenced object -
the deliberately chosen direction, since a leaked object costs pennies and a
destroyed one costs the evidence.

## What Phase 2 actually shipped

Backend only; the frontend is byte-for-byte unchanged. Zero behaviour change,
proven by 16 characterization tests written BEFORE the refactor and passing
unedited after it (`tests/test_scoring_characterization.py`).

**`services/scoring.py` is now the canonical backend scoring semantics.**

| | |
|---|---|
| `classify(answer)` | the four-way outcome: CORRECT / INCORRECT / NOT_GRADED / UNANSWERED |
| `score_percent(correct, scored_total)` | THE formula - one decimal, `None` (never `0.0`) on an empty denominator |
| `ScoreCounts` | `correct`, `incorrect`, `not_graded`, `unanswered`; `.scored_total` is THE DENOMINATOR; `.percent`; `__add__` pools across attempts |
| `count_answers(answers)` | counts from ANSWER ROWS. `unanswered` is `None` = **not measured** |
| `count_delivered(questions, answers_by_qid)` | counts over DELIVERED QUESTIONS, so `unanswered` is a real integer |
| `pending_grading_count(answers)` | deliberately separate - a grading-queue badge, in no denominator |

Migrated: `quizzes.py` (formula only), `players.py` (per-attempt, cumulative,
totals), `grading.py` (per-question breakdown, legacy history), `export.py`
(`_grading_result`, `_score_percent`, `_player_result_counts`, the simple PDF
fraction, the CSV labels). Deliberately NOT migrated: completion rate and
response rate (different measurements that merely share the arithmetic shape),
per-surface display wording, and Competition.

### THE PHASE 3 BOUNDARY - corrected, and what actually shipped

An earlier draft of this section said Phase 3 "must FIRST give the answer-row
surfaces delivered-question information". **That was wrong**, and it was
corrected by measurement before any exclusion code was written. The corrected
rule is:

> **SCORE EXCLUSION -> filters ANSWER ROWS.**
> **DELIVERED / UNANSWERED REPORTING -> uses delivered-question information.**

Why the original claim was wrong: today's scoring denominator contains only
GRADED ANSWER ROWS (`correct + incorrect`). A delivered question nobody
answered has no row and is therefore already outside the denominator - so
excluding it cannot move the score. Proven on a 75,000-answer fixture with the
excluded question deliberately left unanswered by 25 attempts:

```
exclude by filtering ANSWER ROWS      -> 1060/1260 = 84.1%
exclude from the DELIVERED set        -> 1060/1260 = 84.1%   (identical)
```

The delivered set is still required for REPORTING - the same query reports 40
questions that are delivered, unanswered and still counting, which answer rows
cannot produce. So snapshots matter for what a report SHOWS, not for the
percentage. **That is why a legacy attempt with no snapshots still gets a fully
correct exclusion-aware score.**

Phase 2's arithmetic was not touched: `score_percent` and
`ScoreCounts.scored_total` are unchanged, and exclusion filters the INPUT.

### `quizzes.py` - Option A was chosen, and why

The quiz-card average is the one figure computed by **pooled SQL aggregation**
across every submitted official attempt of a quiz. Measured at 50 quizzes x 100
attempts x 15 questions (75,000 answers), median of 5 runs, raw tuples:

| | Median |
|---|---|
| pooled SQL aggregate, as it was | 19.2 ms |
| **same aggregate + `NOT EXISTS` anti-join (chosen)** | **33.4 ms** |
| load every row and count in Python | 87.8 ms |

Option B was rejected on that measurement - 4.5x slower before ORM and network
overhead, and it would materialise 75,000 rows into the web process on every
dashboard render. Option C (a rollup) was unnecessary.

**The consequence is one deliberate duplication:** the exclusion predicate is
spelled in Python (`ExclusionSet.excludes`) and in SQL (`sql_not_excluded`,
which lives next to the Python so the two are read together). That duplication
is held in place by the equivalence class in
`tests/test_question_exclusions.py`, which asserts the SQL quiz-card percentage
equals the Python-counted percentage over the same data for: nothing excluded,
an answered exclusion, an unanswered exclusion, quiz-wide, restore, an
overlapping pair, and an exclusion that empties the denominator. **If you change
the rule in one spelling, those tests are what will tell you that you forgot the
other.**

**Note that exclusion is scoped per assignment** (`access_code_id` nullable),
so the SQL cannot simply exclude a question id globally - a bad Monday delivery
must not rewrite Tuesday's results.

## Known scoring inconsistencies - recorded, deliberately NOT fixed

Found during the Phase 2 audit. All three predate Phase 2 and none was changed
by it, because fixing any of them would alter a number somebody already sees.

**Finding A - two pages, one attempt, two different percentages.**
`PlayerHistoryPage.tsx` computes `Math.round(correct / graded * 100)` from the
counts `GET /players/history?name=` returns, giving a WHOLE percent (67%).
`PlayerProfilePage` renders the backend's `average_score_percent`, one decimal
(66.7%). The same canonical attempt appears in both (it has `player_id` set AND
`player_name` populated), so the same data is displayed two ways. The RULE
agrees; only the precision differs, because the legacy endpoint ships counts
and lets the browser divide. `grading.py`'s history payload carries a comment
saying it returns counts only on purpose - do not "tidy" that into a
server-side percentage without deciding this first. Fixing it changes a
displayed historical number.

**Finding B - the practice summary uses a denominator it does not document.**
`frontend/src/pages/play/practiceSummary.ts` claims to follow
`correct / (correct + incorrect)`. It does not: its denominator is every
auto-gradable question the player CHECKED, which includes ones with
`is_correct === null`. A player who skips a multiple-choice question and presses
"Check Answer" gets `{auto_gradable: true, is_correct: null}` (characterized in
`test_scoring_characterization.py`), which lands in the denominator but not the
numerator - i.e. scored as wrong, where the canonical rule excludes it. Not a
cross-surface conflict: practice attempts are excluded from every official
surface by `official_only`, so nothing else ever scores the same attempt.

**Finding C - `services/player_analytics.py` does not exist.** `export.py` and
CLAUDE.md both cited it as the rule's second home. It has never been on master;
it lives only on `origin/feature/player-progress-analytics`. Both references
were corrected in Phase 2 to point at `services/scoring.py`. Documentation
only - no behaviour was involved.

## What Phase 3 actually shipped

| | |
|---|---|
| Table | `question_exclusions`, migration `c4e1b8f70a25` |
| Model | `models/question_exclusion.py` |
| Predicate | `services/question_exclusions.ExclusionSet.excludes` (Python) and `sql_not_excluded` (SQL) |
| Routes | `routes/question_exclusions.py` - create, restore, list, plus the assignment picker |
| Tests | `tests/test_question_exclusions.py` |

**Scope.** `access_code_id` NULL = quiz-wide; a value = that assignment only.
Both may be active at once and a question covered by either is excluded once.
Two partial unique indexes enforce "at most one active of each kind" - one
index cannot, because Postgres treats NULLs as distinct and every quiz-wide row
has a NULL there.

**The UI never guesses the scope.** The coach Results tab pools every
assignment of a quiz, so "this assignment" is ambiguous there. The confirmation
dialog therefore makes the coach choose, labelled from metadata that already
exists (date, group names, submitted count, code) - no schema was added to name
assignments. It pre-selects ONLY when the quiz has exactly one assignment.
Quiz-wide is offered as an explicit broader option with a stronger warning and
is never the default.

**Evidence is never destroyed.** No answer row is read differently, edited or
deleted - exclusion filters at scoring time. The per-question breakdown keeps
its raw correct/incorrect/ungraded counts and is MARKED instead, because those
counts are usually the reason the coach excluded the question. The CSV keeps
the row and labels it `Excluded`. The detailed PDF keeps the question's card
with a neutral chip.

**Restore is honest about overlap.** The restore endpoint returns
`still_excluded_by`, so a coach restoring one of two overlapping exclusions is
told the question is still excluded by the other rather than being shown a
success that did not happen.

**FK behaviour**, decided deliberately: `question_id` CASCADE (an answered
question cannot be hard-deleted today, and if one does go its answers cascade
with it, leaving an exclusion pointing at no evidence); `access_code_id`
CASCADE (deleting an assignment deletes its attempts); `coach_id` SET NULL
(a coach leaving the org loses the attribution, not the record).


## What Phase 4a + 4a-bis shipped

Phase 1 recorded what every attempt was delivered and deliberately let nothing
read it. **Phase 4a is that read**, and **4a-bis makes the record true after a
refresh.**

### THE ATTEMPT VERSION INVARIANT

> **ONCE AN ATTEMPT STARTS, IT STAYS ON THE VERSION IT WAS DELIVERED.**
> **Coach corrections apply to NEW attempts only.**

| | |
|---|---|
| **NEW attempt** | current live quiz → snapshot captured at `/play/start` |
| **EXISTING attempt** | its delivered snapshot version, on every resume |
| **LEGACY attempt** | live compatibility fallback, because delivered content was never recorded |

Why it was needed: question CONTENT and attempt IDENTITY arrive from two
different calls. `/validate-code` is identity-free by construction - it returns
the roster the player then picks from - so it serves the LIVE quiz. A refresh
mid-quiz therefore re-fetched live content and rendered version B inside a
version-A attempt. `/play/start` is the first moment the server knows which
attempt belongs to the caller, so the delivered questions ride on that
response, and the client prefers them over the join payload.

There is no live-update mechanism. A correction becomes visible to that player
only on a NEW attempt - no polling, no websockets, no forced refresh.

### The player payload is a security boundary

`to_player_payload` is a SEPARATE serializer from the coach-facing one and
**builds** a safe shape rather than filtering an unsafe one, so a field added to
the coach serializer cannot leak by default. It never emits
`is_correct_answer`, `expected_answers`, `answer_matching` or
`answer_explanation`. Tests inspect the RAW response body, not the parsed
object.

### Historical displays read the snapshot

`services/delivered_questions.py` is the single reader. The player's results
page, the CSV, the detailed PDF and the coach's expanded per-player view all go
through it, so they cannot disagree about what a player received - text, type,
options, selected answer, image, annotations, and the delivered question
number.

`answers.is_correct` remains the historical verdict and is **never recomputed**
from the snapshot's answer key. Scoring still counts answer rows; Phase 2's
arithmetic and Phase 3's exclusions are untouched.

### Historical Q# vs live Q#

- **Historical attempt displays** use the delivered snapshot order. A later
  reorder must not retitle a report already shared.
- **The live per-question breakdown** describes the quiz as it stands today,
  because it aggregates every attempt - and different attempts can have had
  different orders (randomized practice already does), so no single historical
  number exists for it.

### `require_all_answers` uses the delivered set

Submission validates against the questions THAT ATTEMPT received, not today's
quiz. A question added after an attempt started cannot strand a player on one
they were never shown; a new attempt receives it and is held to it.

### THE REGION EXCEPTION - read before unlocking region editing

A region-backed question's picture is a signed masked render minted per access
code, and the snapshot **deliberately does not record region geometry**. So the
masked URL on a resumed attempt comes from the LIVE region.

**That is truthful ONLY because region editing stays blocked after delivery.**
Unlocking region corrections without first building masked-render preservation
would silently show past attempts a page they never saw. Do not unlock it
without solving that.

### Images

| | |
|---|---|
| Old attempt | preserved copy, from the snapshot (Phase 1's copy-on-write, now finally rendered) |
| Live quiz / new attempt | the corrected image |

Draw Response keeps live image id/version for stroke-source keying, because the
snapshot does not record them and Draw Response persistence is not built.

### Legacy attempts

No snapshot means no delivered record. Those attempts fall back to the LIVE
question - a **compatibility fallback, not history**. Nothing is invented,
nothing is backfilled, and `from_snapshot: false` is carried through the API so
an explicit "delivered content not recorded" indicator can be added later with
no architectural change.

### Reading a snapshot is an N+1 waiting to happen

Every surface that now calls `delivered_questions()` walks a relationship
(`attempt.question_snapshots`) that is lazy by default. Phase 4a introduced
**three** N+1s this way, and each was caught by a query count rather than by
review:

| Where | What lazy-loaded | Fix |
|---|---|---|
| `_load_responses_for_export` | `question_snapshots` per attempt | `selectinload` |
| `_delivered_payload` (`/play/start`) | `question.regions` per question | one `QuestionRegion` lookup for the whole quiz |
| `player_results` | `question_snapshots`, `answers.selected_option` | `selectinload` |

If you add another reader, add the eager load in the same commit.

**Query guards here are scale-invariant on purpose.** A flat bound
(`assert len(queries) < 20`) passes an N+1 that simply has not grown yet - it
is satisfied by a 3-question fixture no matter how the cost scales. The guards
in `tests/test_attempt_version_invariant.py` compare a 3-question quiz against
a 15-question one and require the difference to stay flat, which is what
actually pins the eager loads. Removing the `player_results` eager load moves
it from 9 queries to 21; that is the number the test exists to catch.

They also assert the request returned 200 and that the count is non-zero.
The first version of the `player_results` guard sent `access_code_id` where
the route takes `code`, so the request failed validation before touching the
database and the assertion passed on **zero queries** while proving nothing.
A query-count test that cannot fail is worse than no test.
