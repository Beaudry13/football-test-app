# Draw on Image - Phase 0 report

Architecture and mobile-interaction validation for the Draw on Image question
type. **No production behavior changed, no migration was run, and the spike
route does not exist in a production build.**

Branch: `feature/draw-on-image-phase-0`

---

## 1. What was built

| Area | File | Notes |
| --- | --- | --- |
| Gesture arbitration | `frontend/src/components/drawing/gestureArbiter.ts` | Pure. No React/DOM/Fabric. |
| Arbitration tests | `frontend/src/components/drawing/gestureArbiter.test.ts` | 40 tests |
| Document format | `frontend/src/components/drawing/types.ts` | Versioned envelope |
| Document operations | `frontend/src/components/drawing/drawingDocument.ts` | Pure |
| Document tests | `frontend/src/components/drawing/drawingDocument.test.ts` | 26 tests |
| Render scale / memory | `frontend/src/components/drawing/renderScale.ts` | Pure |
| Render-scale tests | `frontend/src/components/drawing/renderScale.test.ts` | 17 tests |
| Scroll lock | `frontend/src/components/drawing/useScrollLock.ts` | + 9 tests |
| Fabric engine | `frontend/src/components/drawing/drawingEngine.ts` | The only Fabric-aware file |
| Board overlay | `frontend/src/components/drawing/DrawingBoard.tsx` | Portal, dark theme |
| Spike page | `frontend/src/pages/spike/DrawingSpikePage.tsx` | Dev-only |
| HUD | `frontend/src/pages/spike/DrawingHud.tsx` | Dev-only, outside the engine |
| Spike image | `frontend/src/pages/spike/spikeImage.ts` | Inline SVG, no binary asset |

Shared `Icon` registry gained `pen`/`pan`/`eraser`/`undo`/`redo`/`fitView`
rather than the board importing `lucide-react` directly.

**92 new tests. Full suite: 51 files, 458 tests, all passing.** Typecheck and
lint clean. (Six pre-existing jsdom canvas errors in `AnnotationCanvas.test.tsx`
are unrelated - verified identical on a clean tree.)

---

## 2. Fabric

**Installed version: 7.4.0.** Every API the prior architecture assumed still
exists, verified against `node_modules/fabric/dist/src/**/*.d.ts` rather than
from memory:

```
PencilBrush#onMouseDown(pointer: Point, { e }: TEvent): void
PencilBrush#onMouseMove(pointer: Point, { e }: TEvent): void
PencilBrush#onMouseUp({ e }: TEvent): boolean
Canvas#getScenePoint(e), Canvas#getViewportPoint(e)
Canvas#zoomToPoint(point, value), #relativePan, #absolutePan, #setViewportTransform
```

`canvas.getPointer()` still exists but is **deprecated** in 7.x in favour of
`getScenePoint`/`getViewportPoint`. Not used.

**Manually driven brush: confirmed working in a real browser.** A stroke
driven through `onMouseDown/onMouseMove/onMouseUp` produces a genuine Fabric
`Path` object on the canvas, which the engine then tags with a stroke id.
`canvas.isDrawingMode` is deliberately never set - Fabric's built-in free
drawing binds the brush straight to pointer events, which is precisely the
behavior the grace window exists to prevent.

---

## 3. Gesture architecture

The arbiter is a state machine over `idle → pending → drawing | pinch | pan |
erasing → blocked`. It consumes normalized pointer samples and returns
**commands** the host applies. It never touches a canvas, so it is exhaustively
testable.

**Deferred stroke commitment.** The first finger's samples are buffered, not
drawn. If a second pointer arrives inside the grace window (default **60ms**),
the buffer is discarded and no mark is ever created. If the window expires, the
buffer is **replayed** into the brush starting at the true first touch point.

Replay, not skip. Dropping the buffered points would start every stroke a few
millimeters late - a subtler bug than the stray dash, and one that would
survive a field test unnoticed because it feels like "the pen doesn't track".

Two decisions worth flagging for your review:

- **A stroke that commits and is *then* interrupted by a second finger is kept,
  not discarded** - the player genuinely drew it. But if it was brief enough to
  plausibly be a slow pinch, it is counted as a *suspected stray* so the gate
  can tell you the grace window needs widening on that device.
