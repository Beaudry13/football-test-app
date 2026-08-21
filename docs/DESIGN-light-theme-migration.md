# Migrating the coach experience to light / warm neutral

**Decision (owner, Aug 2026): the target coach experience is LIGHT / WARM
NEUTRAL. Competition stays dark.**

Nothing here is implemented. This document exists so the constraints are known
before the work starts rather than discovered halfway through it.

## The headline: this is much safer than it looks

Three things are already true, and together they turn a repaint into a
bounded change:

1. **`notebook.module.css` contains no raw colour literals.** Every `--nb-*`
   value is an alias of a `--peira-*` token from `styles/tokens.css`.
2. **The aliases live on `.page`, not `:root`.** The coach theme is scoped to
   a DOM subtree, not global.
3. **Competition reads none of these tokens.** Verified by grep: zero
   `--peira-*`, zero `--nb-*`, zero `--color-*` in `pages/compete/`. It cannot
   be affected by a token change, which means "Competition stays dark" needs
   no defensive work at all.

## 1. Which global tokens change

`styles/tokens.css`, 52 tokens. The colour-bearing ones are the whole job:

| Group | Tokens |
|---|---|
| Ground | `--peira-bg`, `--color-bg`, `--peira-surface`, `--color-surface-input` |
| Text | `--peira-text`, `--peira-text-muted`, `--color-text-secondary`, `--color-text-muted-2`, `--color-text-muted-3` |
| Line | `--peira-border`, `--color-border-subtle`, `--color-border-strong` |
| Accent | `--color-accent`, `--color-accent-bright`, `--color-accent-contrast`, `--color-accent-bg` |
| Status | `--peira-success(-bg)`, `--color-warning`, `--peira-warning-bg`, `--peira-danger(-bg)`, `--color-danger-border` |
| Depth | `--shadow-sm/md/lg` |

**`--color-accent-contrast` is the trap.** It is the colour of text *on* the
gold accent. Today gold-on-dark works with a near-black contrast colour; on a
light ground the accent itself will likely need to darken, and every place
that pairs them must be re-checked, not just re-tinted.

**Shadows invert in meaning.** All 16 `rgb(0 0 0 / …)` shadows are tuned for a
dark ground where a shadow is barely visible. On a light ground the same
values read as heavy. Shadows are the most likely thing to make a converted
screen look wrong while every colour is technically correct.

**The type-scale tokens added in `24fd48e` are colour-free** and need no
attention.

## 2. Components that hardcode dark colours

Genuinely hardcoded (no token, no fallback) in coach surfaces:

| File | Value | What it is |
|---|---|---|
| `documents/RegionDraw.module.css` | `#4a9eff` ×3, `#10131a` ×2 | Region-draw highlight and its contrast text |
| `documents/DocumentPage.module.css` | `#fff` ×2 | Page surface |
| `quiz-editor/QuestionEditor.module.css` | `#fff` | Image area |
| `admin/FolderTree.module.css` | `#10131a` | Text on a warning fill |
| `components/RosterSelectPanel.module.css` | `#14110b` | Text on an accent fill |
| `components/annotation/AnnotationCanvas.module.css` | `#eee` / `#fafafa` | Transparency checkerboard — **already light, leave it** |

**The larger risk is the ~60 `var(--token, #darkfallback)` pairs.** These read
as safe and are not: `var(--nb-border, #3a3a38)` silently paints a dark border
the moment the token is missing in a context. They are landmines that only
fire in the contexts the redesign is most likely to create. Recommend a sweep
that strips dark fallbacks, or converts them to light ones, *before* the
repaint rather than after.

## 3. CSS modules that bypass tokens

By hardcoded-hex count, excluding Competition, the player pages and the
drawing engine: `RegionDraw` (5), `QuestionEditor` (5), `SharePeira` (5),
`QuestionsTab` (3), `AvailableUntil` (3), `FolderTree` (3), plus singles.

`pages/play/` (7) and `components/drawing/` (8) also carry hex — but those are
**player surfaces that are already light and stay light**. Do not sweep them
with the coach files.

## 4. Surfaces depending on rgba-white

20 occurrences of `rgba(255,255,255,…)`. Every one assumes a dark ground:
white at low alpha is how this codebase draws a subtle border or a hover fill.
**On a light ground each becomes invisible.** They are not a tint to adjust —
they must be replaced with a dark-on-light equivalent, which is a different
declaration, not a different number.

