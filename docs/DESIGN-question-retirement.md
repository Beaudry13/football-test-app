# Phase 4B audit — Remove from future delivery ("retire a question")

**Status: AUDIT ONLY. Not implemented. Not approved for implementation.**
Audited against `94b63c2` (Phase 4A + 4A-bis shipped).

## The three operations, kept separate

| Operation | Changes | Phase |
|---|---|---|
| **Correct** | the live question, for FUTURE attempts | 4A |
| **Retire** | whether the question is DELIVERED to future attempts | 4B (this) |
| **Don't count** | whether it SCORES for players who already got it | 3 |

They compose freely and none implies another. Retiring changes no score.
Excluding delivers nothing differently. Correcting does neither.

**THE INVARIANT: retirement must never remove a question from an attempt that
already received it.**

---

## 1. Exact schema change

Two nullable columns on `questions`:

```sql
ALTER TABLE questions
  ADD COLUMN retired_at TIMESTAMPTZ NULL,
  ADD COLUMN retired_by_coach_id INTEGER NULL
    REFERENCES coaches(id) ON DELETE SET NULL;

CREATE INDEX ix_questions_quiz_active
  ON questions (quiz_id) WHERE retired_at IS NULL;
```

Additive, nullable, no enum change, no backfill. `NULL = deliverable` means
every existing row is correct the moment the column appears.

The partial index matches the only hot predicate (deliverable questions for
one quiz). `ON DELETE SET NULL` on the coach mirrors how the codebase already
treats an author who leaves.

## 2. Is `retired_at` still the best design?

**Yes — and Phase 1 is why.** The obvious alternative is a
`question_retirements` table mirroring `question_exclusions`, with
`restored_at`, for audit and reversibility.

That was the right shape for exclusions because **an exclusion changes a
number a coach already saw**, so "when did this stop counting, and who
decided" is genuinely load-bearing.

Retirement changes no score and no existing attempt. The only question it can
provoke — *"why didn't Tuesday's attempt include Q5?"* — is already answered
definitively and per-attempt by `attempt_question_snapshots`. **The delivered
snapshots ARE the retirement audit trail**, and they are better evidence than
a retirement table would be, because they record what each attempt actually
got rather than what the flag said at some moment.

So: a column, not a table. Un-retire sets both fields NULL.

A boolean would also work; `retired_at` is preferred because it costs the same
and answers "when" for free.

## 3. Every place questions are selected for NEW attempt delivery

All delivery selection funnels through `services/attempts.py`:

| Site | Role | Retirement-aware? |
|---|---|---|
| `authored_question_ids(quiz)` | `[q.id for q in quiz.questions]` — the root | **must NOT filter** (see §4) |
| `frozen_question_order(quiz, randomize=)` | shuffles for randomized practice | **must filter** |
| `presented_question_ids(attempt, quiz)` | order to SHOW | **must NOT filter** (see §4) |
| `capture_attempt_snapshots(attempt)` | writes the delivered record | **must filter** |
| `routes/access_codes.py` activation | validates + numbers | **must filter** (see §8) |

The new-attempt path needs one new helper:

```python
def deliverable_question_ids(quiz) -> list[int]:
    """Questions a NEW attempt may receive. Retirement applies HERE and
    nowhere on the read path."""
    return [q.id for q in quiz.questions if q.retired_at is None]
```

## 4. Where filtering retired questions would be DANGEROUS

**This is the finding that shapes the whole phase.**

`presented_question_ids(attempt, quiz)` serves two masters. It computes the
delivered set for a NEW attempt *and* the `question_order` returned to an
EXISTING one. And critically:

> **Graded attempts store `question_order = NULL`.** `frozen_question_order`
> returns None for anything non-randomized, deliberately (a stored copy would
> go stale on reorder). So a graded attempt has no frozen list at all — its
> order is **re-derived from the live quiz on every single read**.

Therefore filtering retirement inside `authored_question_ids` or
`presented_question_ids` would retroactively rewrite the order of every
in-progress graded attempt. Three consequences, in increasing severity:

1. **Snapshotted attempt:** content still comes from the snapshot, and
   `orderQuestions` appends anything missing from the order — so the question
   is not lost, but it **jumps to the end of the quiz mid-attempt**. Visible
   and confusing.
2. **Legacy attempt (no snapshot):** content falls back to the live quiz, so
   the retired question **disappears outright from an in-progress attempt**.
   Direct violation of the invariant.
