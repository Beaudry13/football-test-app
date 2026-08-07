# Draw Response as a question type + Phase 3 persistence

Design for review. **No code written yet.**

Two changes, deliberately sequenced: first the model change (Draw Response
becomes a question type), then Phase 3 (drawings reach the server and the
coach). The second is far easier to get right once the first has settled,
because "is this question answered" stops being a property bolted onto every
type and becomes a property of one type.

---

## 1. The reversal, stated once

Phase 1 shipped drawing as `questions.allow_drawing`, a boolean, and I argued
for it over an enum member. Two of those arguments still hold and one does not.

| Argument then | Status now |
| --- | --- |
| Postgres cannot remove an enum value, so it is a one-way door | **Still true.** Accepted cost, see §7 |
| `ALTER TYPE … ADD VALUE` cannot run in the transaction that added it | **Still true.** Handled by splitting the migration |
| A boolean composes; a type cannot express "MC *and* a drawing" | **Wrong axis.** Goal 3 wants the opposite composition |

The third is the one that matters. I read composability as "any question may
additionally carry a drawing". The actual requirement is the reverse: a Draw
Response question may additionally require an explanation or a choice. That
is a property *of the Draw Response type*, not of every type — and it is
cleanly expressible with the type as the primary key of the model.

So the type wins. The remaining cost is the one-way door, which is real but
bounded: one inert enum label if the feature were ever withdrawn.

---

## 2. Question types

```
TRUE_FALSE        True / False
MULTIPLE_CHOICE   Multiple Choice
WRITTEN           Short Answer        <- label change only
DRAW_RESPONSE     Draw Response       <- new
```

**`WRITTEN` keeps its enum name.** Renaming the stored value would be a second
one-way door plus a data migration across every existing answer, to change a
word the coach sees. The UI label becomes "Short Answer"; the database keeps
`WRITTEN`.

### Draw Response behaviour

| | |
| --- | --- |
| Image | **Required** — enforced at activation, not creation (§3) |
| Drawing | Always on. No toggle |
| Answer choices | Not shown, not stored |
| Short-answer box | Not shown, not stored |
| `allow_drawing` column | **Dropped** — the type is the single source of truth |

Dropping `allow_drawing` rather than deriving it keeps one fact in one place.
Two sources for "can this be drawn on" is how they drift.

---

## 3. The image requirement, and why it is enforced late

A coach cannot upload an image to a question that does not exist yet — the
upload route targets an existing question id. So "Draw Response requires an
image" cannot be enforced at creation without making the type impossible to
create. Phase 1 hit this and returned a 422, which is why the toggle only
appeared *after* an image existed.

**Proposal: a Draw Response question may exist without an image, but a quiz
containing one cannot be activated.**

- The question card shows a clear "Needs an image" state
- `POST /quizzes/{id}/access-codes` returns 422 listing the offending questions
- Players therefore can never meet a Draw Response question with nothing to
  draw on

This moves the check to the moment it actually protects someone — a roster of
players receiving the quiz — instead of blocking the coach mid-authoring.

---

## 4. Designing for the future combinations (not built)

Goal 3 asks that Draw Response can later *also* require a written explanation,
a multiple-choice answer, or both. The important design work is making sure
nothing now forbids it.

**The answer side already supports it.** `answers.answer_text` and
`answers.selected_option_id` are both nullable and independent. A Draw
Response answer can carry either later with no schema change.

**The question side needs two flags, added when the feature is built:**

```sql
-- NOT part of this phase
ALTER TABLE questions ADD COLUMN requires_explanation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE questions ADD COLUMN requires_choice      BOOLEAN NOT NULL DEFAULT FALSE;
```

**The constraint this places on Phase 3:** no code may assume a Draw Response
answer has no text and no option. Specifically, answer-presence logic must ask
"does this question's type require a drawing, and is there one" rather than
"is this a drawing question, therefore ignore text". Written as a single
predicate per side (§6) so the assumption cannot leak into six places.

---

## 5. `answer_drawings`, reshaped

The table exists but **has never held a row**, in any environment. Reshaping it
now costs nothing and avoids carrying a shape that was designed before the
document format was.

Current columns duplicate what the `DrawingDocument` envelope already carries
(`canvas_width`/`canvas_height` vs `coordinate_width`/`coordinate_height`,
`source_image_url` vs `source.image_id` + `image_version`). Two copies of the
same fact drift.

```sql
answer_drawings
  id           SERIAL PRIMARY KEY
  answer_id    INTEGER NOT NULL UNIQUE REFERENCES answers(id) ON DELETE CASCADE
  document     JSONB   NOT NULL   -- the whole versioned DrawingDocument
  revision     INTEGER NOT NULL DEFAULT 1
  preview_url  VARCHAR(1024)      -- Phase 6; stays NULL
  created_at   TIMESTAMPTZ
  updated_at   TIMESTAMPTZ
```

- **`document` JSONB, not JSON** — queryable, and the format is already
  versioned (`format`, `version`) so a reader can refuse what it cannot parse.
- **`revision`** — bumped server-side on every write; the client sends the
  revision it last saw. This is what stops a phone that went through a tunnel
  overwriting a newer drawing made on another device.
- **`preview_url` stays** — it points at external storage, so it is genuinely a
  column and not a duplicate of anything inside the document.
- The FK, `ON DELETE CASCADE` and the one-drawing-per-answer uniqueness are
  kept exactly as they are.

---

## 6. Answer presence: one predicate per side

The Phase 0 audit found 16 places that decide whether a question is answered.
Phase 3 must not add a 17th ad-hoc check.

**Backend** — `services/attempts.py`:

```python
def is_answered(question, answer, drawing) -> bool:
    if question.question_type is QuestionType.DRAW_RESPONSE:
        return drawing is not None and has_strokes(drawing)
    if question.question_type is QuestionType.WRITTEN:
        return bool((answer.answer_text or "").strip())
    return answer.selected_option_id is not None
```

**Frontend** — the existing `hasDrawnAnswer` plus the type check, in `QuizStep`
only.

`require_all_answers` on the server calls the backend predicate instead of its
current inline `selected_option_id is not None or answer_text.strip()`. That
single change is what lets a drawing satisfy the requirement, and it also
deletes the client-side guard Phase 2 added to stop players hitting an
unfixable rejection.

---

## 7. Migration plan

Three migrations, split because Postgres forces it.

**Migration A — add the enum value.** Alone in its own revision, in an
autocommit block. A value added this way cannot be *used* in the same
transaction, which is precisely why B is separate.

```python
with op.get_context().autocommit_block():
    op.execute("ALTER TYPE questiontype ADD VALUE IF NOT EXISTS 'DRAW_RESPONSE'")
```

**Migration B — convert and drop.**

```sql
UPDATE questions SET question_type = 'DRAW_RESPONSE' WHERE allow_drawing = TRUE;
ALTER TABLE questions DROP COLUMN allow_drawing;
```

A converted question keeps any option rows it had. They become inert until the
future `requires_choice` work, and destroying a coach's authored options to
tidy a column would be the wrong trade.

**Migration C — reshape `answer_drawings`.** Drop and recreate; the table is
empty everywhere, so there is nothing to preserve and no backfill to get wrong.

**Downgrade:** B and C reverse cleanly. A does not — `DRAW_RESPONSE` cannot be
removed from the enum. Its `downgrade()` will say so rather than pretend.
Rehearse on a scratch database first, per `CLAUDE.md`.

---

## 8. Autosave and submit

Keep the local draft. It is the only thing that survives a dead network, and
Phase 3 makes the server authoritative *without* removing that safety net.

**`PUT /api/play/drawing`**

```jsonc
{ "access_code_id": 1, "player_name": "…", "player_id": 12,
  "question_id": 5, "document": { … }, "base_revision": 3 }
```

- Re-derives the attempt from `(access_code_id, player_name/player_id)` and
  never trusts a client attempt id — the existing rule for every mutating
  `/play` route
- Upserts the `answers` row, then upserts `answer_drawings`, in one transaction
- `409` when `base_revision` is behind the stored revision; the client keeps
  its local draft and surfaces the conflict rather than silently losing work
- Rejects a `document` whose `format`/`version` it does not understand

**Client:** debounce ~800ms after the last stroke, mirroring the existing text
autosave; save immediately on Done and on overlay close; write the local draft
first so a failed request never loses the strokes.

**Submit:** `submitQuiz` gains an optional `drawing` per answer, re-sent as the
same safety net the text answers already get. Server-side, submit writes any
drawing it receives before evaluating `require_all_answers`.

---

## 9. Coach Results (view only)

Phase 3 shows the drawing; it does not grade it.

Render read-only **from the stored document**, reusing the drawing engine in a
view mode — no flattened preview, no R2 upload, no server-side rendering. That
keeps Phase 3 free of storage work and leaves `preview_url` for Phase 6, when
the PDF actually needs a raster.

The coach sees the source image with the player's strokes over it. The three
view modes from §12 of the original design (Image Only / Coach Version /
Player Submission) are a Phase 4 concern; the document's `layer` field already
distinguishes them.

---

## 10. Touchpoints this changes

Every place that branches on question type, audited:

| Location | Change |
| --- | --- |
| `models/question.py` | Add `DRAW_RESPONSE`; drop `allow_drawing` |
| `schemas/question.py` | `validate_options_for_type` → Draw Response takes no options; drop the drawing/image validator |
| `routes/questions.py` | Drop the toggle handling |
| `routes/access_codes.py` | **New:** refuse activation if a Draw Response question has no image |
| `routes/play.py` | `_resolve_answer_text`; submit's `require_all_answers` → shared predicate |
| `services/attempts.py` | **New:** shared `is_answered`; drawing upsert |
| `api/types.ts`, `questions.ts` | `QuestionType` gains `draw_response`; drop `allow_drawing` |
| `QuestionEditor.tsx` | Fourth option; hide choices/short-answer UI for it |
| `QuestionsTab.tsx` | Label; **remove the checkbox**; "Needs an image" state |
| `QuestionInput.tsx` | Draw Response renders the board only |
| `QuizStep.tsx` | Predicate; drawing joins autosave and submit; **delete** the Phase 2 client-side guard |
| `ResultsTab` / `ResponseRow` | Render a submitted drawing |

**Deliberately not touched in Phase 3:** grading (`routes/grading.py:350`,
`routes/players.py:151`), `services/export.py` (PDF + CSV), analytics. A
submitted drawing will therefore **not** appear in "awaiting grading" counts
until Phase 4 — a known, listed gap rather than a surprise.

---

## 11. Decisions I need from you

1. **"Short Answer" is a label change only** — the database keeps `WRITTEN`.
   Confirm you do not want the stored value renamed.
2. **Existing questions with the toggle on become Draw Response**, keeping any
   option rows. Alternative: clear the flag and leave them as they are, so the
   coach re-picks the type deliberately.
3. **Image enforced at activation, not creation** (§3). This is the main UX
   call — it lets a coach create the question first and add the image after,
   which is the order the editor already works in.
4. **Coach Results renders from strokes, no preview image** (§9). Cheaper and
   keeps R2 out of this phase; the tradeoff is the coach's browser does the
   rendering.

Once these are settled I will implement in the order: migrations → backend
model/routes → coach authoring UI → player flow → Results.
