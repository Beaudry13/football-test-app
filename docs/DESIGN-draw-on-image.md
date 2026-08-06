# Draw on Image — technical design

**Status: proposal. Nothing here is built.** This document exists to be
argued with before any code is written.

A new question type alongside Multiple Choice, True/False and Written
Response. The coach asks "draw your run fit"; the player draws it on the
film still, on their phone, and the coach grades it by hand.

---

## 0. Headline recommendation

**Build it on the drawing stack this repo already has, not a new one.**

The three genuinely hard problems in this feature — vector stroke capture,
pinch-zoom-and-pan by pointer events, and rendering saved strokes back over
an image at the right coordinates — are all already solved and tested in
this codebase for the *coach* annotation tool. The new work is mostly
(a) a mobile-first gesture layer that can tell drawing from zooming,
(b) one new table, and (c) wiring a new question type through about a dozen
existing integration points.

The single biggest risk is not the drawing. It is iOS Safari. Budget real
device time, and do the spikes in Phase 0 before committing to the rest.

The second biggest risk is quiet: a new question type has to be taught to
every place that currently asks "did this player answer?" — analytics,
required-answers enforcement, CSV, the PDF, the dashboard counts. Miss one
and drawings silently count as unanswered. That's tracked as its own phase,
not as cleanup.

---

## 1. What already exists (the leverage inventory)

This is the most important section. Read it before evaluating anything else.

| Capability | Where it lives today | Reuse |
|---|---|---|
| Free-hand stroke capture | `AnnotationCanvas.tsx` — Fabric `PencilBrush`, `canvas.isDrawingMode` | Direct, with a new gesture layer |
| Pinch/zoom/pan by Pointer Events | `PinchZoomPan.tsx` + `pinchZoomMath.ts` (`zoomAroundPoint`, `clampScale`, `reanchor`) | **Math module yes, component no** — see §5.3 |
| Undo / redo | `useAnnotationHistory.ts` — snapshot stack, `MAX_HISTORY = 50` | Direct |
| Rendering saved strokes over an image | `AnnotationViewer.tsx` — Fabric `StaticCanvas`, `loadFromJSON({objects})` | Direct, with a second layer |
| Coordinate-space pinning | `canvasSizing.ts` — `resolveCanvasWidth`, `resolveTrueCapWidth`, `PLAYER_RENDER_SCALE` | Direct, and its *lesson* is central — see §3.1 |
| Stroke JSON storage format | `question_images.annotations` (JSON array of Fabric objects) + `canvas_width` | Same format for player drawings |
| Race-safe answer autosave | `services/attempts.py::upsert_answer` — `INSERT … ON CONFLICT DO UPDATE` | Extend, don't replace |
| Debounced autosave + flush-on-submit + "Saved" status | `QuizStep.tsx` | Extend |
| Resume after refresh | `GET /play/resume` returns every saved answer | Extend |
| Image upload, compression, sanitisation, R2/S3 | `services/file_storage.py` — `save_image` / `load_image_bytes` / `delete_image`, Pillow re-encode | Direct |
| Embedding an image into the PDF | `export.py::_load_image_flowable` | Direct |
| Manual grading (Correct / Incorrect / Not Graded + feedback) | `grading.py::grade_answer`, `ResponseRow.tsx`, `GradeAuditLog` | **Zero change needed** |

Fabric is already a dependency (`fabric ^7.4.0`) and already in the shipped
bundle. **Version 1 needs no new frontend dependency.**

---

## 2. The ten questions, answered

### Q1 — How should drawings be stored?

Three artifacts, exactly as you proposed, with one addition:

1. **Original image** — already stored (`question_images.image_url`). Not
   duplicated per answer.
2. **Stroke vector data** — JSONB, in a new `answer_drawings` table, in the
   *same Fabric object-array format* `question_images.annotations` already
   uses. This is the source of truth.
3. **Flattened preview** — a composited JPEG in R2 via the existing
   `file_storage`, for thumbnails, list views and the PDF.
4. **(Addition) The coordinate space and the source image the strokes were
   authored against** — without these, 2 and 3 are unrenderable later. See
   §3.1; this is the part that most often gets missed and cannot be
   retrofitted.

The preview is a **cache, not the record**. Where preview and strokes
disagree, strokes win, and the coach's on-screen view always renders from
strokes.

### Q2 — How should fullscreen drawing work on iPhone and Android?

**Do not use the Fullscreen API.** iOS Safari does not support
`requestFullscreen()` on arbitrary elements (only `<video>`), so it will
work on Android and silently fail on the majority of your users' phones.

Use a **CSS overlay portaled to `document.body`** — the pattern
`components/ui/Modal.tsx` already establishes:

```
position: fixed; inset: 0; z-index: <above everything>;
height: 100dvh;   /* with a 100vh fallback line above it */
```

`PlayPage.module.css` already uses the `100vh` → `100dvh` double-declaration
trick for exactly the iOS address-bar problem; reuse it verbatim.

Portaling matters for a second reason: the overlay escapes any ancestor
`overflow`, `transform` or stacking context on the quiz page, which is what
makes "the normal quiz page disappears" reliable rather than fragile.

### Q3 — How do we prevent accidental scrolling?

Four layers, all needed; any one alone leaks on some device:

1. **`touch-action: none`** on the drawing surface. Stops the browser
   claiming the gesture for scroll/zoom before your handlers see it.
   `PinchZoomPan.module.css` already sets this.
2. **`overscroll-behavior: contain`** on the overlay. Stops scroll chaining
   and pull-to-refresh.