- **`pointercancel` on a committed stroke abandons it** rather than finalizing.
  A cancelled gesture is one the browser decided was not a stroke, and
  committing those is how strays get in through the back door. The tradeoff is
  that a genuine long stroke interrupted by a system gesture is lost.

### Two bugs the spike caught

1. **Pinch wobble.** Two fingers never move in the same pointer event, so
   recomputing scale after each one turned a pure two-finger *pan* into
   zoom-out-then-zoom-back-in. Net factor 1, but a visible one-frame wobble.
   Fixed by coalescing pinch to one transform per animation frame.
2. **Canvas sized from the image instead of the viewport.** `resetView()` fit
   the image to `canvas.getWidth()`, which is the *backing store* width. With
   the backing store sized from the coordinate space, the fit collapsed to
   exactly the render scale and the image was stretched to the overlay's aspect
   ratio. Fixed by treating the canvas as a **window onto the scene**: backing
   store = viewport CSS size x render scale.

---

## 4. Coordinate space and source-image pinning

Strokes are stored in a **logical coordinate space fixed at creation**
(`coordinate_width`/`coordinate_height`), capped at 1400px wide - deliberately
the same cap as the annotation editor's `MAX_CANVAS_WIDTH`, so a coach diagram
and a player drawing over the same photo share one space.

Render scale varies per device; the coordinate space never does. **Verified in
browser:** a stroke drawn at 0.69x zoom kept byte-identical coordinates after
zooming to 1.84x, returning, and resizing the viewport from 961x953 to 375x603.

`DrawingSourceImage` pins `image_id`, `image_version`, and natural dimensions.
`checkSource()` returns `different-image`, `different-version`, or
`different-dimensions`. The interesting case is a coach re-uploading over the
same image record: the strokes stay geometrically valid but were drawn over
different pixels, and a viewer must say so rather than silently render them.

---

## 5. Memory and render scale

Canvas memory is the most likely way this crashes a phone, and iOS kills the
tab without a catchable error - taking the player's in-progress answer with it.

- Fabric allocates **two** full-size canvases (lower + upper). Confirmed in
  browser. Every estimate doubles.
- Budget: **4.2M backing pixels per layer** (~33MB across both).
- Render scale caps at **1.5x**, floors at 0.75x - except the memory budget is
  allowed to override the floor, because a soft image is survivable and a
  killed tab is not.

Measured in-browser:

| Viewport | DPR | Render scale | Backing store | Canvas memory |
| --- | --- | --- | --- | --- |
| 961 x 953 | 1 | 1.00x | 961 x 953 | 7.0 MB |
| 375 x 603 | 2 | 1.50x | 563 x 905 | 3.9 MB |

The 1.5x-at-DPR-2 result matches the prior spike's finding independently.

---

## 6. DrawingDocument format

```jsonc
{
  "format": "peira.drawing",
  "version": 1,
  "source": { "image_id", "image_version", "natural_width", "natural_height" },
  "coordinate_width": 1400,
  "coordinate_height": 875,
  "strokes": [{
    "id", "tool": "pen", "layer": "player",
    "points": [x0, y0, x1, y1, ...],   // flat, ~half the JSON of {x,y} objects
    "color", "width", "opacity?", "order", "created_at?"
  }],
  "created_at", "updated_at", "revision?", "preview?"
}
```

`layer` (`player` | `coach`) exists now, though Phase 0 only ever writes
`player`. The coach's eventual Image Only / Coach Version / Player Submission
toggle then becomes a filter over one document instead of three incompatible
payloads - retrofitting that later would need a data migration.

Long-term storage keeps three artifacts: **source image reference**,
**structured strokes (source of truth)**, **flattened preview (derived)**.

---

## 7. Engine modularity

`components/drawing/` imports nothing from quizzes, grading, or persistence. It
takes an image URL, a document, config and callbacks; it emits an updated
document, a preview blob, and telemetry. A future scouting report or install
packet supplies its own adapter without touching the engine.

Per your instruction, **no generic polymorphic `drawings` table** is proposed.
Each owning domain gets a real foreign key.

---

## 8. Answer-presence integration inventory

