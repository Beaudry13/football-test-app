# Delivered-question snapshots — approved design

**Status: APPROVED, Phase 1 authorised, NOT YET IMPLEMENTED.** 13 August 2026.
Baseline `a002fdf`.

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

2. **Unify the score helper.** The rule lives in at least FOUR places -
   `export.py:603`, `players.py:188`, `players.py:202`, `quizzes.py:136`
   (CLAUDE.md says two; it understates the risk). Extract with proven
   value-for-value equivalence BEFORE exclusion exists.
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
build that now.