3. **iOS-safe body scroll lock** while the board is open. `overflow: hidden`
   alone does *not* stop iOS rubber-banding:
   ```
   const y = window.scrollY;
   body.style.position = 'fixed';
   body.style.top = `-${y}px`;
   body.style.width = '100%';
   // on close: restore, then window.scrollTo(0, y)
   ```
   Restoring `scrollY` is not optional — without it the player lands back at
   the top of a long quiz and loses their place.
4. **`preventDefault()` on Safari's non-standard `gesturestart` /
   `gesturechange`**, which fire for pinch on iOS independently of Pointer
   Events and will zoom the whole page if unhandled.

Note this is a real gap today: `ImageLightbox` currently has no scroll lock
at all, only an Escape handler. Whatever we build here should be extracted
so the lightbox can adopt it too.

### Q4 — How do we handle zoom while still allowing drawing?

This is the hardest interaction problem in the feature. Two decisions:

**Decision A: zoom inside Fabric, not with a CSS transform.**

`PinchZoomPan` works by CSS-transforming a wrapper `<div>`. That is correct
for a static image, but if we do it here, Fabric's pointer→canvas
coordinate mapping and the CSS transform will disagree, and strokes will
land offset from the finger — worse as you zoom further in.

Instead, drive `canvas.setViewportTransform()` / `canvas.setZoom()` from the
same `pinchZoomMath` functions. Fabric then maps pointers correctly for
free, at every zoom level, with no inverse-transform math of our own.

**Reuse `pinchZoomMath.ts` (pure, already unit-tested). Do not reuse the
`PinchZoomPan` component.**

**Decision B: deferred stroke commit, to solve the two-finger race.**

A player pinching does not land both fingers simultaneously — the second
arrives 30–80ms after the first. A naive "one finger draws" rule paints a
stray dash on every single pinch.

The rule:

```
pointerdown (1st)  → start buffering points; do NOT commit a stroke yet
pointerdown (2nd)  → discard the buffer entirely, switch to pinch/pan
after GRACE_MS (~120ms) with still one pointer, OR
  after movement exceeds STROKE_COMMIT_PX (~6px)
                   → commit: this is a real stroke, start painting
pointerup          → finalise the Fabric path, push undo snapshot
```

`PinchZoomPan.reanchor()` already implements exactly the "the set of active
pointers changed, re-derive the gesture from scratch" logic this needs, and
its comment explains why re-deriving beats incremental adjustment. Port that
approach.

**Open sub-question for you:** should one finger *pan* when zoomed in, or
always draw? Today `PinchZoomPan` pans with one finger when `scale > 1`.
For a drawing board I recommend **one finger always draws**, with two-finger
drag to pan, plus a visible "Reset View" button (already in your V1 list).
Otherwise the player cannot draw in the zoomed-in region, which is the whole
reason they zoomed.

### Q5 — What drawing library should we use?

**Fabric v7 — the one already installed.** Rationale, in order of weight:

1. **The coach-side viewer comes free.** Player strokes stored as Fabric
   objects render through the existing `AnnotationViewer` with a second
   layer. Any other library means writing and testing a second renderer.
2. **Zero bundle cost.** Fabric is already shipped.
3. **Undo/redo already exists** (`useAnnotationHistory`) and is
   format-agnostic snapshot-based.
4. **`PencilBrush` already gives quadratic-smoothed strokes** and is already
   used and tested here.

Alternatives considered and rejected for V1:

- **Konva** — good, but a second canvas library in the bundle and a second
  renderer to write. No benefit over what we have.
- **`perfect-freehand`** — genuinely nicer stroke *feel* (pressure/velocity
  tapering). But it outputs filled polygons rather than stroked paths, which
  changes the storage format and the renderer. Worth revisiting in V2 as a
  pure feel upgrade; not worth the format churn now.
- **tldraw / Excalidraw** — entire editors. Vastly more than "pen and
  eraser," and they own their own data format.

**One implementation caveat that needs a spike.** We want `PencilBrush`'s
smoothing *and* our own gesture control. The plan is to construct the brush
but call `brush.onMouseDown/onMouseMove/onMouseUp` ourselves from our
pointer handlers, rather than letting `canvas.isDrawingMode` bind its own
listeners (which would fight the pinch layer). This API is public in Fabric
v6/v7 but I have not verified it against v7.4 in this project. **Phase 0
spike.** Fallback if it misbehaves: collect points ourselves and build a
Fabric `Polyline` — already done for the curve tool in `AnnotationCanvas`.

**Eraser — a product decision, not just a technical one.** Fabric core has
no eraser brush in v7 (the old `EraserBrush` was dropped). Two options:

- **(Recommended) Object eraser** — tapping/dragging over a stroke deletes
  that whole stroke. Simple, keeps vectors clean, trivially undoable, and
  consistent with "no layers."
- **Pixel eraser** — erases part of a stroke. Requires either a raster
  compositing layer (destroys the vector model) or path-splitting geometry
  (expensive and fiddly).

I recommend the object eraser for V1. **This changes what "eraser" means to
a player** — please confirm it's acceptable before Phase 3.

### Q6 — How do we autosave?

Two tiers, because the network is the unreliable part and a phone in a
locker room is the environment.

**Tier 1 — local, continuous, zero network.** On every stroke end, write the
current stroke array to IndexedDB keyed by
`(access_code_id, player_key, question_id)`. Survives a refresh, a crash, a
backgrounded Safari tab, and a dead zone. Instant.

**Tier 2 — server.** On **Done**, and on a throttled timer (~every 15s) while
the board is open and dirty. Not per stroke: stroke JSON is far larger than
a text answer and per-stroke POSTs would be wasteful and jittery.