The prior architecture identified at least six checks. **There are 16.** Every
one silently treats a drawing as "no answer" today. None were modified.

### Frontend

| # | Location | Behavior today |
| --- | --- | --- |
| 1 | `play/QuizStep.tsx:49` `isAnswered()` | `selected_option_id \|\| answer_text.trim()` - a drawing is neither |
| 2 | `play/QuizStep.tsx:99` autosave branch | Option = immediate, text = debounced. No drawing path |
| 3 | `play/QuestionInput.tsx:72` render switch | `written ? textarea : options` - a drawing question renders as empty multiple choice |
| 4 | `quiz-editor/ResponseRow.tsx:30` | `needsManualGrading = question_type === 'written'` - coach cannot grade a drawing |
| 5 | `quiz-editor/ResponseRow.tsx:106` | Needs-grading count excludes drawings |
| 6 | `quiz-editor/QuestionEditor.tsx:110` | Type `<select>` has no draw-on-image option |

### Backend

| # | Location | Behavior today |
| --- | --- | --- |
| 7 | `routes/play.py:56` `_resolve_answer_text` | Non-written falls to option lookup; returns `None` |
| 8 | **`routes/play.py:245` submit validation** | **A drawing-only submission is rejected as incomplete. Blocking.** |
| 9 | `services/attempts.py:81` `upsert_answer` | `is_correct` stays `None` - correct for drawings, but by accident |
| 10 | `routes/grading.py:350` | Awaiting-grading count filters `question_type == "written"` |
| 11 | `routes/players.py:151` | Same filter on the player profile |
| 12 | `services/export.py:578` `_answer_text` | Returns `""` → PDF prints "No answer submitted." |
| 13 | `services/export.py:586` `_grading_result` | Answer present, `is_correct` None → "Not Graded" (acceptable) |
| 14 | `services/export.py:680` CSV row | Blank answer cell |
| 15 | `models/response.py` `Answer` | No drawing column |
| 16 | `schemas/play.py:12,39` | No drawing field in the save/submit schemas |

Recommendation: introduce **one** shared predicate on each side
(`hasDrawnAnswer()` already exists in `drawingDocument.ts`) rather than adding a
third clause in 16 places. Sixteen independent copies of "what counts as an
answer" is how one of them gets missed and a player's work reads as blank.

---

## 9. PostgreSQL enum migration plan

`question_type` **is** a native Postgres enum (`questiontype`), created in
`migrations/versions/c614749e6a09_initial_schema.py:67`. Critically, it stores
**member names, not values**: `'TRUE_FALSE', 'MULTIPLE_CHOICE', 'WRITTEN'`. The
new value must therefore be `DRAW_ON_IMAGE`, not `draw_on_image`.

**Not run in Phase 0.** For the Phase 1 migration:

```python
def upgrade():
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
    # PostgreSQL < 12, and Alembic wraps migrations in one by default.
    # IF NOT EXISTS makes the statement idempotent across retries.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE questiontype ADD VALUE IF NOT EXISTS 'DRAW_ON_IMAGE'")

def downgrade():
    # Intentionally not reversible. Postgres cannot drop a value from an enum;
    # undoing it means recreating the type, rewriting every dependent column,
    # and destroying any row already using it. If a rollback is ever genuinely
    # required, do it as a deliberate, separately reviewed data migration.
    pass
```

Two operational notes: Render runs `flask db upgrade` as a `preDeployCommand`
(`render.yaml:22`), so the enum value lands **before** the new code that uses
it - the correct order. And a value added in an autocommit block is committed
even if a later step of the same migration fails, so keep that migration to
this one statement.

---

## 10. Autosave and resume design (recommended, not built)

The spike autosaves to `localStorage` so the gate can run with the backend
down. For production:

- **Save the whole document, debounced ~800ms after the last stroke**, plus
  immediately on Done and on overlay close. Never per pointer move.
- **Idempotent `PUT`** keyed by `(attempt, question)`, mirroring the existing
  `upsert_answer` `INSERT ... ON CONFLICT DO UPDATE` (`attempts.py:91`).
- **Revision counter.** Client sends the last confirmed `revision`; server
  rejects a stale write with `409` rather than silently overwriting a newer
  drawing from another device. This matters more than for text: two devices
  merging text is annoying, losing a drawing is unrecoverable.
