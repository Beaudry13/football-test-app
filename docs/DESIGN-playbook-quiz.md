# Playbook Quiz — architecture and UX proposal

Design for review. **No code written.**

A coach uploads a playbook PDF, drags rectangles over the parts worth knowing,
and each rectangle becomes a question. One page, many questions, never
duplicated.

This document takes that brief seriously and disagrees with parts of it. The
disagreements are in §2 and §§6–7; those are the ones worth reading first if
you read nothing else.

---

## 0a. Decisions locked (owner, review round 1)

These are settled and should not be relitigated without a specific reason:

1. **Server-side masking.** The player never receives a page with the answer
   underneath. Masking is applied before delivery.
2. **Playbooks are private assets.** Never publicly addressable by URL. This
   posture should become the standard for protected coaching documents
   generally, not a one-off for playbooks.
3. **No page-selection step.** Upload opens the editor; a page is chosen by
   being worked on.
4. **No dialogs in the creation loop.** Drag → release → answer focused → keep
   going. Remember the last question type.
5. **One rendering pipeline, one coordinate system.** Editor and player always
   work from the identical rendered output.
6. **Regions have roles**, extensible beyond mask / focus / crop.
7. **`question_images` and document pages stay separate in V1.** The
   unification target is documented (§4) but not built.

Also confirmed: playbooks are **mostly digital PDFs today, but scans must
ultimately be supported**, and a realistic page carries **3–15 questions**.

That last pair of facts is the most important input in this document, and
§19 argues they make the agreed workflow obsolete before it is built.

---

## 0b. Spike evidence and the decisions it settled (owner, review round 2)

The §21 spike ran against three real defensive playbooks (CROWN, FLOOD, TIGER —
7 pages total, PowerPoint-exported, 612x792pt). **This section is authoritative
where it conflicts with anything below.** Sections written before the evidence
existed are annotated where they are now wrong rather than deleted, so the
reasoning stays legible.

### What the evidence showed

| Measure | Result | What it settles |
| --- | --- | --- |
| Pages with no text layer | **0 of 7** | No OCR needed. §19's premise holds |
| Pages rasterised or outlined | **0 of 7** | The PowerPoint-export hazard did not materialise |
| Fragmented text (< 3 chars/run) | **0 of 7** | No run-merging needed for correctness |
| Text-box ink density | **42-51% on every page** | PDFium's boxes sit precisely on the glyphs |
| Reading-order score | **63-77%, never above 80%** | **Auto-generated prompts are not safe** |
| Median run width (prose pages) | 23-27px on a 1000px canvas | Directly tappable |
| Median run width (diagram pages) | **9-11px** | Not tappable by point-in-box |
| Runs reaching a 44px touch target | 3-38% | **Phone authoring is not viable** |
| Pages that are diagram-heavy | **7 of 7 classified MIXED** | Drag is not a fallback |

### The finding that changed the design