Deliberately different from the existing text autosave, which debounces at
`AUTOSAVE_DEBOUNCE_MS = 800`. A drawing payload is orders of magnitude
bigger; 800ms debounce on it would be hostile to a phone on stadium wifi.

Reuse `upsert_answer`'s `ON CONFLICT DO UPDATE` discipline so a timer save
racing a Done save resolves to last-write-wins rather than a 500.

### Q7 — How do we resume after refresh?

`GET /play/resume` already returns every saved answer for an in-progress
attempt. Extend its per-answer payload with
`{ has_drawing, drawing_updated_at, preview_url }`.

On load, for each drawing question, compare:

- **server `drawing_updated_at`** vs
- **local IndexedDB draft timestamp**

Rules:
- Local newer → restore local silently (it's the player's own unsaved work),
  then push it to the server.
- Server newer or equal → use server, discard local draft.
- Local exists, server has nothing → restore local, push to server.

The player never sees a merge prompt. There is exactly one author, so
last-write-wins by timestamp is correct and a conflict UI would be noise.

Clear the local draft once the attempt is SUBMITTED.

### Q8 — How should the coach view be built?

Almost entirely from parts that exist.

`AnnotationViewer` today composites: **source image → coach annotations**.
For a drawing answer it composites: **source image → coach annotations →
player strokes**, in that z-order, as two object arrays loaded into the same
`StaticCanvas`.