3. **`capture_attempt_snapshots`** calls `presented_question_ids`, so any
   filtering there is load-bearing in the opposite direction — it *must*
   filter, but only for the new attempt.

**The rule: retirement is a DELIVERY-TIME filter, never a READ-TIME filter.
It must never be applied as a blanket filter on `Quiz.questions`.**

### The architectural improvement this suggests

Phase 4A recorded the delivered order but `question_order` still doesn't read
it. For a snapshotted attempt, the order should come **from the snapshot
positions**, not from re-reconciling against the live quiz:

```python
def presented_question_ids(attempt, quiz):
    rows = sorted(attempt.question_snapshots, key=lambda r: r.position)
    if rows:
        return [r.question_id for r in rows if r.question_id is not None]
    ...existing live reconciliation, for legacy attempts only...
```

This makes the invariant true **by construction** rather than by remembering
not to filter in the wrong place, and it removes the last live-quiz dependency
from a snapshotted attempt's delivery. It also fixes a latent inconsistency
that predates retirement: today `question_order` can list a question the
`questions` payload does not contain (added mid-attempt), because the two come
from different sources.

**Recommend doing this first, as its own change, before retirement lands.**

## 5. `question_order` × delivered snapshots

Covered above. After the §4 change they become one source. Until then they are
two, and retirement makes their disagreement reachable.

`frozen_question_order` should shuffle over `deliverable_question_ids`. Note
its `len(ids) < 2 → None` guard: retiring down to one question makes a
randomized practice attempt store NULL, which then re-derives from live. Safe
only with the §4 change — another reason to do it first.

## 6. Practice mode / Try Again

Try Again creates a **new attempt**, so it correctly picks up the current
deliverable set and drops retired questions. No change needed.

The first attempt's history still shows what it received, from its snapshot.
Both halves already work.

⚠️ `practiceSummary.ts` computes its own denominator and is a known deviation
(design doc Finding B). Confirm it counts delivered questions, not live ones,
or retiring a question will move a practice percentage.

## 7. Require All Answers

**Already correct, no change needed.** 4A-bis changed submit to validate the
delivered set:

```python
for question in delivered_questions(attempt, access_code.quiz):
```

An existing attempt is held to the questions it received, including retired
ones. A new attempt is held only to what it got. This is the one surface
retirement needs nothing from.

## 8. Activation

`routes/access_codes.py` currently:

- refuses `if not quiz.questions`
- validates Draw Response images and Fill in the Blank regions over
  `enumerate(quiz.questions)`
- **numbers its error messages by that enumerate**

All three must move to the deliverable set. Otherwise a retired, broken
question blocks activation of a quiz that would never deliver it — and the
"Question 3 needs an image" numbering counts questions players won't see.

Refusal message becomes something like *"This Peira has no questions left to
send. Restore one, or add a new one."*

## 9. Quiz duplication

`_copy_questions_into` copies every authored question. **Recommend copying the
retirement flag** (`retired_at`, `retired_by_coach_id`).

Dropping retired questions loses content a coach may want back; silently
un-retiring them resurrects a question the coach deliberately stopped sending.
Copying the flag preserves intent, and the copy is fully editable so nothing
is trapped.

## 10. Exports / Results / History

**No change.** Every historical surface reads
`services/delivered_questions.py`, which reads snapshots. A retired question
that was delivered still appears in that player's results, CSV and PDF, with
its delivered numbering. That is correct and requires no retirement awareness
at all.

The coach's **live per-question breakdown** (`grading.py`) aggregates attempts
and numbers by `enumerate(sorted(quiz.questions))`. **Do not filter retired
questions out of it** — they still hold real answer data. Add a "retired"
marker instead, and leave the numbering alone so it stays stable.

## 11. Composition with Phase 3 exclusions

Orthogonal by construction: exclusion filters **answer rows at scoring time**;
retirement filters **question ids at delivery time**. They never touch the
same code path.

- Retiring must **not** auto-exclude. A question already answered still counts
  unless separately excluded — retiring it is a statement about the future.
- Excluding must **not** auto-retire, for the mirror reason.
- Both may be active on one question, and that combination is coherent:
  *"stop sending it, and don't count the ones already sent."*

The UX should acknowledge the pairing (§14) without wiring them together.