The diagram pages' 9-11px runs are the **position labels** — `X M E Z T N W C F
SS FS`, plus short calls like `FLAT`, `HOT 1/3`, `CHEAT 1/2`. Those are exactly
what a coach wants to mask, and they are 6pt wide. Tap is therefore *desirable*
on precisely the pages where it is *hardest*.

What rescues it: those labels are **isolated** (6-30% crowded on three of the
four diagram pages) because they are scattered across a field. The prose pages
are heavily crowded (82-89%) but their crowding is overwhelmingly *vertical* —
stacked lines — and their runs are large enough not to need a tap radius at all.

### Decisions locked, round 2

8. **Tap and drag are co-equal V1 tools.** Not "tap-first with drag fallback".
   57% of sampled pages are diagram pages whose content is not text at all;
   shipping tap-only would leave the most valuable pages unauthorable. This
   supersedes §19.3's "drag is the fallback".
9. **One hit-test policy, no page-type mode switch:** point-in-box first; only
   if that misses, nearest run within a capped radius. The fallback can never
   steal a hit from a box the coach genuinely hit, so it is safe on dense prose
   and sufficient on scattered diagram labels.
10. **Classification picks the default tool and is never shown to the coach.**
    No `CLEAN_TEXT` / `MIXED` vocabulary in the UI. Derive the default from
    median run size and path count; the coach switches freely at any time.
11. **No auto-generated question prompts in V1.** Reading order never once
    reached 80%. The coach types the prompt. **The selected text still
    populates the expected answer** — that gift survives, and it was always the
    larger of the two. This supersedes §19.2's second half and the
    "auto-generated" row of §19.1's table.
12. **Desktop-first authoring is now evidence-backed, not a preference.** At
    most 8% of diagram-page runs reach a 44px touch target. §12 stands.
13. **The feature must work identically with zero detections.** Unchanged from
    §19.5, and now the explicit acceptance test for scanned playbooks.
14. **Player default is the auto-framed context view** (§20 option C), with the
    full page one tap away and an easy return. The coach never draws a second
    rectangle.

### One correction to §7 that the code survey forced

§7 says page rasters should be served "through an authenticated endpoint (or
short-lived signed URLs)" as though those were equivalent. **They are not.**

Players carry no credential at all. Every `/play` route identifies a player from
`(access_code_id, player_name)` in the request body; there is no token, no
cookie, no session. A browser cannot attach an `Authorization` header to an
`<img src>` regardless.

So for players there is exactly one workable mechanism: **opaque, expiring,
signed URLs**, with the signature covering the page, the mask set and the
granting access code. Coach-side reads can use the existing JWT. See §7a.

---

## 0. Recommendation summary

| Decision | Recommendation | Confidence |
| --- | --- | --- |
| Name | Keep **Playbook Quiz** in the UI; do **not** use "playbook" in the domain model | High |
| PDF rendering | **Server-side, once, at page level** — the editor edits the raster, never the PDF | High |
| Rasteriser | **pypdfium2** (Apache/BSD). Not PyMuPDF | High |
| Page selection step | **Remove it.** Selection is implicit in where the coach drags | High |
| Region semantics | A region has a **role** (mask / focus / crop), not just coordinates | High |
| Masking | **Server-side masked delivery**, cached. Not a CSS overlay | High |
| Playbook confidentiality | **Signed or proxied URLs.** The current public-bucket model is wrong for this | High |
| Rendering all pages on upload | **No.** Thumbnails on upload, full render on first use | High |
| Fill in the Blank | Add it — it is auto-graded short answer, and it is the dominant case | High |
| Default question type | **Fill in the Blank**, with one-click override | Medium |
| Mobile authoring | **Explicit non-goal for v1.** Players stay mobile-first | **High** (§0b) |
| Job queue | **Not yet.** Render-on-demand with a cache | Medium |
| Primary interaction | **Tap and drag, co-equal.** Not tap-first-with-fallback | **High** (§0b) |
| Hit testing | Point-in-box, else nearest run within a capped radius | **High** (§0b) |
| Auto-generated prompts | **Cut from V1.** Reading order is not reliable enough | **High** (§0b) |
| Auto-filled answers | **Keep.** The masked text is the expected answer | High |
| Player page delivery | **Signed expiring URLs.** Players have no credential | **High** (§0b, §7a) |
| Region coordinates | **Normalised 0-1**, not pinned pixels — see §4a | High |

---

## 1. Naming

**Keep "Playbook Quiz" for the coach.** It is concrete, it is what the coach
actually has in their hand, and it needs no explanation. I considered
"Install Quiz" (the real football term for teaching a play package) and
rejected it: it collides with software install, and coaches say "playbook" far
more often when talking about the document itself.

**But do not put "playbook" in the schema.** The machinery being built here —
upload a document, render pages, mask regions, generate questions — is not
about playbooks. It will serve scouting reports, opponent breakdowns, install
sheets, whiteboard photos, and film stills. Naming the tables `playbooks`
guarantees that in two years there is a `playbooks` table holding a scouting
report, or a second parallel system.

Domain names: **source document → page → region**. Product name: Playbook Quiz.
The gap between them is deliberate and worth the small translation cost.

---

## 2. Where I would change the workflow

Your flow: upload → display pages → choose pages → canvas → drag → choose type
→ enter answer.

### 2.1 Delete the page-selection step

"Choose one or more pages" is a mode the coach has to enter and exit before any
real work happens, and it asks for a decision they have not made yet — most
coaches do not know which pages they want until they are looking at them.

**Instead:** upload lands the coach in the editor with a page strip down one
side. Click a page, it opens, drag a rectangle. The page is "selected" because
they drew on it. Nothing to confirm, nothing to undo if they change their mind.

This also kills a whole class of state: no selection to persist, no "you
selected 6 pages but only used 2" reconciliation.

### 2.2 Do not ask for the question type first

For a playbook, the overwhelmingly common case is *"cover this word, make them
recall it"* — fill in the blank. Asking the coach to pick a type for every
rectangle taxes the common case to serve the rare one.

**Instead:** drag → an inline popover appears already set to Fill in the Blank
with the answer field focused → type the answer → Enter → done. Four actions,
one of which is typing the answer they were always going to type. Changing the
type is one click in the same popover, and the editor remembers the last type
used so a coach masking twelve coverage names does not re-choose twelve times.

### 2.3 The real speed win is never leaving the page

Per-question clicks matter less than context switches. The coach should draw
twelve rectangles on one page without any navigation, modal, or save step
between them. Everything happens in the popover, inline, and the page never
reloads.

That single constraint — **no navigation between questions** — is what will
make this feel fast, more than any reduction in clicks.

### 2.4 Rectangles only

I considered proposing polygons or freehand regions for irregular diagram
areas. **Rectangles are the right call** and should stay the only option:
they cover ~95% of cases, they are trivial to draw accurately with a mouse or
finger, they resize predictably, and they make masking, cropping and hit-testing
simple. Polygons can arrive later without changing anything below, because a
region is stored as a shape record, not as four numbers (§4).

---

## 3. The core decision: one render, server-side

Everything else depends on this.

### The options

**A. Render in the browser with pdf.js.** The coach edits the actual PDF page.

*Against:* the player would need the PDF too (a 200-page playbook is tens of
megabytes on a phone), and pdf.js output changes between versions — fonts
substitute, anti-aliasing shifts — so a region masked in 2026 can sit a few
pixels off in 2028. Coordinates pinned to a moving render are exactly the class
of bug this project has already fixed twice.

**B. Render server-side, and also render in the browser for editing fidelity.**

*Against:* two renderers, two results, guaranteed drift between what the coach
masked and what the player sees. The worst of both.

**C. Render server-side once, and have the editor edit *that raster*.**

### Recommendation: **C**

The coach edits a PNG of the page. The player sees the same PNG. There is
exactly one rendering, one coordinate space, and no possibility of drift.

This is the same discipline as `question_images.canvas_width` and the drawing
engine's pinned coordinate space — the third time this pattern has been the
right answer in this codebase, which is a strong signal it should be written
down as a convention rather than rediscovered.

**Cost:** the coach waits for a render before editing. Mitigated by rendering
the page they open first, at priority, and thumbnails in the background (§8).

### Rasteriser: pypdfium2

`pypdf` is already a dependency but **cannot rasterise** — it reads structure
and text, not pixels. A rasteriser must be added.

| Option | License | Deployment |
| --- | --- | --- |
| **pypdfium2** | Apache-2.0 / BSD | manylinux wheel, no system packages |
| PyMuPDF | **AGPL-3.0** or commercial | wheel |
| pdf2image + poppler | GPL binary | needs `apt install poppler-utils` |

**pypdfium2.** PyMuPDF's AGPL is a genuine hazard for a hosted product and the
commercial licence is a recurring cost for something PDFium does for free.
poppler means a system package in the Dockerfile and a subprocess per page.

**A bonus worth designing around:** PDFium exposes the text layer *with bounding
boxes*. Most modern playbooks are digital PDFs with real text, not scans. That
means the "OCR / automatic text detection" item on your roadmap may not need OCR
at all for the majority of documents — the boxes are already in the file. §16
explains how to leave that door open.

---

## 4. Data model

Four new tables. Nothing existing is migrated.

```
source_documents            the uploaded PDF, immutable
  id
  organization_id           -> multi-tenant, matches existing pattern
  uploaded_by_coach_id
  title                     defaults to filename, coach-editable
  storage_key               the PDF itself in R2
  page_count
  content_hash              sha256 - detects re-upload of the same file
  created_at