The only real work is a small extension to accept a second `objects` array
and render it above the first, plus a visual distinction so the coach can
tell their own pre-annotation from the player's answer at a glance. **I
recommend enforcing a distinct player stroke colour** (a single fixed colour
in V1, since there's no colour picker) rather than relying on the coach to
remember which marks are whose.

Grading needs **no backend change at all**: `grade_answer`, `GradeAuditLog`,
the Correct / Incorrect / Not Graded vocabulary and the feedback field all
work on an `Answer` row regardless of what produced it. A drawing answer is,
to the grading system, exactly a written answer that happens to render as a
picture.

`ResponseRow.tsx` gains one branch: if the question is `draw_on_image`,
render the composited viewer instead of the answer text.

### Q9 — How should exports eventually support drawings?

`export.py` already embeds images through
`_load_image_flowable(load_image_bytes, image_url)`, and the question card is
already built from row groups that split safely across pages. Embedding a
player drawing is **one extra call to machinery that already exists** —
this is precisely why the flattened preview is worth storing.

The PDF should embed the **composite** preview (image + coach annotations +
player strokes), not the strokes alone — the coach needs to see what the
player saw and what they drew, together.

Two things to get right *now*, in the schema, so the export lands cleanly
later:

- The preview must be generated at a **print-usable resolution**. The PDF
  caps images at 4.5in × 3.5in; at ~150dpi that's ~675×525. Generate the
  preview at ≥1400px wide and let Pillow downscale.
- `answer_drawings.preview_url` must be **nullable and tolerated as
  missing**, and `_load_image_flowable` already degrades to a documented
  placeholder rather than failing the export. A drawing with no preview
  should print "[Drawing unavailable]", never blow up a 50-page report.

**Server-side rendering of strokes is the trap to avoid.** There is no
Fabric for Python. Rasterising Fabric JSON server-side would mean either a
Node sidecar (new infrastructure, new deploy surface on Render) or writing a
path renderer by hand. Client-generated previews avoid all of it. If we
later need server-side regeneration (e.g. to re-render every historical
drawing at a new size), that's a deliberate future project, not a V1
dependency.

### Q10 — What are the biggest technical risks?

Ranked by expected pain, with mitigations. Expanded in §8.

1. **iOS Safari gestures** — no simulator substitutes for a real iPhone.
2. **Canvas memory on low-end Android** — a naive port of the desktop
   render scale allocates ~20MB of backing store per canvas.
3. **The Postgres enum migration** — `ALTER TYPE … ADD VALUE` has
   transaction semantics that will bite an ordinary Alembic migration.
4. **Silent integration gaps** — "did they answer?" logic in ~6 places.
5. **Stroke payload size** — an enthusiastic player can generate megabytes.
6. **Coach replaces the question image after players have drawn.**
7. **Preview trust** — the client generates an image we later print.

---

## 3. Data model

### 3.1 The coordinate-space rule (the thing not to get wrong)

`canvasSizing.ts` carries a hard-won lesson, and its comment says it
plainly: the canvas width *is* the coordinate space every saved shape's x/y
is relative to, so it can never be changed in place without moving every
previously-saved shape. That's why `question_images.canvas_width` exists and
why it's pinned per image.

Player drawings have the same problem **and one more**: a coach can replace
or re-upload the question image after players have already drawn on it. A
stroke array with no record of what it was drawn against is unrenderable and
unverifiable.

So every drawing stores its own space *and* its backdrop:

- `canvas_width` — the coordinate space, pinned at author time, **NOT NULL**
  (this is a new feature; there is no legacy to accommodate, so unlike
  `question_images.canvas_width` it should never be nullable).
- `canvas_height` — derivable from width and aspect ratio, but stored
  anyway: it costs 4 bytes and it's the only thing that keeps the drawing
  renderable if the source image is ever lost.
- `source_image_url` — a snapshot of the exact image the player drew on.

### 3.2 New table

Mirrors `question_images` deliberately — same 1:1 shape, same JSON strokes,
same pinned coordinate space — so there is one storage idea in the codebase,
not two.

```
answer_drawings
  id                   PK
  answer_id            FK answers.id ON DELETE CASCADE, UNIQUE, INDEX
  strokes              JSONB   NOT NULL DEFAULT '[]'   -- Fabric object array
  canvas_width         Integer NOT NULL
  canvas_height        Integer NOT NULL
  source_image_url     String(1024) NOT NULL
  preview_url          String(1024) NULL
  preview_generated_at DateTime NULL
  created_at           DateTime
  updated_at           DateTime
```

**Why a separate table rather than columns on `answers`:**

- `answers` is the hottest table in the app — every autosave upserts it,
  and analytics, the dashboard, CSV and the PDF all bulk-load it. It should
  stay narrow.
- It mirrors the existing `questions` → `question_images` relationship, so
  the pattern is already understood.
- `ON DELETE CASCADE` from `answers` means a coach resetting an attempt (a
  row delete) cleans up drawings for free, exactly like today.

**Orphaned R2 objects.** A cascade delete removes the row but not the
preview file in R2. `file_storage.delete_image` exists; the deletion path
needs an explicit hook, or previews leak on every attempt reset. Small, but
easy to forget — it's called out in Phase 1.

### 3.3 Enum change — read this before writing the migration

`question_type` is a **native Postgres enum**, created in the initial schema
as `sa.Enum('TRUE_FALSE','MULTIPLE_CHOICE','WRITTEN', name='questiontype')`,
and SQLAlchemy stores the **member name** (`WRITTEN`), not the value
(`written`).

Adding `DRAW_ON_IMAGE` therefore requires:

```sql
ALTER TYPE questiontype ADD VALUE 'DRAW_ON_IMAGE';
```

Two traps:

1. On PostgreSQL, a newly added enum value **cannot be used in the same
   transaction that added it**. Alembic wraps migrations in a transaction by
   default, so a migration that adds the value *and* inserts/updates rows
   using it will fail. Split them, or run the `ALTER TYPE` with an
   autocommit connection.
2. **Enum values cannot be removed.** The downgrade cannot cleanly reverse
   this. The migration's `downgrade()` should say so explicitly rather than
   pretend — the honest downgrade is "leave the value in place, it is inert
   if unused."

Rehearse on a seeded scratch database before it goes near production — the
same rehearsal step used for the organizations and master-roster migrations.

### 3.4 Data volume

Rough sizing for a 60-player squad, one drawing question per quiz, two
quizzes a week:

- Stroke JSON: ~20–80KB typical after decimation, cap at 256KB (§8.5).
- Preview JPEG at 1400px: ~150–300KB after the existing Pillow compression.
- Per quiz: 60 × ~350KB ≈ **21MB**, dominated by previews.
- Per season (~30 quizzes): **~600MB per team** in R2.

R2 pricing makes that a non-issue, but it is worth knowing before it's a
surprise, and it argues for previews being JPEG (already the case —
`_compress_image` re-encodes everything to JPEG) rather than PNG.

---

## 4. Backend architecture

### 4.1 New endpoint

```
POST /api/play/answers/drawing        (multipart/form-data)
  access_code_id   int
  player_name      str
  player_id        int | null
  question_id      int
  strokes          str   (JSON)
  canvas_width     int
  canvas_height    int
  preview          file  (image/jpeg|png)
```

**Multipart, and separate from `/play/answers`,** because the payload is
binary + large + infrequent, whereas `/play/answers` is small + JSON +
very frequent. They want different rate limits and different size caps.
One round trip keeps strokes and preview atomic.

It reuses, unchanged:

- `find_attempt(access_code_id, player_name, player_id)` — the same
  re-derive-don't-trust-a-client-id rule every mutating play route follows.
- `reason_for_invalid(access_code)` — so a drawing can't be saved past code
  expiry, exactly as text answers can't.
- The SUBMITTED hard lock — a submitted attempt refuses further writes.
- `file_storage.save_image()` for the preview, which **also sanitises it**:
  the Pillow decode-and-re-encode-to-JPEG pipeline strips EXIF, embedded
  payloads, and anything that isn't pixels. This substantially defuses risk
  §8.7 for free.

Rate limit: lower than `/play/answers`'s 1000/min. Something like
**120/min per IP**, still sized for a whole squad on one school wifi
(see the shared-IP reasoning already documented on `validate-code`).

### 4.2 `upsert_answer` changes

It currently computes `is_correct` from the selected option. A drawing
answer must land as `answer_text = NULL`, `selected_option_id = NULL`,
`is_correct = NULL` — i.e. it takes the same path a written answer takes,
and grading stays manual.

The cleanest shape: keep `upsert_answer` as the single owner of the Answer
row (so the ON CONFLICT logic isn't duplicated), give it an explicit
"drawing" mode that skips option validation, and put the `AnswerDrawing`
upsert in a sibling function in the same service. Both inside one
transaction; the caller still owns the commit boundary, per the existing
docstring's contract.

### 4.3 Validation

- A `draw_on_image` question **must** have an image. Enforce at question
  create/update — a drawing question without a backdrop is meaningless, and
  failing at authoring time is far better than failing for 60 players.
- A `draw_on_image` question must have **no options** (mirrors `written`).
- Reject stroke JSON over the size cap with a clear 422, not a 500.
- Validate `strokes` is a JSON array of objects, and cap the object count.
  The backend deliberately treats stroke contents as opaque — same stance
  `question_images.annotations` already takes, so new stroke properties
  never need a migration.

### 4.4 Reads

`Question.to_dict()` already includes `image`. `Answer.to_dict()` gains
`drawing: {preview_url, canvas_width, canvas_height, updated_at}` — note it
should return **stroke data only where it's needed** (the coach results view
and resume), not on every bulk answer load, or the analytics and dashboard
queries start dragging JSONB blobs around for nothing.

---

## 5. Frontend architecture

### 5.1 New components

```
components/drawing/
  DrawingBoard.tsx          fullscreen overlay shell (portal, scroll lock, safe areas)
  DrawingCanvas.tsx         Fabric canvas + gesture layer
  DrawingToolbar.tsx        pen / eraser / undo / redo / clear / reset view / done / cancel
  useDrawingGestures.ts     pointer arbitration: draw vs pinch (the hard part)
  useBodyScrollLock.ts      iOS-safe lock  ← extract so ImageLightbox can adopt it
  drawingStorage.ts         IndexedDB draft read/write/clear
pages/play/
  DrawingAnswerInput.tsx    thumbnail + "Tap to draw" + reopen, inside QuestionInput
```

### 5.2 Reused as-is

`pinchZoomMath.ts`, `useAnnotationHistory.ts`, `canvasSizing.ts`,
`imageLoading.ts` (`loadPrescaledImage`), `AnnotationViewer.tsx` (extended
for a second layer), `Modal`/portal conventions, the design-system tokens.

### 5.3 Why not just reuse `PinchZoomPan`?

Because it zooms by CSS-transforming a wrapper div, and a Fabric canvas
inside a CSS-transformed ancestor will map pointer coordinates
inconsistently — strokes drift from the fingertip, worse the further you
zoom. Its *math* is right and reusable; its *transform strategy* is right
for a static image and wrong for a live canvas. Drive
`canvas.setViewportTransform()` instead.

This is worth stating loudly because "just wrap the canvas in PinchZoomPan"
is the obvious first idea and it will appear to work at 1× zoom.

### 5.4 Render scale on mobile

`PLAYER_RENDER_SCALE = 2` against `MAX_CANVAS_WIDTH = 1400` gives a 2800px
backing store. Canvas memory is `w × h × 4` bytes: 2800 × 1750 × 4 ≈
**19.6MB**, before Fabric's own object caches, on a device that may have
very little headroom — and Safari kills tabs that overrun rather than
degrading.

The drawing board should choose its render scale from
`devicePixelRatio` and a viewport-size heuristic, capped well below the
desktop value on phones. **The coordinate space (`canvas_width`) must not
change with it** — render scale and coordinate space are different things,
and `canvasSizing.ts`'s comments already make that distinction; keep it.

### 5.5 Integration into the quiz flow

`QuestionInput.tsx` gains a `draw_on_image` branch rendering
`DrawingAnswerInput`, which shows either "Tap to draw your answer" or the
saved thumbnail with "Tap to edit". Opening it mounts `DrawingBoard`.

`QuizStep.tsx`:
- `hasAnswer()` must count a saved drawing, or required-answers enforcement
  will block submission on an answered question. **This is the single most
  likely bug in the whole feature.**
- The flush-on-submit path must flush pending drawing saves too.

---

## 6. Mobile UX proposal

```
┌──────────────────────────────────────┐
│  ✕ Cancel        Q3          Done ✓  │  ← fixed top bar, safe-area padded
├──────────────────────────────────────┤
│                                      │
│                                      │
│         [ film still + strokes ]     │  ← fills all remaining space
│                                      │
│                                      │
├──────────────────────────────────────┤
│  ✏️Pen  🧽Eraser  ↩︎  ↪︎  ⟲Reset  🗑Clear │  ← fixed bottom bar, ≥44px targets
└──────────────────────────────────────┘
```

Details that matter on a phone:

- **44px minimum touch targets** — already the player-side standard in
  `index.css`; the coach side's 32px does not apply here.
- **Safe-area insets** — `env(safe-area-inset-bottom)` on the toolbar, or
  the home indicator sits on top of Clear/Done on every modern iPhone.
- **Destructive actions confirm.** Clear Drawing and Cancel-with-unsaved-work
  both route through the existing `ConfirmModal`. Losing a drawing to a
  fat-fingered tap is the worst outcome in this flow.
- **Toolbars must not be drawable.** The canvas ends where the bars begin;
  a stroke started on a bar does nothing.
- **Pen thickness** — no picker in V1, but the default must be chosen
  against a *phone* viewport, not a desktop one. A 2px desktop stroke is
  nearly invisible on a 6" screen showing a wide-angle film still.
- **Orientation change** — the coordinate space is pinned, so rotating must
  re-fit the view, never re-scale the strokes. Worth an explicit test.
- **Player theme, not coach theme.** The board lives in the player flow and
  keeps the light palette per `docs/THEMING.md` — with the caveat below.

**One place I'd push back on your spec.** A drawing board is the one player
surface where a *dark* chrome is arguably correct: film stills are dark, and
a light UI around them causes glare and iris adaptation problems outdoors.
I'd propose dark toolbars with the light player palette everywhere else in
the flow. That's a deliberate exception to the "player stays light" rule, so
it's your call, not mine — flagging rather than assuming.

---

## 7. Complexity estimate

Relative to work already done in this repo:

| Phase | Scope | Size | Comparable to |
|---|---|---|---|
| 0 | Spikes (iOS gestures, Fabric brush API) | S | — |
| 1 | Model, migration, storage, endpoint | M | the `question_images` work |
| 2 | Coach authoring + validation | S | the required-answers setting |
| 3 | **Drawing board** | **XL** | the annotation editor itself |
| 4 | Autosave + resume + IndexedDB | M | the attempts/autosave phase |
| 5 | Coach results view + grading | S | mostly free — see §2 Q8 |
| 6 | Integration correctness sweep | M | the master-roster threading pass |
| 7 | PDF export | S | one call into existing machinery |
| 8 | Real-device QA | M | — |

**Overall: the largest single feature since Master Roster / Player identity.**
Phase 3 alone is comparable to the entire original annotation editor, and
Phase 6 is the one most likely to be under-estimated because it's invisible.

---

## 8. Risks

**8.1 iOS Safari gesture handling — HIGH.**
Every mitigation in §2 Q3 is there because some device needs it. There is no
substitute for a physical iPhone; the simulator does not reproduce
rubber-banding, `gesturestart`, or dynamic-viewport behaviour faithfully.
*Mitigation:* Phase 0 spike on a real device before anything else is built.

**8.2 Canvas memory on low-end Android — HIGH.**
~20MB backing store at desktop settings; Safari and low-end Chrome kill tabs
rather than degrade. *Mitigation:* device-aware render scale (§5.4), and
test on a genuinely cheap phone, not a flagship.

**8.3 Postgres enum migration — MEDIUM, but certain to bite.**
`ALTER TYPE … ADD VALUE` + Alembic's transaction wrapper (§3.3).
*Mitigation:* split the migration, rehearse on a scratch DB, write an honest
`downgrade()`.

**8.4 Silent integration gaps — MEDIUM, highest chance of shipping unnoticed.**
Every place that asks "did this player answer?" or "what did they answer?"
needs a drawing branch: `QuizStep.hasAnswer`, backend required-answers
enforcement, `player_analytics.py`, `export.py::_answer_text` (which
currently returns `""` for an unknown type — so the PDF would print "No
answer submitted." for a perfectly good drawing), `build_results_csv`, and
the dashboard/per-question breakdown counts.
*Mitigation:* Phase 6 exists solely for this, with a test per call site.

**8.5 Stroke payload size — MEDIUM.**
A player scribbling for two minutes can generate a very large path array.
*Mitigation:* raise `PencilBrush.decimate` on mobile, hard-cap stroke JSON
(~256KB) with a friendly 422, cap object count, and surface a "drawing is
getting large" hint rather than failing silently at Done.

**8.6 Coach replaces the question image after players have drawn — MEDIUM.**
Strokes then float over a different backdrop.
*Mitigation:* `source_image_url` snapshot (§3.1) lets the coach view render
against what the player actually saw and flag the mismatch. Consider warning
the coach at replace time if any attempt already has a drawing.

**8.7 Preview trust — LOW.**
The client generates an image the server later prints. A player could POST
an arbitrary image instead of their drawing.
*Assessment:* low severity — they already control their own answer content,
so this is content substitution, not privilege escalation, and the strokes
(which the coach view renders from) would visibly disagree. The dangerous
part is malicious *file* content, and `file_storage`'s Pillow re-encode
already neutralises that. Worth documenting, not worth engineering against
in V1.

**8.8 Offline mid-drawing — LOW, already largely handled.**
IndexedDB tier means the work survives; the existing `ApiError` handling
surfaces the failure. Needs a "not saved to server yet" indicator so a
player doesn't submit believing it synced.

---

## 9. Phased implementation plan

Each phase is independently reviewable and leaves the app shippable.

**Phase 0 — De-risk (do this before agreeing to the rest)**
- Spike A: throwaway page on a real iPhone + a cheap Android — fullscreen
  overlay, scroll lock, draw vs pinch arbitration, memory under load.
- Spike B: confirm `PencilBrush.onMouseDown/Move/Up` can be driven manually
  in Fabric 7.4; fall back to `Polyline` if not.
- **Gate: if Spike A can't be made to feel good, stop and rethink before
  spending Phase 3.**

**Phase 1 — Data + API (no UI)**
`AnswerDrawing` model, migration (rehearsed), `POST /play/answers/drawing`,
`upsert_answer` drawing mode, validation, preview deletion hook, backend
tests including the SUBMITTED lock and expired-code paths.

**Phase 2 — Coach authoring**
`draw_on_image` in the type picker; image-required validation; existing
annotation editor reused unchanged for optional pre-annotation.

**Phase 3 — Drawing board (the big one)**
Overlay shell, scroll lock, gesture arbitration, Fabric canvas, pen +
object eraser, undo/redo, clear, reset view, done/cancel, toolbar.
Unit-test the gesture arbitration as a pure module the way `pinchZoomMath`
already is.

**Phase 4 — Autosave + resume**
IndexedDB drafts, throttled server saves, `/play/resume` extension,
last-write-wins restore, sync indicator.

**Phase 5 — Coach results + grading**
`AnnotationViewer` two-layer extension, `ResponseRow` branch, distinct
player stroke colour. Grading itself unchanged.

**Phase 6 — Integration correctness sweep**
Every call site in §8.4, each with a test. Nothing user-visible; entirely
about drawings not being silently miscounted.

**Phase 7 — PDF export**
Embed the composite preview; `[Drawing unavailable]` fallback; layout check
against a realistic multi-drawing fixture like the one used for the PDF
redesign review.

**Phase 8 — Real-device QA**
iPhone (older + current), mid-range Android, tablet. Orientation changes,
backgrounding mid-drawing, airplane mode mid-drawing, a 60-player load pass.

---

## 10. Product decisions (locked)

| # | Decision | Consequence |
|---|---|---|
| 1 | **Eraser deletes whole strokes.** No pixel erasing. | Everything stays vector, undoable, and editable. `canvas.findTarget()` does the hit-test and is zoom-correct for free. |
| 2 | **One finger always draws.** A dedicated **Pan tool** replaces intent-guessing. | No accidental panning mid-stroke. Single-finger pan exists only while Pan is selected; two-finger drag still pans in any tool. |
| 3 | **Dark "film room" workspace.** | The one intentional exception to the light player theme. Dark background, floating toolbar, minimal chrome. |
| 4 | **A `draw_on_image` question always requires an image.** | Validation error at authoring time, not a broken quiz for 60 players. |
| 5 | **Single fixed player pen colour in V1.** | Player strokes are instantly distinguishable from coach gold annotations, with no picker to build. |
| 6 | **Coach view ships with three modes: Image Only / Coach Version / Player Submission.** | Built properly in Phase 5 rather than retrofitted. See §12. |

---

## 11. The drawing engine as a core capability

Version 1 exposes drawing only through Draw on Image questions. But the
engine is expected to power assignments, player corrections, scouting
reports, recruiting evaluations, install packets and coach feedback later.
The architecture below is what stops that becoming a second drawing system.

### 11.1 The rule: the engine knows nothing about quizzes

`components/drawing/` must not import anything from `api/`, `pages/play/`,
or any model type. It takes an image and strokes, and it emits strokes and a
preview. That is the entire contract:

```ts
<DrawingBoard
  image={{ url, width, height }}
  initial={DrawingDocument | null}
  mode="edit" | "view"
  onCommit={(doc: DrawingDocument, preview: Blob) => Promise<void>}
  onCancel={() => void}
/>
```

Everything quiz-specific — which Answer row this belongs to, the access
code, the SUBMITTED lock, the autosave endpoint — lives in a thin adapter
*outside* the engine. Draw on Image supplies a quiz-answer adapter; a
future scouting report supplies its own, and touches no engine code.

Concretely, this splits the Phase 3 work into:

```
components/drawing/          ← the engine. Reusable. No app knowledge.
  DrawingBoard.tsx
  DrawingCanvas.tsx
  DrawingToolbar.tsx
  drawingGestures.ts         ← already built and unit-tested (Phase 0)
  useBodyScrollLock.ts       ← already built (Phase 0)
  drawingDocument.ts         ← the versioned format, below

pages/play/                  ← the quiz adapter. Knows about answers.
  DrawingAnswerInput.tsx
  drawingAnswerAdapter.ts
```

### 11.2 A versioned document format

Every consumer stores the same envelope, whatever table it lives in:

```ts
interface DrawingDocument {
  version: 1;                 // bump if the stroke representation changes
  canvasWidth: number;        // the coordinate space (see §3.1)
  canvasHeight: number;
  sourceImageUrl: string;     // what was actually drawn on
  strokes: FabricObject[];    // Fabric object array, same as question_images.annotations
}
```

`version` costs one integer now and is the only thing that makes a future
format change survivable — if we ever move to `perfect-freehand` (§2 Q5),
old documents stay renderable because the renderer can branch on it.

### 11.3 Share the engine and the format — **not** the table

The tempting move is a single generic `drawings` table with a polymorphic
owner (`owner_type` + `owner_id`) so any future feature can point at it.

**I'd argue against it.** A polymorphic owner cannot have a real foreign
key, which means: no `ON DELETE CASCADE` (so deleting an attempt silently
orphans drawings), no referential integrity, and every query needs a
discriminator the database can't enforce. This codebase currently gets
cascade cleanup for free everywhere, including the coach's "reset attempt"
action.

The cheaper trade is to let each owner have its own small table with a real
FK — `answer_drawings` now, `scouting_note_drawings` later — all storing the
same `DrawingDocument` shape and rendered by the same engine. Duplicating
six columns across a handful of future tables is a much smaller cost than
losing integrity on all of them.

So: **one engine, one format, one renderer, one storage *pattern* — but a
real foreign key per owner.**

### 11.4 What else falls out of this for free

- The **coach annotation editor** (`AnnotationCanvas.tsx`) is a second
  drawing system that already exists. It is not in scope to merge now, but
  once the engine is proven, folding it in is a natural follow-up — and the
  engine should be designed so that's possible, which mainly means not
  hard-coding "one fixed pen colour" into the engine itself. Make colour a
  *config value the adapter supplies*; the Draw on Image adapter supplies
  exactly one.
- `useBodyScrollLock` is immediately reusable by `ImageLightbox`, which has
  no scroll lock today.

---

## 12. Coach view: three modes

Per decision 6, built properly in Phase 5 rather than retrofitted.

| Mode | Renders | Why a coach wants it |
|---|---|---|
| **Image Only** | source image | See the raw look the player got, with nothing on top |
| **Coach Version** | image + coach annotations | Re-read your own question/key |
| **Player Submission** | image + coach annotations + player strokes | The default for grading |

Implementation is one extension to `AnnotationViewer`: accept an ordered
list of object layers rather than a single `annotations` array, and let the
caller decide which layers to pass. The mode switch is then pure client
state — no extra requests, no extra storage, and it composes to more layers
later (e.g. a coach marking up a player's submission) without another
change.

---

## 13. Confidence rating (not V1 — but the data model should not preclude it)

The eventual question — "How confident are you?" → Very Confident /
Somewhat Confident / Guessing — is deliberately **not** being built now.
Three notes so it stays cheap later:

**It does not belong on `answer_drawings`.** Confidence is not
drawing-specific; a coach would plausibly want it on a written or
multiple-choice answer too. Putting it on the drawing table would guarantee
a migration and a data backfill the day it's wanted elsewhere.

**It belongs on `answers`** as a nullable enum column, added when it's
built: `confidence` ∈ {`VERY_CONFIDENT`, `SOMEWHAT_CONFIDENT`, `GUESSING`},
NULL meaning "not asked" or "not answered". Nullable-with-meaning is the
same pattern `is_correct` already uses for Not Graded, so it reads
consistently.

**The design constraint to hold now** is simply: keep `answers` the owner of
answer-level metadata, and resist pushing per-type metadata into per-type
tables. `answer_drawings` holds *the drawing*; it should not accumulate
things that are really properties of the answer. Hold that line and
confidence is a one-column migration.

**Why it's worth wanting.** The analytic value isn't the rating on its own,
it's confidence × correctness:

| | Correct | Incorrect |
|---|---|---|
| **Very Confident** | genuinely known | **confidently wrong — the highest-value coaching signal there is** |
| **Guessing** | lucky — not yet learned | honestly not known |

A player who is confidently wrong will play fast and be wrong at speed. A
player who is guessing correctly looks fine in every current metric.
Today's analytics cannot tell those apart from a player who genuinely knows
it. That's the reason to keep the door open.

One hard constraint when it does land: **confidence must never enter the
score.** `_score_percent` stays `correct / (correct + incorrect)`, and the
CORRECT / INCORRECT / NOT_GRADED / UNANSWERED vocabulary stays untouched —
otherwise the export, the analytics service and the Results tab immediately
disagree with each other, which is exactly the class of bug the shared
vocabulary in `export.py` and `player_analytics.py` exists to prevent.

---

## 14. Phase 0 spike — status

The harness lives at `frontend/src/spike/`, on the route `/spike/drawing`,
registered only under `import.meta.env.DEV`. Verified absent from the
production bundle. Delete the route and the directory once Phase 0 is
signed off.

### Settled without a phone

| Question | Result |
|---|---|
| **Can `PencilBrush` be driven manually?** (the architecture-deciding one) | **Yes.** `onMouseDown(pointer, {e})` / `onMouseMove` / `onMouseUp({e})` are public in Fabric 7.4.0, alongside `decimate` and `convertPointsToSVGPath`. Confirmed in a live browser: a driven stroke produced a real 12-point Fabric path. |
| **Zoom-correct pointer mapping** | `canvas.getScenePoint(e)` inverse-transforms through the viewport automatically, and `zoomToPoint()` does focal zoom. **This removes the custom inverse-transform math the design had budgeted for** — and confirms Decision A (zoom inside Fabric, not via CSS transform). Note `getPointer()` is gone in v7; most tutorials still use it. |
| **Gesture arbitration logic** | Extracted as a pure module, **17 unit tests passing**, covering the two-finger race, buffer replay, pinch/pan, the Pan tool, whole-stroke erase, and stray/out-of-order events. |
| **iOS-safe scroll lock** | Implemented and verified: with the page scrolled to 400px, opening the board sets `position: fixed`, `top: -400px`, `overflow: hidden`, `overscroll-behavior: none`, and restores scroll on close. |
| **Memory / render scale** | Device-aware scale confirmed working: on a dpr-2 375px viewport it chose 1.5x → **10.4 MB** backing store instead of the ~20 MB a naive desktop port would allocate. |
| **Local draft persistence** | IndexedDB write confirmed; restore-on-load path exercised. |

### Only a real phone can settle these

Everything below is why the gate stays open. Desktop mobile emulation does
not reproduce any of it:

- **Multi-touch pinch arbitration in practice.** The logic is unit-tested,
  but synthetic pointer events in a desktop browser cannot honestly stand in
  for two fingers. (A portaled overlay also sits outside React's root
  container, so natively-dispatched events don't reach React's delegated
  handlers at all — a test-harness artifact, not a product bug, but it means
  synthetic multi-touch proves nothing here either way.)
- **iOS Safari rubber-banding, `gesturestart`, and dynamic viewport.**
- **Drawing latency and FPS under a real finger**, especially on a cheap
  Android.
- **Memory pressure** — whether Safari kills the tab after sustained drawing.
- **Backgrounding and refresh behaviour**, including airplane mode.
- **Whether the dark workspace actually feels right outdoors.**

### The device protocol

Serve the dev server on the LAN (`npm run dev -- --host`), open
`http://<your-ip>:5173/spike/drawing` on the phone, and work the checklist
printed on the page. **Everything you need is on-screen in the HUD** —
there are no devtools on a phone, which is why the telemetry panel is the
real deliverable of this spike.

The two numbers that decide the gate:

- **`stray marks` must stay 0.** Anything above zero means a pinch painted
  ink — the arbitration is losing the race on real hardware and the grace
  window needs tuning.
- **`fps` must hold up while drawing.** It turns red below 40.

Also watch `est. memory` on the cheapest phone you can find, and confirm
`dvh` reports `yes` on the iPhone.

---

## 15. Recommendation

**Proceed — but gate on Phase 0.**

The architecture is unusually low-risk for a feature this visible, because
the repo already contains working, tested answers to the three questions
that normally sink this kind of work. The storage model is a direct mirror
of `question_images`. The coach view is nearly free. The PDF path is one
call into machinery built last week.

What is *not* low-risk is the mobile gesture layer, and no amount of design
document reduces that risk — only a real phone does. Spend two days on
Phase 0 spikes before committing to the rest. If the drawing feel is right
on a real iPhone, the remainder is well-understood work.

I'd also suggest holding Phase 7 (PDF) until Phases 3–6 have been used by
real coaches for a week. The schema supports it from day one, which is what
you asked for; shipping it is better done once you know what coaches
actually want to see printed.