- **Submit-time sync.** `QuizStep`'s existing submit already re-sends every
  answer as a safety net (`QuizStep.tsx:72-78`); the drawing must join that
  path, not rely on autosave having succeeded.
- **Payload.** `estimatePayloadBytes()` is in place. A dense 40-stroke drawing
  is ~50KB of JSON. Recommend a server cap around 512KB and gzip; if a
  document exceeds it, the honest move is to refuse and tell the player, not
  truncate their answer.
- **Offline.** Keep the last good document in `localStorage` regardless, so a
  dropped connection mid-answer is recoverable on reload.

---

## 11. Preview and PDF strategy

**No server-side Fabric.** There is no Python Fabric renderer, and a Node
sidecar purely for PDF export would complicate the Render deployment for one
feature.

The client generates a flattened PNG (`DrawingEngine.exportPreview()`, already
implemented) and uploads it alongside the vector document. The backend stores
source reference + vector document + preview reference, and the existing PDF
export embeds the preview through the same image machinery it already uses for
question images. **The preview never replaces the vector source of truth.**

---

## 12. Dev-only spike behavior and exclusion proof

Route `/spike/drawing`, guarded in `App.tsx`:

```tsx
const DrawingSpikePage = import.meta.env.DEV
  ? lazy(() => import('./pages/spike/DrawingSpikePage'))
  : null;
```

Vite statically replaces `import.meta.env.DEV` with `false` in a production
build, so Rollup drops the branch and the dynamic import with it. Nothing links
to the route.

**Proof** (`npm run build`, then grep `dist/`):

```
chunks emitted: index-*.js, index-*.css, peira-mark-*.png   (no spike chunk)

spike/drawing    -> 0 matches
peira.drawing    -> 0
coordinate_width -> 0
00e5ff / 00E5FF  -> 0
strokeBegin      -> 0
SPIKE STILL      -> 0
```

---

## 13. Browser verification results

Run against the dev server at 961x953 and 375x603.

| # | Check | Result |
| --- | --- | --- |
| 1 | Manually driven brush creates a real Fabric path | Pass - stroke persisted with 22 points |
| 2 | Zoom lives in `viewportTransform` | Pass - 0.69x → 1.84x via pinch |
| 3 | Stroke stays under the pointer | Pass - **0.0000px error** at 0.69x, 1.84x, and at render scale 1.5 |
| 4 | Pan tool | Pass (unit-tested; single-finger path) |
| 5 | Pinch creates no stroke | Pass - 0 strokes added across a full pinch |
| 6 | Scroll lock restores position | Pass - `position/top/overflow/overscroll` all restored |
| 7 | Whole-stroke erase is undoable | Pass - erase 4→3, undo →4, redo →3 |
| 8 | Clear is undoable | Pass - clear →0, undo →3 |
| 9 | Resize recomputes render without moving coordinates | Pass - coordinates byte-identical |
| 10 | Memory estimate updates | Pass - 7.0MB → 3.9MB |
| 11 | Spike absent from production bundle | Pass - see §12 |

Two caveats, stated plainly:

- **The browser pane does not composite frames**, so `requestAnimationFrame` is
  parked. Pinch and FPS were exercised by shimming `rAF` onto a timer. **The
  FPS number has not been measured on real hardware** - that is the gate's job.
- **No visual screenshot was captured** for the same reason. Geometry was
  verified numerically instead, which is stronger for correctness but says
  nothing about how it *looks*. Judge the visual design on your phone.

---

## 14. Real-device gate instructions

**1. Start the dev server with LAN access.** Vite binds to localhost only by
default:

```bash
npm --prefix frontend run dev -- --host
```

**2. Find your machine's IPv4 address:**

```bash
ipconfig
```

Use the `IPv4 Address` under your active Wi-Fi adapter (typically
`192.168.x.x`). Ignore any `169.254.x.x` address - that means no DHCP lease.

**3. Windows Firewall.** The first `--host` run usually raises a "Windows
Defender Firewall has blocked some features of Node.js" dialog. Tick **Private
networks** and allow. If you dismissed it earlier, the phone will hang on
connect; re-allow with:

```bash
netsh advfirewall firewall add rule name="Vite dev 5173" dir=in action=allow protocol=TCP localport=5173
```

**4. Phone on the same Wi-Fi** (not cellular, not a guest VLAN - guest networks
usually block client-to-client traffic), then open:

```
http://<YOUR-IPV4>:5173/spike/drawing
```

### Gestures to run

Open/close the board (after scrolling down the page first) · slow one-finger
draw · fast one-finger draw · start a stroke then immediately add a second
finger · repeated pinch in/out · two-finger pan while zoomed · Pan tool with one
finger · switch back to Pen · draw at 2x+ zoom · whole-stroke erase · undo/redo
· clear · rotate the phone · background the browser and return · close/reopen
the board · draw continuously for two minutes · create many strokes · reload to
confirm resume.

The HUD has a **grace slider (0-140ms)** - if you see strays at 60ms, raise it
and find where they stop. That number is the main thing Phase 0 cannot settle
from a desk.

### Gate metrics

| Metric | Required |
| --- | --- |
| Stray marks (tap "I saw a stray") | **0** |
| Normal drawing FPS | **> 40** |
| Zoom drift | none visible |
| Background page scrolling | none |
| Tab crash / reload / freeze | none |
| Canvas memory | within a safe range for the device |

### Record per device

Device model · OS version · browser · FPS · strays seen · strays suspected ·
prevented count · canvas memory · render scale · backing store · zoom drift ·
gesture confusion · any tab refresh or crash.

Minimum: one real iPhone, one real Android, preferably one older/lower-memory
device.

---

## 15. Remaining risks

1. **The 60ms grace window is a desk estimate.** It is the one number that
   cannot be validated without hands on glass. Everything else is testable; this
   is why the gate exists.
2. **FPS is unmeasured on real hardware.** jsdom and a non-compositing pane
   cannot tell you anything about a thermally throttled phone after two minutes
   of drawing.
3. **`pointercancel` discards a committed stroke.** Correct for stray
   prevention, but a player who gets a call banner mid-stroke loses that stroke.
   Watch for this during the gate; if it fires often on real devices, revisit.
4. **Eraser hit-testing uses bounding boxes**, not true path proximity. Two
   crossing strokes have overlapping boxes, so the topmost wins even if the
   other is visually nearer the finger. Acceptable for V1; note it if it annoys
   you in practice.
5. **Preview upload doubles the write path** (vector + PNG). Needs a real
   failure story when the PNG upload fails but the vector succeeds - the vector
   must win.
6. **16 answer-presence touchpoints** is a large surface. The single-predicate
   recommendation in §8 is what keeps Phase 2 from becoming a bug hunt.

---

## 16. Proposed production sequence

Unchanged in shape from your outline; adjusted for what the audit found.

- **Phase 0 (this)** - engine, gestures, real-device gate. *Awaiting your HUD results.*
- **Phase 1** - Alembic enum migration (§9), `draw_on_image` question type,
  creation UI, source-image pinning. Image becomes required for this type.
- **Phase 2** - Player drawing board wired into `QuestionInput`, local
  save/restore, and the **single answer-presence predicate** replacing
  touchpoints 1-3.
- **Phase 3** - Backend persistence, revision-checked idempotent save, autosave,
  submit-time sync (touchpoints 7-9, 15-16).
- **Phase 4** - Coach Results viewer, manual grading, layer toggles
  (touchpoints 4-5, 10-11).
- **Phase 5** - Analytics/history, completion counts, canonical-player behavior.
- **Phase 6** - Flattened previews, PDF and CSV (touchpoints 12-14), load
  testing.

Confidence rating ("How confident are you in this answer?" - Very / Somewhat /
Guessing) is **deliberately not built**. When it comes, it belongs on the
Answer/attempt model, not the drawing document, must never affect score, and its
value is the confidence x correctness cross-tab.

---

## 17. Recommendation

**READY FOR REAL-DEVICE GATE.**

The architecture holds, the two bugs the spike surfaced are fixed, pointer
tracking is numerically exact at every zoom and render scale tested, and the
spike is provably absent from production. What remains genuinely cannot be
learned without a phone in your hand: the grace window and sustained FPS.

Bring back the HUD numbers and I will take Phase 1 from there.