document_pages              one row per page that has ever been rendered
  id
  source_document_id
  page_number               1-based, matches what the coach sees
  image_url                 the pinned raster
  thumbnail_url
  render_width              THE coordinate space. Never recomputed.
  render_height
  render_dpi
  renderer_version          provenance, so a re-render is detectable
  created_at
  UNIQUE (source_document_id, page_number)

question_regions            the rectangle
  id
  question_id               FK, ON DELETE CASCADE
  document_page_id          FK
  shape                     'rect' - the extension point for polygons
  x, y, width, height       in the page's pinned coordinate space
  role                      'mask' | 'focus' | 'crop'      (see §5)
  style                     'solid' | 'blur' | 'outline'   (future; default solid)
  position                  ordering, for multi-region questions later
  created_at

  INDEX (document_page_id)  - "what else is on this page"
```

### 4a. Correction: regions store normalised coordinates, not pinned pixels

§4 above stores `x, y, width, height` "in the page's pinned coordinate space",
by analogy with `question_images.canvas_width`. **Store normalised 0-1 floats
instead**, with `document_pages.render_width/height` retained as the raster's
description rather than as the coordinate authority.

The analogy to `canvas_width` is imperfect in one decisive way. An annotation is
authored *against a specific raster* that can never be regenerated — the original
upload is gone once compressed. A document page raster **can always be
regenerated from the PDF**, because the PDF is kept. Pinning regions to a pixel
grid would therefore forbid something otherwise free: re-rendering a page at
higher DPI for a retina display or a print export, without moving a single
region.

Normalised coordinates keep the discipline the pinning rule exists to enforce —
a region can never drift relative to the page — while removing a restriction
that only pixel storage imposes. The pinned-space rule in `CLAUDE.md` is about
*never letting a coordinate move under a saved shape*; normalising satisfies
that more completely, not less.

This is expensive to reverse once regions exist, which is why it is called out
here rather than decided in code.

### Why regions are their own table, not columns on `questions`

Today a question has one rectangle. Your roadmap has hotspots, drag-and-drop
ordering, and multi-part questions — all of which are *several* regions on one
question. A separate table costs nothing now and makes those additive rather
than a migration.

The UI enforces one region per question in v1. The schema does not.

### How a question knows where its picture comes from

A question now has two possible sources:

- **Standard quiz:** `question_images` (an uploaded still) — unchanged
- **Playbook quiz:** `question_regions → document_pages`

That is two mechanisms for "what image does this question show", which is a
smell. I want to be honest about it rather than hide it.

**The long-term target** is one concept: an uploaded still is simply a
single-page source document, and every question points at a (page, region).
That unification is genuinely better and I would build toward it.

**I do not recommend doing it now.** It means migrating every existing
`question_images` row and touching the annotation editor, the player viewer, the
lightbox and both PDF exporters — a large, risky change that delivers no coach-
visible value. Build the new tables, keep the old path, and write the target
down. The rule while both exist: **a question has at most one of the two**,
enforced in the service layer and asserted in a test.

---

## 5. A region has a role, not just coordinates

This is the part of the brief I would most want to change.

"The coach drags rectangles over anything they want to quiz" treats the
rectangle as one thing. It is not — its meaning depends on the question type:

| Question type | What the rectangle means | What the player sees |
| --- | --- | --- |
| Fill in the Blank | **mask** — hide the answer | Page with that area covered |
| Multiple Choice | **focus** — "look here" | Page with that area outlined |
| True / False | **focus** | Page with that area outlined |
| Short Answer | **focus** (usually) | Page with that area outlined |
| Draw Response | **crop** — the area to draw on | Just that region, as the canvas |

If `role` is not modelled, the renderer has to infer intent from question type,
and that inference breaks the moment a coach wants a *masked* multiple choice
("which coverage is hidden here?") — which is a perfectly reasonable question
and one your combined-response roadmap makes likely.

Default the role from the question type; let the coach override it. One extra
column, and the feature stops being fill-in-the-blank-shaped forever.

---

## 6. Masking must happen on the server

**The brief does not address this, and it is the most consequential gap.**

If the player's browser receives the full page image and a black box is drawn
over it in CSS, then every answer in the quiz is one right-click away. For a
graded assessment that is not a rough edge; it is the quiz not working.

### Options

**A. CSS overlay.** Simplest. Trivially defeated by DevTools, "view image", or
disabling CSS.

**B. Pre-render a masked variant per question.** Secure, but duplicates the page
per question — precisely what you asked to avoid, and it multiplies storage by
the number of questions.

**C. Serve a masked render from an endpoint, keyed and cached by the mask set.**

### Recommendation: **C**

`GET /api/pages/{page_id}/render?masks={hash}` returns the page with those
regions filled, generated with Pillow (already a dependency) and cached by the
hash. The stored page stays single and unmasked; masked views are *derived*, not
duplicated — the same relationship as a flattened drawing preview to its
strokes.

This satisfies "one page, many questions" exactly: N questions on a page produce
at most N cached renders, all derived from one stored raster, all regenerable.

**Threat model, stated honestly.** These are team quizzes, not exams, and a
determined player could photograph the coach's playbook anyway. If you would
rather ship the CSS overlay and revisit, that is a defensible call — but it
should be a decision, not a default. My recommendation is server-side because
the renderer has to exist for exports regardless (§14), so the marginal cost is
small and it removes a whole category of "the quiz is cheatable" complaint.

---

## 7. A playbook is not a film still

`S3FileStorage.save_image()` returns **the bucket's public URL directly**. Every
question image today is readable by anyone who has, or guesses, the URL.

For a cropped film still that is a modest risk. For a coach's complete
playbook — every formation, every blitz, every install — it is the crown jewels
sitting on an unauthenticated URL. One shared link, one scraped bucket, and an
opponent has the season.

### Recommendation

- **The PDF itself is never publicly addressable.** It is only ever read by the
  renderer, server-side.
- **Page rasters and masked renders are served through an authenticated
  endpoint** (or short-lived signed URLs), not a public bucket path.
  **Corrected in §0b/§7a:** for players these are *not* alternatives. Players
  hold no credential, so signed URLs are the only option.
- Players get access to a page only via a valid access code and only for pages
  their quiz actually references.

This is a change in posture from the existing image model, and it is the one
place I would accept extra complexity without hesitation. Coaches will not
upload their playbook to something that leaks it, and they should not have to
ask whether it does.

It also has a pleasant side effect: an authenticated endpoint is the natural
place to apply masking (§6), so these two decisions reinforce each other.

### 7a. What "private" actually requires, given the code as it stands

Three concrete gaps the survey found, none of which the original §7 anticipated:

1. **`FileStorage` cannot store a PDF at all.** `save_image()` validates against
   `ALLOWED_IMAGE_EXTENSIONS`, recompresses through Pillow to JPEG, and returns
   `f"{public_url_base}/{key}"`. Every one of those three behaviours is wrong for
   a playbook. A private-asset path is needed alongside it — store opaque bytes,
   return a **storage key**, never a URL.

2. **`MAX_CONTENT_LENGTH` defaults to 10 MB.** A real 200-page playbook exceeds
   that comfortably. It must be raised, and PDFs need their own cap independent
   of the image cap.

3. **The R2 public hostname may serve the whole bucket.** If `R2_PUBLIC_URL_BASE`
   maps to the bucket root, then writing a playbook to a `private/` prefix in
   that same bucket leaves it publicly readable by anyone who guesses the key —
   the exact failure §7 exists to prevent. This must be settled before any
   playbook is uploaded in production: either a **separate private bucket** with
   no public binding, or verified prefix-scoped public access. This is a
   deployment fact not visible in the repo.

**Signature contents** (V1): `page_id`, mask-set hash, granting `access_code_id`,
expiry, and a **scheme version prefix**. The version prefix matters: it is what
makes the signing scheme changeable later without invalidating every URL already
in the wild.

---

## 8. Performance and storage economics

A 200-page playbook rendered at 150 DPI is roughly 1.5 MB per page — **300 MB
for one upload**, most of which no one will ever look at. Rendering it all on
upload is slow, expensive, and mostly wasted.

**Recommendation — three tiers:**

1. **On upload:** parse page count and generate **thumbnails only** (~200 px
   wide, WebP). A 200-page playbook is a few MB and renders in seconds. The page
   strip is populated immediately.
2. **On first open of a page:** render that page at full resolution, store it,
   reuse it forever. The coach waits once, for the page they actually chose.
3. **Masked variants:** derived and cached, evictable — regenerable from tier 2.

Only pages that get used ever cost real storage. A coach who uses 8 pages of a
200-page playbook stores 8 full renders and 200 thumbnails.

**Format:** playbook pages are line art and text. WebP lossless beats PNG
substantially on this content; JPEG is wrong (ringing on text). Recommend WebP
with a PNG fallback if any browser support concern arises — none is expected.

**Resolution:** 150 DPI is enough for on-screen reading and for the PDF export.
Render width should be capped the same way `MAX_CANVAS_WIDTH` caps annotation
images, and pinned per page, for the same reason.

---

## 9. Versioning: pages are immutable

Coaches revise playbooks constantly. Week 3's install is not Week 1's.

**Rule: a `document_page` is immutable once a question references it.** A
re-upload creates a *new* `source_document` with new pages. Existing questions
keep pointing at the old page and keep rendering exactly as authored.

This mirrors the drawing document's `image_version` pinning and, again, exists
so that a coach editing something today cannot silently change what a player was
asked last month — or what a completed quiz's results mean.

**`content_hash`** lets the app recognise a byte-identical re-upload and offer
to reuse the existing document instead of creating a duplicate.

**Relinking to a new version** should exist, but as an explicit, page-by-page
action a coach opts into — never automatic. Page numbers shift when a playbook
is revised, so "page 12" is not a stable identity and auto-relinking would
silently repoint questions at the wrong play.

---

## 10. Editing regions

All of this is straightforward once regions are first-class objects, which is
the main argument for §4's schema.

- **Move / resize:** drag the rectangle or its handles. Updates x/y/w/h in the
  pinned coordinate space. Because the space never changes, this is safe
  forever.
- **Delete:** removes the region *and* its question, with a confirm that names
  what is being lost ("This will delete Question 4"). A region without a
  question is meaningless; do not allow orphans.
- **Duplicate:** copy a region and its question metadata, offset slightly. This
  is the single biggest authoring accelerant for a page with eight similar
  masks, and it is nearly free to build.
- **Overlap:** allow it. Two questions can legitimately target overlapping
  areas. The editor should visually distinguish them (numbered badges), not
  prevent it.
- **Undo:** an editing surface where a mis-drag destroys work needs undo. The
  drawing board already established this expectation; a document-level undo
  stack over region create/move/resize/delete is the minimum.

**Do not let the coach see or edit coordinates.** Not in a sidebar, not in an
"advanced" panel. If the visual manipulation is right, numbers are noise; if it
is wrong, exposing numbers is a workaround rather than a fix.

---

## 11. Question types

### Fill in the Blank is the one genuinely new type

Adding a value to the `questiontype` native Postgres enum is a **one-way door** —
Postgres cannot remove one. Phase 3's `DRAW_RESPONSE` was worth that. Each
further addition needs the same justification.

**Fill in the Blank earns it, because it is not Short Answer.** The difference
is not the shape of the answer; it is *who grades it*:

- Short Answer → free text, graded by a human, `is_correct` starts NULL
- Fill in the Blank → free text matched against expected answers, **auto-graded
  at answer time**, `is_correct` set immediately

That auto-grading is the entire value proposition for a playbook quiz. A coach
masking forty play names is not going to hand-grade forty recall answers. If
Fill in the Blank were manually graded, this feature would create work rather
than save it.

**Model:**
```
questions.expected_answers   JSONB, list of acceptable strings
questions.answer_matching    'exact' | 'case_insensitive' | 'normalised'
```
Recommend `normalised` as the default: trim, collapse whitespace, case-fold.
Not fuzzy/Levenshtein matching in v1 — "Cover 3" vs "Cover 2" is one character
apart and fuzzy matching would mark it right. Multiple acceptable answers cover
real variation ("Cover 3", "C3", "Cvr 3") without guessing.

**This changes no grading vocabulary.** Auto-graded means `is_correct` is set at
answer time exactly as multiple choice already does, so `score = correct /
(correct + incorrect)` and the CORRECT/INCORRECT/NOT_GRADED/UNANSWERED
definitions are untouched. That is a deliberate constraint, and it is why I am
not proposing partial credit here either.

### 11a. The reversible alternative to the enum change

Because §18a lists the enum addition as a one-way door, the cheaper option
deserves to be on the record rather than discovered later.

**Alternative:** do not add `FILL_BLANK` at all. Give `WRITTEN` an
`expected_answers` JSONB column, and auto-grade whenever it is populated. No
enum change, no one-way door, fully reversible by dropping a column.

**Why I still recommend the enum value.** The difference between the two types
is not the shape of the answer — it is *who grades it*, and that distinction is
already load-bearing in code: `MANUALLY_GRADED_TYPES` in `models/question.py`
drives the grading queue, and `services/export.py` and
`services/player_analytics.py` both branch on it. Under the alternative, "is
this manually graded" stops being a property of the type and becomes a property
of whether a JSON column happens to be non-empty — a rule that must then be
re-derived identically in three places. That is precisely the class of
divergence `CLAUDE.md` records as the reason the grading vocabulary is defined
once.

A coach also genuinely picks between them: "I want to grade these myself" versus
"mark it right if they type the play name". Hiding that behind the presence of a
hidden field makes the UI harder, not easier.

**Recommendation: add the enum value.** But it is a real decision with a real
cost, and the alternative is viable if the preference is to keep V1 fully
reversible.

### The other four types need nothing new

Multiple Choice, True/False, Short Answer and Draw Response already exist and
work. A playbook question of those types is an ordinary question that happens to
get its image from a page region rather than an upload.

**Draw Response deserves a note:** its region has role `crop`, meaning the
drawing canvas *is* that region rather than the whole page. That composes
cleanly with the coordinate-space rules the drawing engine already enforces —
the cropped region becomes the drawing's coordinate space.

---

## 12. Mobile

**Authoring on a phone should be an explicit non-goal for v1**, and I would say
so in the UI rather than shipping something bad.

Dragging precise rectangles over small text on a 390 px screen is genuinely
unpleasant no matter how well built. The coach doing playbook prep is at a desk
or on an iPad; the phone use case is checking results, not authoring.

- **Desktop:** full editor, mouse drag, keyboard shortcuts
- **Tablet:** full editor, touch drag — worth supporting properly, coaches do use
  iPads
- **Phone:** view the quiz, view results, **do not** offer region editing

Players remain mobile-first and unaffected — they receive a page image and
answer, exactly as they do with film stills today.

---

## 13. Permissions

The existing multi-tenant model carries most of this.

- A `source_document` belongs to an **organization**, not a coach — so a
  playbook survives a coach leaving, and assistants can build from it
- Any coach in the org can create questions from it
- **Deleting a source document** must be blocked while any question references
  its pages, or refuse with a list of affected quizzes. Silently cascading would
  destroy quizzes a coach has already sent
- Players never see the document, its page list, or any page they were not asked
  about

---

## 14. Exports

The renderer built for §6 does most of this work already.

- **PDF export:** embed the masked page render for each question, via the
  existing image machinery in `export.py`. No new rendering path
- **CSV:** the question text and answer, as today. A masked region has no text
  form; a link to the rendered page is the useful cell
- **Analytics:** a playbook question is an ordinary question. Because Fill in
  the Blank is auto-graded, it flows into existing analytics untouched

Your "analytics tied to masked regions" idea is genuinely interesting and the
schema supports it for free: regions are rows with a `document_page_id`, so
"which parts of this install do players get wrong" is a join, not a redesign.

---

## 15. Scalability, and when this needs a job queue

**Not yet.** Render-on-demand with a cache avoids adding Redis and a worker to
the deployment for a feature whose peak load is one coach opening one page.

The queue becomes necessary at exactly one point on your roadmap: **"importing
an entire playbook"** — rendering 200 pages at full resolution as a batch. That
is a background job with progress, and it is the right trigger to add the
infrastructure. Building it earlier means operating a queue for a workload that
does not exist.

Render timing to expect from PDFium: single-digit-to-tens of milliseconds per
page at thumbnail size, low hundreds at 150 DPI. A 200-page thumbnail pass is a
few seconds, which is why tier 1 in §8 can be synchronous.

---

## 16. Why the future items become natural extensions

Each roadmap item and the specific hook that makes it additive:

| Future feature | What makes it easy |
| --- | --- |
| **OCR / text detection** | Regions are proposals. A detector emits candidate `question_regions` a coach accepts or rejects. **For digital PDFs no OCR is needed** — PDFium already exposes text with bounding boxes |
| **AI-assisted questions** | Same shape: a suggestion is a region plus draft question metadata, entering the same review flow. The coach always confirms |
| **Hotspots** | A region with `role='focus'` and no mask, answered by tapping. The region table already supports it |
| **Dropdowns** | Fill in the Blank with `expected_answers` presented as options rather than typed |
| **Drag-and-drop ordering** | A question with **multiple regions** and a `position` on each — already in the schema |
| **Masking styles** | The `style` column: solid, blur, outline. Renderer branch, no data change |
| **Reusable page templates** | A page is already shared across questions; a template is a saved set of regions applied to a new page |
| **Whole-playbook import** | The batch job of §15 over the existing renderer |
| **Region analytics** | A join on `question_regions.document_page_id` |
| **Polygons** | The `shape` column, with a coordinates payload replacing x/y/w/h for non-rects |

None of these requires changing what a region *is*. That is the test I applied
to the schema.

---

## 17. V1 implementation plan (approved scope)

Five milestones. Each is independently shippable and each ends in a state where
`master` is not carrying half a feature. Ordering is chosen so the two
irreversible decisions (§18a) are exercised by real data as early as possible.

**Milestone 1 — the pipeline and private delivery.** Add `pypdfium2`; a private
storage path on `FileStorage`; `source_documents` + `document_pages`; upload a
PDF, get thumbnails immediately and a full-resolution page on first open; signed
expiring URLs for delivery. **No questions, no regions.** Proves the rasteriser
on Render, the private-bucket posture and the signed-URL scheme together — the
three things that are painful to change later and cheap to change now.

**Milestone 2 — the narrowest end-to-end slice.** `question_regions`; the
`FILL_BLANK` type; drag one rectangle; auto-graded answer matching; server-side
masked render; a player answers it; it appears in Results and in analytics.
Whole-page player view for now. **Drag only, deliberately** — it is the path that
works with zero detections, so it doubles as the scanned-playbook acceptance
test.

**Milestone 3 — the authoring loop.** Text detection from the PDF layer; the tap
tool; the hybrid hit test (§0b decision 9); tool defaulting per page; the inline
popover; duplicate, move, resize, delete, undo; many questions per page without
navigation. This is where the speed promise is kept or lost, which is why it is
its own milestone rather than a corner of Milestone 2.

**Milestone 4 — the player framed context view.** Derived context window stored
on the region, `DrawingBoard` reused in view-only mode for pan/zoom, full page
one tap away, easy return. Mandatory for the feature to be usable on a phone.

**Milestone 5 — the remaining question types over regions.** Multiple Choice,
True/False, Short Answer, and Draw Response with `role='crop'` supplying the
drawing's coordinate space.

### 18a. The decisions that are expensive to reverse

Flagged explicitly because they should be deliberate, not emergent:

1. **`FILL_BLANK` added to the `questiontype` native enum.** Postgres cannot
   remove an enum value — a one-way door, the same one `DRAW_RESPONSE` went
   through. The reversible alternative is described in §11a.
2. **Normalised region coordinates (§4a).** Changing this after regions exist
   means rewriting every row against a raster that may since have been
   re-rendered.
3. **The signed-URL signature payload and TTL (§7a).** Mitigated by a scheme
   version prefix from day one, which is why that detail is specified rather
   than left to implementation.
4. **The private storage key layout.** Migrating keys later means rewriting rows
   and invalidating caches; pick the prefix scheme once.
5. **`document_pages` immutability (§9).** Relied on by every region; relaxing it
   later would silently change what past players were asked.

### 18b. Explicitly deferred, and not built in V1

Lasso bulk-create and repeat-term masking (§19.7); OCR and any AI (§19.5); auto-
generated prompts (§0b decision 11); multi-region questions; polygons; blur and
outline mask styles; the question bank; whole-playbook batch import and the job
queue (§15); region analytics (§14); the `question_images` unification (§4);
phone authoring (§12).

---

## 19. The workflow we agreed on is still too slow

You confirmed two facts that, taken together, change the primary interaction:
playbooks are **mostly digital PDFs**, and a page carries **3–15 questions**.

A digital PDF is not a picture of text. It contains every text run **with its
bounding box**, and PDFium hands them over directly. We are not guessing where
the words are — the file already says.

That makes dragging rectangles the wrong default.

### 19.1 The arithmetic

Fifteen questions on one page:

| Step | Drag flow | Tap flow |
| --- | --- | --- |
| Locate and draw the rectangle | 2–3 s | tap a highlighted word: 0.4 s |
| Type the expected answer | 4–6 s | **already known — it is the masked text** |
| Type or confirm question text | 3–5 s | 3–5 s — **see correction below** |
| Per question | **~10 s** | **~5 s** |
| **Per page (×15)** | **~2.5 min** | **~1.2 min** |

**Corrected after the spike (§0b decision 11).** The original table claimed the
question text was auto-generated, which produced ~1.5 s per question. Reading
order measured 63–77% on every real page, so generated prompts would frequently
be scrambled and the coach would be proof-reading rather than writing. The
prompt is typed in V1. Tap still roughly halves the per-page time, and it still
places the mask pixel-perfectly on the glyph boxes, which a hand-drawn rectangle
never does — but the honest number is ~1.2 min, not ~25 s.

Both beat screenshots-and-retyping by a wide margin. Only one of them is a
capability a coach tells another coach about.

### 19.2 The two free gifts in the text layer

**The answer.** If the coach masks the words `COVER 3`, the expected answer is
`Cover 3`. Asking them to type what the system just read to them is pure
ceremony. Auto-fill it; let them edit it.

**The question.** *(Deferred — see §0b decision 11. Retained because it is the
right design once reading order can be trusted, e.g. via a layout-analysis pass
or an OCR provider that emits ordered lines.)* Take the line the masked span
sits in and blank out the span:

> Page text: `Vs Trips, check to Cover 3 with the Sam walled`
> Masked span: `Cover 3`
> Generated question: **"Vs Trips, check to ______ with the Sam walled"**

That is a genuinely good fill-in-the-blank question, generated with no ML, no
OCR, and no coach typing. It reads like something a coach wrote because it *is*
something a coach wrote — it is their own playbook sentence.

The coach edits it when they want to. Most of the time they will not need to.

### 19.3 What this makes the interaction

1. Coach opens a page. Every detected text run is faintly highlighted.
2. Coach taps `COVER 3`. A question exists: answer filled, prompt generated,
   mask placed exactly on the glyph boxes — pixel-perfect, which a hand-drawn
   rectangle never is.
3. Coach taps the next one. And the next.
4. Anything the text layer missed — a diagram label, a scan, a graphic — the
   coach drags a rectangle, exactly as designed in §2.

~~**Tap is the primary interaction. Drag is the fallback.**~~

**Superseded by §0b decision 8.** Tap and drag are co-equal. The evidence showed
every sampled page is diagram-heavy, and a diagram's routes, gaps and alignments
have no text target at any quality of text layer. Drag is not there to catch
files that failed; it is there because 57% of pages hold content that is not
text. Calling it a fallback would have led to building it as one.

### 19.4 Why this is not the "AI / OCR" you deferred

It reads a data structure that is already in the file. There is no model, no
inference, no training data, no per-request cost, and nothing to be wrong about
— if the PDF says the word `COVER 3` occupies that box, it does.

The features you deferred sit cleanly on top of this and stay deferred:

- **OCR** is a second *provider* of the same detections, for scans (§19.6)
- **AI assistance** is a third: proposing *which* runs are worth quizzing, and
  better prompts. It changes the ranking, not the mechanism

### 19.5 Detection is a provider, not a feature

The extension point that makes all of the above additive:

```
RegionDetector
  detect(page) -> [ DetectedSpan { text, x, y, w, h, confidence, source } ]