Coach-side offenders: `QuestionEditor` (3), `QuizEditorPage` (2), `Owner` (2),
`FolderTree` (2), `notebook.module.css` (2), `ResultsTab`, `DocumentPage`,
`PlayerListEditor`, and 3 in `tokens.css` itself. The 3 in Competition stay.

The `notebook.module.css` pair matters most — it is the shared table/row hover.

## 5. Images and canvases that assume dark surroundings

- **`AnnotationCanvas`** (Fabric.js) — its checkerboard is light already;
  what needs checking is whether annotation **stroke colours** chosen against
  a dark editor still read on a light one.
- **`DrawingBoard` / `DrawingViewer`** — player-side, light, unchanged. But
  `DrawingViewer` is **also used by the coach** to review a player's drawing.
  That is the one component crossing the boundary: it must look right on both
  grounds.
- **`ImageLightbox` / `PinchZoomPan`** — a lightbox conventionally uses a dark
  scrim regardless of theme. Recommend keeping it dark and deciding that
  explicitly.
- **Question images and playbook page renders** are photographs and white PDF
  pages. They currently sit on dark and will sit on light. Playbook pages will
  look *better*; film stills may need a border they did not need before.

## 6. Charts and results

There are **no chart libraries** — results are tables and text. That removes
the single most common light-theme hazard.

What does need explicit treatment: the status chips (`.badgeSuccess`,
`.badgeWarning`, `.badgeNeutral`) are tinted fills tuned for a dark ground.
The PDF already solved this problem — near-white fills, and **status always
carried by a word, never by colour alone**. Recommend the light theme adopt
the PDF's answer rather than inventing a second one.

## 7. Focus and hover states

Today: hover = a lighter fill, focus = a gold outline on dark. Both invert.
- `.trigger:hover` and `.tabActive` rely on `--color-border` against dark.
- `.titleInput:hover/:focus` sets `background: rgba(255,255,255,0.6)` — a
  **60%-alpha white fill**, which on a light ground is nearly a no-op. This is
  the clearest single example of the rgba-white problem.
- Gold focus rings need re-testing for contrast against a warm-neutral ground;
  gold on cream is a classic failure.

## 8. Third-party components

Two, and neither is a styling problem:
- **Fabric.js** — canvas drawing, colours set in JS, not CSS.
- **qrcode.react** — renders a QR. **A QR code must stay dark-on-light to
  scan.** It is already correct on a light ground; the risk was always the
  other direction.

No CSS framework, no component library, no chart library.

## 9. PDF exports — do nothing

`backend/app/services/export.py` is **already light and print-first**:
near-white tints, hairlines, no full-bleed dark panel, status carried by a
word. It is parameterised by a `PDF_THEME` dict and is not connected to the
frontend tokens at all.

**Going light brings the app into alignment with its own exports** — a coach's
screen and their printed report will finally look like the same product. This
is an argument *for* the direction, and it is free.

## 10. Player UI — do nothing

Already light, already the most phone-ready surface, and its theme lives in a
separate `:root` in `index.css`.

**Use it as the reference, not as work.** The best outcome is that the coach
theme converges on the player theme's palette and the two `:root` blocks stop
being a hazard (see Things That Will Bite You #1). Whether they should
eventually *merge* is a real decision — deliberately not taken here.

## 11. What must remain dark

1. **Competition** — the whole `/compete` surface. Structurally isolated.
2. **The image lightbox scrim** — recommend, and decide explicitly.
3. Nothing else.

## Recommended order

1. Strip or re-point the ~60 dark `var(--token, #hex)` fallbacks. Mechanical,
   testable, and defuses the landmines first.
2. Replace the 20 `rgba(255,255,255,…)` declarations with dark-on-light
   equivalents. Not a tint change — a declaration change.
3. Re-tune the 16 shadows for a light ground.
4. Flip the tokens in `tokens.css`.
5. Fix the ~15 genuinely hardcoded coach hexes.
6. Re-check `--color-accent-contrast` pairings and focus rings for contrast.
7. Verify `DrawingViewer` on both grounds; decide the lightbox.
8. Leave Competition, the player pages, the drawing engine and the PDFs alone.

## Open questions for the owner

- Should the coach and player themes eventually become **one** theme? Going
  light makes that possible for the first time, and it would remove the
  two-`:root` collision hazard permanently. It is also a bigger change than a
  repaint.
- Does the **gold accent survive** on warm neutral, or does the accent change
  as part of going light?
- Is the image lightbox dark?