## 12. If every question is retired — **a real problem**

`delivered_questions()` decides legacy-vs-snapshot like this:

```python
rows = sorted(attempt.question_snapshots, ...)
if rows: return [...from snapshot...]
return [...from live quiz...]     # legacy fallback
```

**Zero snapshot rows is indistinguishable from a pre-Phase-1 attempt.** So an
attempt legitimately delivered zero questions would fall straight through to
the legacy path and render **the live quiz, retired questions included** — the
exact opposite of what was intended.

**Recommended fix: refuse to start an attempt with an empty deliverable set**
(422, same message family as activation). That keeps "zero rows = legacy"
true, which several other things quietly rely on. Blocking activation alone is
not enough — a code activated *before* the last question was retired is still
live.

## 13. Reversible?

**Yes.** Set both columns NULL. Retirement affects only future delivery, so
un-retiring is safe by definition — it cannot alter a past attempt or a score.

## 14. Coach UX and wording

Three neighbouring destructive-sounding actions now exist, and the copy has to
keep them apart. Proposed:

| Action | Label | Helper text |
|---|---|---|
| 4B | **Stop sending this question** | "Players who already got it keep it, and it still counts for them. New Peiras won't include it." |
| 3 | **Don't count this question** | "Players keep the question and their answer, but it won't affect their score." |
| — | **Delete** | unchanged; still blocked once answered |

Retired questions stay visible in the editor, visually de-emphasised, with a
**Start sending again** action. They must not be hidden — a hidden retired
question is one a coach cannot restore.

Avoid the word "retire" in the UI; it reads as jargon. Keep it in the code.

## 15. Do existing attempts keep showing retired questions?

**Yes, unconditionally.** That is the invariant. Guaranteed by snapshots for
Phase-1-onward attempts, and by not filtering `Quiz.questions` for legacy ones.

## 16. Legacy attempts

**No special problem, provided §4's rule holds.** A legacy attempt has no
snapshot and falls back to the live quiz — which still contains retired
questions, because retirement is not a global filter. So a legacy attempt
keeps showing what it most likely received.

This is the strongest argument for never filtering at the model layer: doing
so would silently rewrite every pre-Phase-1 attempt.

## 17. Security / authorization

Same envelope as Phase 3 exclusions. Retirement is a mutating quiz operation:
`get_editable_quiz` (owner or admin, org-scoped), tenancy validated from the
authenticated coach, never from a client-supplied quiz or org id. Record
`retired_by_coach_id` from the session, never the payload.

No new data reaches players; retirement only ever removes content from a
payload, so there is no new exposure surface.

## 18. Migration and rollback risk

**Low.** Additive nullable columns plus one partial index. No enum change (so
none of the `ALTER TYPE … ADD VALUE` transaction hazards), no data migration,
no backfill. Rollback is `DROP COLUMN`, which loses only retirement state.

Deploy ordering is benign: old code ignores the columns, new code reads NULL as
deliverable.

## 19. Required automated tests

**The invariant**
- Retiring a question does NOT remove it from an in-progress attempt
- …specifically for a **graded** attempt (`question_order IS NULL` — the
  dangerous case)
- …and for a **legacy** attempt with no snapshot
- A retired question's Q# does not shift in an existing attempt
- An existing attempt can still submit and be graded on a retired question

**Delivery**
- A new attempt does not receive a retired question
- Its snapshot has no row for it
- Randomized practice shuffles only deliverable questions
- Try Again picks up a retirement made since the previous attempt

**Composition**
- Retiring changes no existing score (measure before/after)
- Retire + exclude on one question behaves as both
- Retiring does not create an exclusion, and vice versa

**Edges**
- Retiring every question refuses at `/play/start` (§12)
- Activation refuses when nothing is deliverable
- Activation validation and numbering skip retired questions
- Un-retire restores delivery to new attempts only

**Unchanged surfaces (regression)**
- Results / CSV / PDF still show delivered retired questions
- `require_all_answers` still validates the delivered set
- Duplication carries the flag

**Authorization**
- Non-owner, cross-org and unauthenticated retire attempts are refused

## 20. Unexpected architecture problems

1. **`presented_question_ids` serves both delivery and read** (§4) — the main
   one. Fix by sourcing order from snapshots first.
2. **Graded attempts store `question_order = NULL`** (§4), so they re-derive
   from live on every read. This is the reason (1) is dangerous rather than
   merely untidy, and it is not obvious from reading either function alone.