```

- **V1: `PdfTextLayerDetector`** — PDFium text runs. Confidence 1.0.
- **Later: `OcrDetector`** — Tesseract or a hosted OCR, for scans. Lower
  confidence, so the UI can present those as suggestions rather than facts.
- **Later: `SuggestionRanker`** — an AI pass over detected spans scoring
  *quiz-worthiness*, so a 200-word page surfaces the twelve terms worth asking
  rather than every article and preposition.

The editor consumes `DetectedSpan`s and knows nothing about where they came
from. Adding OCR later touches one class and zero UI.

**Do not add Tesseract in V1.** It is a large system dependency for a case you
say is currently rare, and the drag flow already covers scans completely. The
UI must work identically with **zero** detections — that is the acceptance test
that keeps scans first-class rather than broken.

### 19.6 Grouping, and the granularity problem

**Spike result: the feared problem did not occur.** Chars-per-run never fell
below 3.1 on any real page, and PDFium returned whole terms — `FRONT
RESPONSIBILITIES:`, `CHEAT 1/2`, `BLITZ RB`. Merging is therefore **not required
for correctness in V1**. What the evidence did surface instead was a *geometry*
problem, not a grouping one: the runs worth tapping on diagram pages are 9–11px
wide. That is answered by the hit-test policy in §0b decision 9, not by merging.

Shift-tap to extend a selection across neighbouring runs remains worth building
for the cases where a coach wants a longer span than the file happens to
delimit. The original analysis below stands as the design for that.


PDF text runs do not align to meaning. `COVER 3` may arrive as one run, or as
`COVER` + `3`, or as part of `Vs Trips, check to COVER 3`. Tapping a fragment of
an answer is worse than drawing a rectangle.

**Recommendation:**
- Merge adjacent runs on the same baseline within a small horizontal gap into a
  single candidate span
- Let a tap select the merged span, and **shift-tap or drag-across extend the
  selection to neighbouring spans** — the text-selection interaction everyone
  already knows
- The mask is the union of the selected spans' boxes, snapped outward slightly

This is the piece most likely to feel wrong on first build, and it is the reason
for the spike in §21.

### 19.7 Bulk creation

With 3–15 per page, two accelerants pay for themselves immediately:

- **Lasso:** drag a box over a region of the page → "Create 6 fill-in-the-blanks
  from the text inside" → coach deselects any they do not want
- **Repeat term:** a playbook says `Cover 3` on nine pages. Offer "mask this term
  everywhere in this document" — one action, nine questions

### 19.8 What this does to the question text field

If prompts are generated, `questions.question_text` is no longer something the
coach writes; it is something they occasionally correct. It stays NOT NULL and
always populated — no schema change — but the editor should treat it as
derived-and-editable, and show it small rather than as the primary field.

The primary field is the answer, and usually it is already filled.

---

## 20. The problem that will actually break this: what the player sees

This is the weakness I am least comfortable with, and it is not in the brief.

A playbook page is dense — often 500+ words of small type on a page designed for
a three-ring binder. Masking one term and handing a player that full page on a
390 px phone is unusable. They will pinch, hunt for the black box, lose it, and
give up.

**The feature succeeds or fails here, not in the authoring.**

### Options

**A. Show the whole page.** Maximum context, unreadable on a phone.

**B. Crop tightly to the mask.** Readable, but a blank with no context is
unanswerable — `______` tells the player nothing.

**C. Auto-frame a context window.** Deliver a crop centred on the mask, expanded
to include enough surrounding content to make the question answerable, with the
full page one tap away.

### Decision: **C**, confirmed by the owner (§0b decision 14)

The spike reinforced it. A diagram page carries 96–232 text runs at a 9px median
width; handed whole to a 390px phone, a player cannot find the mask, let alone
read around it. The framed window is not a refinement — it is what makes the
player experience function.

### Recommendation: **C**, with the window derived, not hand-drawn

The text layer gives block and paragraph structure, so the natural context
window is **the enclosing block, padded** — the paragraph, table row, or
labelled diagram area the term sits in. That is computable at authoring time and
storable on the region:

```
question_regions
  ...
  context_x, context_y, context_width, context_height   -- nullable
