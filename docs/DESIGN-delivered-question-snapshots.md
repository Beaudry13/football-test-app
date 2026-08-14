# Delivered-question snapshots — approved design

**Status: APPROVED. PHASE 1 SHIPPED (write + preserve, production verified).
PHASE 2 SHIPPED (unified score helper, zero behaviour change).**
13-14 August 2026. Baseline `a002fdf`; Phase 1 is `25a383c`.

Phases 3-4 remain designed and NOT authorised. Nothing reads a snapshot for
product behaviour yet. **Before designing Phase 3, read "THE PHASE 3 BOUNDARY"
near the bottom** - centralizing the score formula did NOT centralize which
questions each surface counts, and that difference is the whole of Phase 3.

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
   `GradeAuditLog`. Players are told: "Question 7 was excluded from scoring by
   your coach. Your score is now out of 9."
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

### THE PHASE 3 BOUNDARY - read this before designing exclusions

**Phase 2 centralized HOW A SCORE IS CALCULATED. It did NOT centralize HOW EACH
SURFACE DETERMINES THE SET OF QUESTIONS BEING SCORED.** That distinction is the
whole of Phase 3, because exclusion changes WHAT IS COUNTED, not the formula.

**Do NOT assume that teaching `score_percent` about exclusions implements
"don't count this question" everywhere. It does not, and it cannot.**

Where each surface gets its set today:

| Surface | Counts from | Can express "excluded"? |
|---|---|---|
| `export.py` detailed PDF | `count_delivered` - the quiz's questions | **Yes** - filter the `questions` argument |
| `players.py` profile + cumulative | `count_answers` - answer rows | **No** |
| `grading.py` legacy history | `count_answers` - answer rows | **No** |
| `grading.py` per-question breakdown | `count_answers` - answer rows | **No** |
| `quizzes.py` quiz-card average | pooled SQL `SUM(CASE ...)` | **No** - see below |

An answer-row count CANNOT express an excluded question, because **an excluded
question that nobody answered has no row to filter out** - and those are
exactly the questions exclusion has to be able to talk about. This is the same
fact that made Phase 1 a sibling table rather than a column on `answers`.

`count_delivered` takes the delivered questions as an ARGUMENT rather than
deriving them, and `ScoreCounts` carries `unanswered`, precisely so that
excluding a question is a change to what is passed in and never a change to the
arithmetic. That is the seam. It is currently used by one surface.

**Phase 3 must therefore FIRST give the answer-row surfaces delivered-question
information** - which is what `attempt_question_snapshots` records, unanswered
questions included - and only then apply exclusions to it. Treat that as an
explicit first step, not something to discover halfway through.

### `quizzes.py` is the special case, and needs a deliberate decision

The quiz-card average is the one figure computed by **pooled SQL aggregation**
across every submitted official attempt of a quiz:

```sql
SUM(CASE WHEN answers.is_correct IS TRUE     THEN 1 ELSE 0 END)  -- correct
SUM(CASE WHEN answers.is_correct IS NOT NULL THEN 1 ELSE 0 END)  -- denominator
```

It shares the FORMULA (`score_percent`) but not the counter, on purpose: it is
the one aggregate that must not load every answer of every attempt just to
divide two numbers. An exclusion rule expressed as Python objects will not
reach it.

Phase 3 must choose ONE of, explicitly:

1. an exclusion-aware SQL design (an anti-join or NOT EXISTS against
   `question_exclusions`, scoped per `access_code_id`), keeping the aggregate;
2. moving this surface onto the shared counter and accepting the load; or
3. a different aggregation strategy (a maintained per-quiz rollup).

Option 1 preserves today's performance but means the exclusion rule is written
twice - once in Python, once in SQL - which is exactly the duplication Phase 2
existed to remove. If it is chosen, the two spellings need a test that proves
them equivalent on the same data, the way Phase 2's characterization suite
proves the four old sites agreed.

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