3. **Zero snapshot rows means "legacy"** (§12) — an all-retired quiz would
   silently take the legacy path.
4. **Activation error numbering** (§8) would count invisible questions.
5. **`practiceSummary.ts`'s independent denominator** (§6) is the one frontend
   surface that could move a percentage.

---

## Recommended architecture

**Do it in two steps, and do not merge them.**

### Step 1 — make the order snapshot-sourced (prerequisite, no new feature)

Change `presented_question_ids` to read snapshot positions when they exist,
falling back to live reconciliation only for legacy attempts. Ship and verify
this **on its own**, with no retirement anywhere.

It is a pure consistency fix with an observable benefit today (order and
content stop being able to disagree), and it turns the retirement invariant
from something enforced by discipline into something enforced by structure. If
retirement ships first, every later change to that function is a chance to
reintroduce the bug.

### Step 2 — retirement

1. `retired_at` + `retired_by_coach_id` on `questions`, plus the partial index
2. `deliverable_question_ids(quiz)` in `services/attempts.py` — **the single
   place retirement is applied**
3. `frozen_question_order` and `capture_attempt_snapshots` use it
4. Activation validates, numbers, and refuses over it
5. `/play/start` refuses an empty deliverable set
6. `PATCH /api/quizzes/<id>/questions/<id>/retire` + `/restore`, or a field on
   the existing update route — authorization via `get_editable_quiz`
7. Duplication copies the flag
8. Editor UI: de-emphasised retired questions, "Stop sending" / "Start sending
   again", copy per §14
9. Coach breakdown marks retired questions rather than hiding them

**Explicitly out of scope:** unlocking correct-answer editing, unlocking region
editing, anything in Phase 4C, Competition, Draw Response.

---

# WHAT SHIPPED

Both steps are implemented. This section records what the implementation
actually did, including where it differed from the audit above.

## Step 1 — the delivered order (shipped `8063e31`)

Exactly as recommended. `presented_question_ids` reads snapshot positions;
`delivery_question_ids` is the live-quiz capture side. Splitting them also
removed a circularity the audit did not anticipate: capture cannot ask a
record it is in the middle of writing, so a single snapshot-aware function
would have had to special-case its own caller.

Two pre-existing tests asserted the old contract and were updated rather than
weakened — see the commit message.

## Step 2 — retirement (shipped in this commit)

Schema, chokepoint, activation, `/play/start` refusal, duplication, reversal
and UX all landed as designed. Notes on what the audit got right and what it
did not say:

**§12 was the most valuable finding and it held up.** The zero-question attempt
really would have fallen through to the legacy path and rendered retired
questions. `test_it_does_NOT_fall_through_to_the_legacy_path` pins it.

**Retirement is not guarded by `_reject_if_already_answered`.** The audit
implied this but did not state it. It deserves saying plainly: every other
guard on that route exists because the operation would corrupt an attempt that
already happened, and retirement cannot. The one moment it must work is the
moment every other edit is blocked.

**Duplication: OPTION A**, confirmed by the owner. The copy keeps the stopped
state, stays fully visible, and restores in one click.

## Things the audit did not anticipate

**Activation ordering.** The image/region checks run BEFORE the roster check,
so a quiz with no roster still reports its unanswerable questions first. This
is pre-existing behaviour and unchanged, but it is worth knowing when reading
an activation failure: the first error you see is not necessarily the only one.

**Query cost needed a different test than expected.** A scale-invariant
assertion over `/play/start` fails for a legitimate reason — a FRESH start
writes one snapshot row per question by design, so its query count is properly
O(n). The filter is measured directly instead: `deliverable_questions` issues
zero queries against an already-loaded relationship. A `/play/start` guard
would have been measuring the snapshot writes and calling it an N+1.

## Still not built, deliberately

- Phase 4C (broader editing unlocks) — not started.
- Correct-answer editing after delivery — still blocked.
- Region editing after delivery — still blocked. The region exception in
  `DESIGN-delivered-question-snapshots.md` is unchanged and still load-bearing.
- No bulk "stop sending" action. One question at a time is the only shape the
  product currently needs, and a bulk version would need its own confirmation
  design.
- Nothing surfaces retirement to players, by design — a stopped question is
  simply absent from new attempts, with no gap or placeholder.