```

Null means "show the whole page". Populated means "frame here, allow zoom out".

**The coach must be able to see and adjust it**, because the derived window will
sometimes be wrong — but as an adjustment of something already correct, not a
step in the creation loop. A second rectangle to draw per question would undo
every speed gain in §19.

**Reuse what exists:** the drawing board's pan/zoom already handles "framed view
of a larger image, pinch to explore" correctly on a phone, including the
two-finger arbitration. The player's page view should use that same component in
view-only mode rather than a new one.

### The related question: is a full page even the right unit?

For a **diagram** page — a formation with labels — the whole page is the
question and context is inherent. For a **text-heavy install sheet**, the page is
a container of fifteen unrelated facts and the player only ever needs one region
at a time.

This suggests the context window is not a nicety but the default rendering unit
for text-heavy pages, with whole-page as the exception. I would let real
playbooks decide that rather than guessing — see §21.

---

## 21. The spike — run, and its findings

**Status: complete.** Results are in §0b; this section is kept for the reasoning
that motivated it and for what the tooling measured.

The spike (`backend/spikes/pdf_probe.py`, disposable) measured six things per
page: object mix, chars-per-run, text-box ink density (alignment), reading-order
score, rendered run geometry, and crowding. It was validated first against five
generated fixtures covering each known failure mode — which immediately caught a
classifier bug that would have misread every formation page, since PowerPoint
draws diagrams as **vectors**, not images.

The original premise follows.

Everything above rests on an assumption I have not tested: **that the text layer
of a real football playbook is good enough to drive the interaction.**

Playbooks are frequently made in PowerPoint or Keynote and exported. Text may
arrive as clean runs, as one run per character, as outlined vector shapes with
no text at all, or as a flattened raster inside a PDF wrapper. I do not know
which, and neither the brief nor my experience settles it.

**The spike, roughly half a day, on one or two real playbooks:**

1. Extract text runs with boxes via PDFium
2. Report: how many runs per page, do boxes align to visible glyphs, do terms
   arrive whole or fragmented, and what fraction of pages have a usable layer
3. Render one page at 150 DPI and confirm the boxes overlay it correctly
4. Check a scanned page degrades to zero detections without error

**What each outcome means:**

- **Clean layer** → §19 is the primary workflow, and this feature is
  transformative rather than merely faster
- **Fragmented layer** → §19.6's merging carries the weight; still worth it, but
  the interaction needs more design
- **No usable layer** (outlined text, or all raster) → the drag flow of §2 is the
  product for V1, §19 waits for OCR, and expectations should be set accordingly

**Outcome: the first branch, with a qualification none of the three anticipated.**
The layer is clean everywhere. But "clean layer" turned out not to imply
"tappable page", because target *size* — which this list did not think to
predict — is a separate axis from text *quality*. That is the single most useful
thing the spike produced, and it is why drag ships as a co-equal tool.

This is the highest-information half-day available, and every downstream
decision — including how much authoring UI to build — depends on it.

---

## 22. Am I confident enough to build?

Honestly: **confident on the architecture, not yet on the interaction.**

**Settled, and I would build these today without expecting redesign:**

- The rendering pipeline: one server-side raster, pinned coordinate space,
  editor and player sharing it (§3)
- The data model: source document → page → region, regions as first-class rows
  with roles and an extensible shape (§4, §5)
- Server-side masking as derived-and-cached rather than duplicated (§6)
- Private-by-default storage for protected documents (§7)
- Immutability and versioning (§9)
- Fill in the Blank as an auto-graded type that leaves the grading vocabulary
  untouched (§11)
- The three-tier render/storage strategy (§8)

I have stress-tested these against your future roadmap and I cannot find an item
that forces a redesign. The `RegionDetector` seam (§19.5) is what makes OCR and
AI additive rather than structural.

**Not settled, and I would not want to build past Milestone 1 without them:**

1. **The text-layer spike (§21).** It determines whether the primary interaction
   is tap or drag. Building the drag-first editor and then discovering tap is
   right means rebuilding the editor.
2. **The player framing decision (§20).** Whole page, context window, or
   context-window-by-default. This affects the region schema (the context
   columns), the player renderer, and what the coach is asked to confirm.

**My recommendation:** run the spike, decide §20 from what it shows, then start
Milestone 1. I would expect to begin implementation within a day of having a
real playbook in hand, and I would then be building on an architecture I do not
expect to redesign.

What I would not do is start coding the editor now. It is the most expensive
surface in this feature and the one both open questions land on.

---

## 23. What I still need from you

Round 1's questions are answered; these replace them.

1. **A real playbook PDF** — one or two, as representative as possible
   (different sources if they vary). This unblocks §21 and is the single
   highest-value thing you can hand me.
2. **Player framing (§20):** whole page, or auto-framed context window with
   zoom-out? My recommendation is the context window, but you know how your
   players actually use their phones mid-week.
3. **Quiz length.** At 3–15 questions per page across several pages, a coach can
   author 50+ questions in a sitting. Is a 50-question quiz something you would
   ever send? If not, we need either a per-quiz subset or a sampling rule
   ("ask 10 of these 27"), and the schema should anticipate whichever.
4. **Does the coach ever reuse a question across quizzes** — a bank — or is each
   quiz authored fresh? §19.7's "mask this term everywhere" makes a bank more
   likely than it first appeared.
5. **Are terms consistent across a playbook?** If `Cover 3` is always written
   the same way, the repeat-term accelerant is powerful. If it is sometimes
   `Cvr 3` or `C3`, it is a nuisance.
