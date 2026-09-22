# Motion Lab Editor: Interaction Specification (implementation-ready)

Status: APPROVED DIRECTION, 19 September 2026. This document is the brief
for Claude Code. It supersedes the interaction sections of
`DESIGN-editor-ux.md` (which remains the rationale and the mockup record).
Where the two disagree, this document wins.

Scope: `prototypes/motion-lab/src/App.tsx` and `styles.css`. Every engine
module (`timeline.ts`, `interactions.ts`, `ball.ts`, `orientation.ts`,
`perspective.ts`, `geometry.ts`, `field.ts`, `play.ts`, `storage.ts`,
`FieldView.tsx`, `FieldMarkings.tsx`) stays as it is, with one small,
optional, sanitized schema addition noted in §7.9.

Nothing in this document is implemented yet. Do not implement from it until
asked; implement it slice by slice (§15), never as "the redesign".

---

## 1. Approved design principles

1. **Simple by default, powerful when you ask for it.** A coach builds an
   ordinary play by MOVE PLAYERS → DRAW ASSIGNMENTS → SET THE BALL → PLAY
   without opening an advanced control. Not a wizard: every step is
   available at all times.
2. **The field is the product.** No new sidebars, permanent panels or
   modals. Chrome is three fixed-height bars; popovers float over the field
   and never push it.
3. **No global Move/Draw mode.** Dragging a marker always moves the player.
   Drawing starts from the selected player's gold route handle, the Draw
   button, or D, and ends when the drag ends.
4. **One gold verb per zone.** Solid gold means "this is the action": Draw
   assignment in the strip, Play in the dock, the active segment of a
   segmented control, the current row of a menu. Present is outlined gold.
   Nothing else is gold.
5. **One waiting language.** Drawing and every field pick replace the strip
   with the same gold-edged banner: one sentence, one Cancel, Esc cancels.
6. **Football words.** "Pass to Z", "Blocks DE", "Keeps running", "Choose
   the receiver". Engine words (schedule, continue, settle, engagement,
   anchor) never appear in the UI.
7. **Timing is always one click.** Speed, After the route, Copy, Mirror,
   Rename, Remove live under More.
8. **Persistent controls are few.** At rest: 14 (top bar 8, strip 1, dock 5).
9. **Nothing removed.** Every current capability has a destination (§13).

## 2. Final layout

```
┌ TOP BAR 44 px ────────────────────────────────────────────────────────────────┐
│ PEIRA Motion Lab  [Inside Zone Rt ▾] Saved  [↶][↷]        VIEW [Overhead|Coach|Player] [Present] │
├ STRIP 44 px ──────────────────────────────────────────────────────────────────┤
│ resting:  [Formation ▾]  Drag a player to move him. Click a player to give him a job.          │
│ selected: [Z·Offense] [✎ Draw assignment] [Adjust] TIMING [Pre-snap|On snap|Delayed] [Blocks…] [More ▾]   Route · 9 yds up, then out │
│ waiting:  ▌✎ Drawing Z's assignment. Drag on the field; let go to finish.                     [Cancel Esc] │
├ FIELD ─────────────────────────────────────────────────────────────────────────┤
│ overhead board (authoring) or FieldView (Coach / Player view)                                  │
├ DOCK 56 px ───────────────────────────────────────────────────────────────────┤
│ [🏈 Set the ball ▾] │ [⟲] [▶ Play] [◁][▷] ═══════SNAP════●═══  −0.5 s  [1× ▾] │ [1st & 10 · own 35 ▾] [Display ▾] │
└───────────────────────────────────────────────────────────────────────────────┘
```

Present mode removes the strip; the top bar becomes
`PEIRA Motion Lab  Inside Zone Rt        VIEW [Overhead|Coach|Player] [✎ Draw] [Clear marks] [Exit Present]`;
the dock loses the ball control and keeps everything else.

Zone semantics: top bar = the play file; strip = who I am working with (or
the formation when nobody); dock = what happens with the ball, then watch
the play, then how the field is displayed. VIEW and Present stay in the top
bar: they are about how you are looking at the play, not about the play's
motion, and the dock has no room for them at 1280 px.

Bar heights are fixed (44 / 44 / 56). Bars never wrap, never scroll, never
clip; flexible items (play name, hint, ball sentence, route summary)
truncate with an ellipsis.

## 3. Complete editor state model

### 3.1 State axes (orthogonal; the UI is a function of all of them)

| Axis | Values | Source in App |
|---|---|---|
| `view` | overhead · coach · player | existing `view` |
| `present` | false · true | existing `present` |
| `selectedId` | player id · null | existing |
| `interaction` | idle · moving · dragging-anchor · dragging-meet-point · draw-armed · drawing · adjusting · picking(step) · choosing-viewer · telestrating | replaces `mode` + `setup` + `dragRef`; see 3.2 |
| `transport` | stopped (t = 0, not playing) · playing · paused (t > 0, not playing) | existing `time`, `playing` |
| `menu` | none · play · formation · more · blocks · ball · rate · display · situation · viewer | replaces `menuOpen` |
| `renaming` | none · play · player · formation | existing `renaming` |
| `save` | saved · saving · error | existing `savedAt`, `saveFailed` + new `saving` |
| derived | `hasAssignment(selected)`, `ballSet`, `ballKind`, `engagementOf(selected)`, `duration > 0`, `qbHasPath` | existing memos |

`interaction` is exactly one value at a time. Transitions are listed in
§3.3. `picking(step)` keeps the existing `Setup` union unchanged:
`pick-carrier`, `pick-fake`, `pick-target`, `pick-catch`, `pick-release`,
`pick-partner`, `pick-engage-point`, `copy-to`. The only new interaction
values are `draw-armed`, `drawing` and `moving` (which were implicit).

### 3.2 Invariants

- Any transition into `draw-armed`, `drawing`, `picking`, `adjusting`,
  `dragging-*` or `moving` first sets `transport = stopped` (existing rule:
  edits happen at pre-snap). Exception: `choosing-viewer` and `telestrating`
  do not touch the clock.
- Any field `pointerdown` closes an open menu (`menu = none`) before
  anything else happens (existing).
- `present = true` forces `interaction ∈ {idle, telestrating}` and
  `menu ∈ {none, rate, display, situation, viewer}`.
- `view ≠ overhead` forces `interaction ∈ {idle, choosing-viewer}`.
- A menu is never open while a banner is showing (entering any waiting
  state closes menus).

### 3.3 State table

For each state: what is visible, what changes, what is gold, what is
disabled, the instruction shown, and what Esc / empty-field click /
selecting another player / Play do. "Unchanged" means the same as RESTING.

**RESTING** (`selectedId = null`, `interaction = idle`, overhead, not present)
- Visible: top bar; strip = `[Formation ▾]` + hint; field; dock.
- Gold: active VIEW segment (Overhead); Play (solid, if duration > 0);
  "Set the ball" (outlined) when the ball is not set; Present (outlined).
- Disabled: Play, ⟲, ◁ ▷, scrub, time when `duration = 0`; ↷ when no redo;
  ↶ when no undo.
- Instruction (strip hint): "Drag a player to move him. Click a player to
  give him a job." If a ball warning exists it replaces the hint:
  "Ball: QB and RB never meet, handing off at their closest point."
- Esc: nothing. Empty-field click: nothing. Click a player: → PLAYER
  SELECTED. Play: plays if duration > 0.

**PLAYER SELECTED** (`selectedId` set, `interaction = idle`)
- Visible: strip per §4. On the field: gold selection ring, body/look
  indicator (existing), the route handle (§5.2). The handle shows whether
  or not he already has an assignment; dragging it redraws. Engage markers
  stay visible; the selected player's own marker at full opacity, others at
  0.55 (existing).
- Gold: Draw assignment (only when `!hasAssignment`); active Timing segment;
  Play; ball state as above.
- Disabled: Adjust when `!hasAssignment`; More › Copy/Mirror/Clear when
  `!hasAssignment`; More › After the route when not applicable (§8).
- Instruction: none in the strip (the strip is the instruction). Route
  summary at the right (§4.4), or "No assignment yet." when none.
- Esc: deselect → RESTING. Empty-field click: deselect. Another player:
  select him. Play: plays; selection kept.

**PLAYER BEING MOVED** (`interaction = moving`; pointer down on a marker)
- Changes: marker follows the pointer, clamped to field bounds; his path,
  catch point (if he is the target), release point (if he is the QB) and
  the second action's catch point translate with him (existing). Handle and
  ring move with him. Cursor `grabbing`.
- Transport → stopped on pointerdown.
- Esc: ignored while the pointer is down. Pointerup → PLAYER SELECTED. A
  press-release without movement is a plain selection.
- Undo: one history step per move (existing 350 ms grouping).

**DRAW ARMED** (`interaction = draw-armed`; after Draw button or D)
- Visible: banner "✎ Draw Z's assignment: drag on the field." + Cancel.
  Handle keeps showing on Z. Cursor over the board: `crosshair`.
- Gold: the banner's left rule and the player's name in it.
- Disabled: nothing else.
- Esc / Cancel: → PLAYER SELECTED. Empty-field pointerdown: → DRAWING with
  the stroke anchored at Z (draft = [Z.pos, pointer]) exactly as today's
  Draw mode. Pointerdown on another player: that player becomes selected
  and the stroke starts from him (matches today's Draw mode). Pointerdown
  on Z himself: starts the stroke from Z. Play: cancels arming, then plays.
- Menus: opening any menu cancels arming.

**DRAWING ASSIGNMENT** (`interaction = drawing`; pointer captured)
- Visible: banner "✎ Drawing Z's assignment. Let go to finish." + Cancel.
  The draft renders as the existing dashed gold polyline; other paths at
  full opacity; the handle is hidden during the stroke.
- Esc: discards the draft, keeps the previous assignment, releases capture
  → PLAYER SELECTED. (New behavior; today Esc does not cancel a stroke.)
- Pointerup: if drawn length < 1 yd → no change (accidental click);
  otherwise `simplify(draft, 0.45)` replaces the path (timing, delay, speed,
  endBehavior untouched) → PLAYER SELECTED. `pointercancel` = pointerup.
- Other players cannot be selected mid-stroke (capture). Play/keys ignored
  except Esc.

**EDITING EXISTING ASSIGNMENT / ADJUST** (`interaction = adjusting`; today's `mode = 'edit'`)
- Visible: anchors as today (`data-anchor`, start anchor omitted). Handle
  hidden. Strip: Adjust button shows active (gold-line). Banner: none.
- Drag an anchor → `dragging-anchor` (existing). Cursor `grab`/`grabbing`.
- Esc: → PLAYER SELECTED. Empty-field click: → RESTING (deselect, as
  today). Another player: select him → PLAYER SELECTED (Adjust off). Play:
  plays, anchors stay visible (existing). Draw/D/handle: leaves Adjust and
  arms/starts drawing. Delete: clears the assignment and leaves Adjust.

**WAITING FOR FIELD PICK** (`interaction = picking(step)`; generic)
- Visible: banner with the step's sentence (§11.2) + Cancel. Legal players
  get the dashed gold ring and `cursor: pointer`; players who are not
  legal dim to 0.45 except the QB (existing `dim` rule; the copy-to step
  dims nobody). During `pick-catch` / `pick-release` the target's route is
  drawn gold, other routes at 0.25, and the hover ghost follows the route
  (existing).
- Disabled: More, Blocks…, Draw, Adjust, Formation, ball button (the strip
  is replaced anyway; the dock ball button is disabled and shows the
  current sentence).
- Esc / Cancel: nothing changes in the play → the state before the pick
  (PLAYER SELECTED if a player was selected when the pick began, else
  RESTING; the `copy-to` and `pick-partner` picks return to PLAYER
  SELECTED with the source/blocker selected).
- Empty-field click: ignored, unless the step wants a point: `pick-catch`
  and `pick-release` accept a click within 3 yd of the route;
  `pick-engage-point` accepts any point (clamped). A point click that is
  not within range does nothing (no toast; the ghost already shows there is
  no target).
- Click on a legal player: advances the pick. Click on an illegal player:
  ignored (no selection change).
- Play: cancels the pick, then plays.

**WAITING FOR BALL TARGET** = picking(`pick-carrier` | `pick-fake` |
`pick-target` | `pick-catch` | `pick-release`). Details in §6.

**WAITING FOR BLOCK TARGET** = picking(`pick-partner`), and the advanced
`pick-engage-point`. Details in §7.

**PLAYING** (`transport = playing`)
- Changes: Play → `❚❚ Pause` (solid gold); scrub fill advances; time reads
  `+1.3 s`; strip and top bar unchanged; markers move; ball moves.
- Esc: nothing (does not pause). Empty-field click: deselects (and, because
  it is not an edit, does not stop playback). Click a player: selects him
  (no stop). Dragging a marker, handle, anchor or meet point: stops the
  clock at 0 first (existing "edits happen pre-snap"). Play/Space: pause.
- At the end of the play: → PAUSED at `duration` (existing).

**PAUSED** (`transport = paused`, t > 0)
- Same as PLAYING but Play reads `▶ Play` and resumes from t. Any edit
  resets to 0.

**SCRUBBING** (pointer on the range input)
- Playing stops on the first input event (existing). Time follows the
  thumb. On pointerup the slider blurs itself so ← → keys keep stepping the
  play instead of the native slider (§10).

**OVERHEAD VIEW** — the authoring view. All editing states above apply.

**COACH VIEW** (`view = coach`)
- Visible: FieldView with COACH_CAMERA; top bar; strip shows the quiet
  sentence "Watching from the sideline. Switch to Overhead to edit."; dock
  unchanged; ball button enabled (menu works; a pick switches to overhead
  automatically, see §6.8).
- Disabled: Draw, Adjust, Blocks…, More, Formation (strip is replaced).
- Esc: nothing. Field clicks: none (FieldView is display-only). Play:
  plays.

**PLAYER VIEW** (`view = player`)
- If `viewerId = null`: CHOOSING VIEWER: the overhead board stays, banner
  "👁 Click the player to watch from." + Cancel; every player is legal.
  Esc/Cancel → view = overhead. Clicking a player sets `viewerId` and
  switches to the FieldView. Selecting a player before switching (PLAYER
  SELECTED → Player) uses him as the viewer without asking (existing).
- With a viewer: strip shows `[FS chip] [Change ▾]` and "Camera rides with
  the FS." The Change menu lists both sides' players (existing viewer
  popover). Dock unchanged. Esc: nothing. Play: plays.

**PRESENT MODE** (`present = true`)
- Visible: top bar (name as text, VIEW, ✎ Draw, Clear marks, Exit Present);
  no strip; field; dock without the ball control. Hidden on the field:
  route handle, anchors, engage markers, throw diamond, requested-catch
  ghost, body/look indicator. Kept: routes, catch marker, engaged links,
  ball, telestration strokes.
- Gold: Exit Present (outlined), ✎ Draw when `telestrating`, Play.
- Disabled: nothing visible is disabled.
- Esc: if telestrating → stop telestrating; else nothing (Esc does not exit
  Present; Exit is explicit).
- Empty-field click: clears the highlighted player. Player click:
  highlights him (gold ring, no strip). Drag: does not move anyone.
- Play: plays. Telestrating: pointerdown pauses, draws a stroke; strokes are
  never saved and are discarded on Exit (existing).
- Keys: Space, R, ← →, Esc only. D/E/B/Delete/Ctrl+Z ignored.

**UNSAVED / SAVING / SAVED / SAVE ERROR** (`save`)
- Text beside the play name, 11.5 px, no icon:
  - `saving`: "Saving…" (muted) from the first edit until the write
    succeeds (set in the autosave effect, cleared in `flushSave`).
  - `saved`: "Saved" (muted).
  - `error`: "Not saved" (red, 700) with tooltip "Could not save to browser
    storage. Your changes are still on screen; copying the play name and
    rebuilding elsewhere is the only recovery." Retries on the next edit.
- Nothing else in the UI changes with save state. Present hides the text.

**MORE OPEN** (`menu = more`) — §8. Opens below the More button, left
aligned to it. Closes on: item chosen, Esc, click anywhere else, any key
that starts an interaction (D, B, Space).

**BLOCKS MENU OPEN** (`menu = blocks`) — §7.6.

**BALL MENU OPEN** (`menu = ball`) — §6. Opens upward from the dock button.

**DISPLAY MENU OPEN** (`menu = display`) — §9.6. **RATE MENU** — §9.5.
**SITUATION** — unchanged popover, now anchored to the dock chip, opens
upward. **FORMATION** — §12.

**BALL ACTION NOT CONFIGURED** (`ball = null`)
- Dock button: `🏈 Set the ball ▾` in outlined gold. Resting hint is the
  generic sentence. The ball marker sits at the C (existing "spot").

**BALL ACTION CONFIGURED** (`ball ≠ null`)
- Dock button: `🏈 Pass to Z ▾` (plain button), with a red-bordered `!`
  badge when `ballTimeline.warning` is set (tooltip = the warning). Catch
  marker, throw diamond and requested-catch ghost render as today (diamond
  and ghost hidden in Present).

**ENGAGEMENT CONFIGURED** (selected player is `a` or `b` of an engagement)
- Strip: `[Blocks DE ▾] [Releases]` replaces `[Blocks…]` (§7.6). Field: the
  × marker for his engagement at full opacity, others 0.55 (existing).

**NO ASSIGNMENT** (selected player, `path.length < 2`)
- Strip: Draw assignment solid gold; Adjust hidden (not just disabled);
  summary "No assignment yet."; More › Copy/Mirror/Clear disabled; After the
  route hidden.

## 4. Selected-player strip

### 4.1 Layout, left to right (fixed order; items never reflow)

1. **Identity chip**: `[Z]` dot in side color (offense white, defense red)
   + side word: "Offense" / "Defense". Not a button. Tooltip: the full
   label if it was truncated (labels are ≤ 4 chars, so never).
2. **Primary**: `✎ Draw assignment` (solid gold) when no assignment;
   `Redraw` (plain) when one exists. Same handler: arms drawing (§5.4).
3. **Adjust** (plain; shown only when `hasAssignment`; gold-line while
   `adjusting`). Toggles `adjusting`.
4. **TIMING** label + segment `Pre-snap | On snap | Delayed` (26 px, the
   existing `Seg size="sm"`), always present. When `Delayed` is active a
   number input `[0.5] s` appears inline after the segment (existing
   `.delay`). Changing timing does not reset the path.
5. **Blocks…** (offense) / **Engages…** (defense), or the engaged group
   (§7.6). Always present.
6. **More ▾** (plain). Always present.
7. Spacer, then **summary** (right-aligned, muted, ellipsis) per §4.4.

That is 7 controls (chip counts as none). Nothing else is ever added to the
strip. The QB's Throw point and Copy/Mirror live under More.

### 4.2 Side and position wording

Position-aware wording is used only where it improves comprehension. There
are no position-specific layouts.

| Player | Primary verb | Block verb | Summary noun | Notes |
|---|---|---|---|---|
| QB | Draw assignment | Blocks… (never useful, still allowed) | "Drop · 5 yds" when the path goes backward first; else "Path" | More gains the Throw point group when a pass is set and he has a path |
| RB / FB / H | Draw assignment | Blocks… | "Path" when the ball is handed/pitched to him, "Route" otherwise | — |
| WR / X / Z / TE (Y) | Draw assignment | Blocks… | "Route" | — |
| OL (LT LG C RG RT) | Draw assignment | Blocks… | "Path" | After the route hidden when he never carries (existing condition covers it) |
| DL / LB / DB / NB / FS / SS | Draw assignment | Engages… | "Path" | — |

The noun is chosen by: defense → "Path"; offense with the ball ending in
his hands (handoff/pitch target, or QB keep) → "Path"; offense whose first
segment goes toward the LOS from the backfield (QB drop) → "Drop";
otherwise → "Route". Unknown labels (custom players) follow side.

### 4.3 Buttons and states

| Control | Idle | Hover | Active/on | Disabled |
|---|---|---|---|---|
| Draw assignment (none yet) | solid gold | gold 92% | pressed: gold 85% | never |
| Redraw / Adjust / Blocks… / More | plain (`#1e2126`, 1 px border) | `#262a30` | Adjust on: gold-line | 40% opacity |
| Timing segment | plain | `#262a30` | active: solid gold | never |

### 4.4 Summary (right end)

Derived every render from the drawn schedule; never stored.

- No path: "No assignment yet."
- Path: `<Noun> · <length> yds <shape> · <timing if not On snap> · <speed if not the position default>`
  - length = rounded drawn length in yards.
  - shape: from the first and last segment directions (`endDirection` and
    the first anchor pair): "up" (mostly +y), "back" (mostly −y), "across"
    (mostly lateral), and a second word when a break ≥ 60° exists: "up, then
    out" (lateral away from the C), "up, then in", "up, then back". Keep
    the vocabulary to up / back / across / out / in.
  - timing: "pre-snap" or "delayed 0.5 s".
  - speed: "controlled" / "fast" only when it differs from
    `defaultSpeed(label)`.
- Engaged: append " · blocks DE" / " · engages Z"; " · releases" when
  `release === selectedId`.
- Ball: when he is the ball target: " · gets the handoff" / " · gets the
  pitch" / " · catches it 9 yds downfield".
- Examples: "Route · 9 yds up, then out", "Drop · 5 yds back", "Path · 3 yds
  up · blocks DE · releases", "Path · 12 yds across · pre-snap".

### 4.5 Delete / clear

- `Delete` / `Backspace` with a player selected and no menu open: clears
  his assignment (path only; timing/speed/end untouched). No confirmation;
  one undo step. If he has no assignment the key does nothing.
- More › Clear assignment does the same.
- Clearing a path that a pass depends on: see §12.5.

## 5. Drawing interaction

### 5.1 The four entry points and the one rule

| Gesture | Meaning | Precondition |
|---|---|---|
| Drag a marker (`data-player`) | Move the player | always (not in Present, not during a pick) |
| Drag the gold route handle (`data-handle`) | Draw the selected player's assignment | a player is selected |
| Click **Draw assignment / Redraw** | Arm drawing (next drag on the field draws) | a player is selected |
| Press **D** | Arm drawing | a player is selected; otherwise the key does nothing and the resting hint flashes once (§12.2) |

Rule: the pointer target decides. Marker = move. Handle = draw. Anything
else on the board while armed = draw from the selected player. There is no
stored mode that changes what a marker drag means.

### 5.2 Route handle geometry

- Rendered inside the selected player's `<g data-player>` so it moves with
  him, as a sibling group `<g data-handle>` after the label.
- Shape: a 4 px gold stub from radius 19 px to 44 px (viewBox units), then
  a 14 px arrowhead; hit area: an invisible rect 28 px wide from radius 16
  to 58 px, plus a 14 px circle at the tip. `cursor: crosshair` on the hit
  area. On `(pointer: coarse)` the hit rect is 40 px wide.
- Direction: +y (downfield, screen up) for both sides, unless the player's
  y > Y_MAX − 2.5 yd (then −y) or y < Y_MIN + 2.5 yd (then +y).
- Visible only when: overhead view, not Present, `interaction ∈ {idle,
  draw-armed}`. Hidden while moving (the ring still moves), drawing,
  adjusting, picking, and in Present.
- Pulse (opacity 1 → 0.45 → 1, 1.4 s) until the first successful draw of
  the session (`sessionStorage['peira.motionlab.drewOnce'] = '1'`); then
  static. `prefers-reduced-motion`: no pulse.

### 5.3 Cursor and visual state

| State | Board cursor | Marker cursor | Banner | Draft |
|---|---|---|---|---|
| idle | default | grab | none | none |
| moving | grabbing | grabbing | none | none |
| draw-armed | crosshair | crosshair | "✎ Draw Z's assignment: drag on the field." | none |
| drawing | crosshair | crosshair | "✎ Drawing Z's assignment. Let go to finish." | dashed gold polyline from Z |
| adjusting | default | grab | none | anchors |

The board gets a class per interaction (`board-idle`, `board-armed`,
`board-drawing`, `board-adjusting`, `board-picking`, `board-present`,
`board-tele`) and CSS sets the cursors; no inline cursor styles.

### 5.4 Arming

- `Draw assignment`/`Redraw`/`D` → `interaction = draw-armed`, close menus,
  transport → stopped, leave Adjust if on.
- While armed, the first `pointerdown` on the board (any target except a
  meet-point marker or an anchor, which do not exist in this state) starts
  the stroke: `draft = [selectedPlayer.pos, clamp(pointer)]`, pointer
  captured → `drawing`. If the pointerdown is on a different marker, select
  that player first and start from him (today's Draw-mode behavior, kept).
- Arming is cancelled by: Esc, Cancel, opening a menu, Space/Play, view
  change, Present, selecting via the Formation menu, undo/redo.

### 5.5 The stroke

- Sampling: append a point when it is ≥ 0.15 yd from the last (existing
  `MIN_SAMPLE_GAP`), clamped to field bounds (existing `clampToField`).
  Leaving the SVG does not end the stroke (pointer capture); points keep
  clamping to the field edge, so a drag outside the field draws along the
  boundary.
- Preview: dashed gold polyline, width 4, opacity 0.9 (existing draft
  style). The player's previous route stays visible at 0.25 opacity under
  the draft so a redraw is comparable.
- Completion (`pointerup` / `pointercancel`): drawn length < 1 yd → discard
  (accidental click; previous route kept; no toast). Else
  `simplify(draft, 0.45)` becomes `path`; `interaction = idle`; selection
  kept; handle reappears; strip returns to PLAYER SELECTED with Redraw +
  Adjust; summary updates. Mark `drewOnce`.
- Cancellation: Esc during the stroke discards the draft and releases
  capture. Window `blur` during a stroke = cancel.
- Replacing: any completed stroke replaces the whole path. No merge, no
  append. Undo restores the previous path in one step.
- Switching players during a stroke is impossible (capture). During
  `draw-armed`, clicking another marker re-targets the arm (§5.4).
- Timing/speed/end behavior are never changed by drawing. The pass catch
  point, if this player is the target, is re-projected by the engine on the
  next render (existing behavior; §12.5 covers the warning).

### 5.6 Adjust (edit anchors)

Unchanged mechanics: anchors 1..n draggable (`data-anchor`), start anchor is
the player. Entered by Adjust or E; exited per §3.3. Dragging an anchor
resets the clock. Undo per drag. The handle is hidden while adjusting to
avoid two gold affordances on one player.

### 5.7 Touch and trackpad

- Pointer events only (already); `touch-action: none` on the board (already).
- Trackpad: a click-drag on the handle is the same as a mouse. Tap without
  movement on the handle = nothing (0 yd stroke).
- Touch: handle hit area widens (§5.2). Long-press does nothing special.
  Two-finger gestures are not handled (no pan/zoom in the editor).

### 5.8 Removal of `mode`

`mode: 'move' | 'draw' | 'edit'` is replaced by `interaction`. The `V` key
and the Move/Draw segment are removed. `E` toggles `adjusting`. Every
`mode === 'draw'` branch becomes `interaction === 'draw-armed'` /
`'drawing'`; every `mode === 'edit'` becomes `'adjusting'`.

## 6. Ball action

### 6.1 The control

Dock, far left, before a 1 px divider: `🏈 <sentence> ▾`.
- Unset: `Set the ball`, outlined gold (`.gold-line`).
- Set: the sentence (§6.2), plain button; max width 240 px, ellipsis, full
  sentence in the tooltip. A `!` badge (red border) when the timeline has a
  warning; tooltip = the warning sentence.
- Disabled while `interaction = picking` or `drawing`, and in Present
  (hidden entirely in Present).
- `B` toggles the menu (existing).

### 6.2 Sentences (`summarize` rewritten; engine unchanged)

| Ball | Sentence |
|---|---|
| null | Set the ball |
| keep | QB keeps it |
| handoff | Handoff to RB |
| pitch | Pitch to H |
| pass | Pass to Z |
| play-action | Play action to RB, pass to Z |
| + then handoff | …, then hand off to X |
| + then pitch | …, then pitch to H |
| + then pass | …, then throw to Z |

Names are the players' labels. Never "→", never "Ball:".

### 6.3 Menu (opens upward, min width 320 px)

When unset:
```
WHAT HAPPENS WITH THE BALL?
  QB keeps it
  Handoff to…
  Pitch to…
  Pass to…
  Play action: fake, then pass…
```
When set:
```
Now: Pass to Z, caught 9 yds downfield. QB holds 0.6 s at the top of his drop for Z's timing.   ← "Now" card
CHANGE TO
  QB keeps it · Handoff to… · Pitch to… · Pass to… · Play action…          (current kind shown with a ● dot)
THEN…                                             (hidden when kind = keep)
  Then hand off to…
  Then pitch to…
  Then throw to…
  Clear the second action                          (only when ballThen exists)
ADVANCED ▸                                        (only when a pass/PA is set AND the QB has a path)
  Throw point: end of drop        [Set on field…]
  or: Throw point: set by you     [Use end of drop]
Clear the ball                                    (red)
```
- The "Now" card sentence = §6.2 sentence + catch depth for passes ("caught
  9 yds downfield" from `catchPoint.y`) + the existing hold/early sentence
  or warning if any.
- ADVANCED is a disclosure, collapsed by default, state remembered for the
  session. It contains only the throw point. The play-action fake target is
  changed by choosing Play action again.
- Choosing any "Change to" item runs the same flow as first-time setup and,
  if `ballThen` exists, clears it with the existing toast "Second action
  cleared, the first action changed."

### 6.4 Flows (immediately after each choice)

**KEEP** → ball = keep instantly; menu closes; button "QB keeps it"; the QB
keeps the ball on his own path (engine). No pick.

**HANDOFF** → banner "🏈 Handoff. Choose who gets the ball." Legal: offense
except the QB (existing `pickable`). Click → ball = handoff; button "Handoff
to RB"; state returns to what it was before the menu (selection kept).

**PITCH / TOSS** → banner "🏈 Pitch. Choose who gets the ball." Same
legality. → "Pitch to H". If the pitch window cannot be met the existing
warning appears as the `!` badge and in the resting hint; the ball still
goes at the closest point (engine).

**PASS** → banner "🏈 Pass. Choose the receiver." Legal: offense except the
QB. Then:
- Receiver has a route → banner "🏈 Pass to Z. Click where on his route the
  ball arrives." with the route gold, the hover ghost on the route, other
  routes dimmed. A click within 3 yd of the route completes: ball = pass;
  button "Pass to Z". If the engine moves the catch for timing the existing
  toast "Catch adjusted for timing" appears and the ghost of the requested
  point stays on the field.
- Receiver has no route → completes immediately with the catch at his
  alignment (existing) and a toast: "Z has no route, so he catches it where
  he stands. Draw his route, then set the catch point again."

**PLAY ACTION** → banner "🏈 Play action. Choose who the QB fakes to." Legal:
offense except the QB. Then banner "🏈 Faking to RB. Now choose the
receiver." (RB not legal.) Then the catch-point step as PASS. Button "Play
action to RB, pass to Z".

**THROW FROM HERE** (Advanced › Set on field…) → banner "🏈 Click where on
the QB's path he throws from." The QB's path is drawn gold; hover ghost on
it; click within 3 yd sets `releasePoint`; the diamond turns blue-filled
(existing "set by you" style). Use end of drop clears it. Also reachable
from QB › More › Throw point (same two items). Only offered when the ball
is a pass or play action and the QB has a path (existing `canPickRelease`).

**TWO-STEP CHAIN (Then…)** → banners are prefixed with the current carrier:
"🏈 Then RB hands off. Choose who gets it." / "🏈 Then H pitches. Choose who
gets it." / "🏈 Then RB throws. Choose the receiver." then the catch step
"🏈 Then RB throws to Z. Click where on his route the ball arrives." Legal:
offense, not the carrier, not the QB (existing rule). Button gains ", then
pitch to H". If the first action never transfers, the engine skips the
second and the existing warning sentence shows.

### 6.5 Unset / partial / complete

- Unset: `ball = null`. Button outlined gold. Field shows the ball at the C.
- Partial: never stored. Cancelling any step (Esc, Cancel, Play, view
  change) leaves `ball` exactly as it was before the menu was opened. The
  banner is the only sign a pick is in progress.
- Complete: as §6.2. The `!` badge is the only "attention" state; there is
  no separate "needs a route" state.

### 6.6 Clearing

"Clear the ball" (red, bottom of the menu) sets `ball = null` and
`ballThen = null`, resets the clock, closes the menu. Undoable.

### 6.7 What happens on the field during ball picks

Unchanged from today: dashed rings on legal players, 0.45 opacity on the
others (QB never dims), route highlighting during the catch/release steps,
hover ghost, catch marker after completion, requested-catch ghost when
adjusted, throw diamond (derived = dark, manual = blue).

### 6.8 Ball menu from Coach / Player view

The menu opens (it is in the dock). Choosing an item that needs a field
pick switches `view` to overhead first, then shows the banner. Choosing
"QB keeps it" or "Clear the ball" needs no switch.

## 7. Block / Engage

### 7.1 Vocabulary

Offense: "Blocks…", "Blocks DE", "Releases". Defense: "Engages…", "Engages
Z", "Releases". The stored object is still an `Engagement {a, b, point,
release?}` with `a` = the player who started it.

### 7.2 Starting (blocker selection)

The blocker is the selected player. `Blocks…` in the strip → banner
"Choose the defender Z blocks." (defense: "Choose who DE engages."). Legal:
players on the other side who are not already in an engagement. Same-side
players and already-engaged players are not legal (dimmed, no ring). If no
legal player exists the button is disabled with tooltip "Every defender is
already engaged."

### 7.3 Defender selection and the inferred meet point

Click a legal defender → the engagement is created immediately with
`point` =
1. the last anchor of the blocker's path, if he has one (`path.length ≥ 2`);
2. otherwise the midpoint between the two men's alignments;
clamped to field bounds; `auto = true` (§7.9).

Then: blocker stays selected; strip shows the engaged group (§7.6); the ×
marker appears at the point (existing `data-engage`, draggable); toast (once
per engagement): "Z blocks DE where his path ends. Drag the × to move it."
(no-path case: "Z blocks DE halfway to him. Drag the × to move it, or draw
Z's path.")

### 7.4 Overriding the meet point

- Drag the × marker (existing `dragging-meet-point`). Sets `auto = false`.
- Or `Blocks DE ▾ › Move the meeting point…` → banner "Click where Z and DE
  meet." (the existing `pick-engage-point` step) → click sets the point and
  `auto = false`.

### 7.5 Engage-only and engage → release

- Engage-only is the default: both players hold at the point (engine).
- `Releases` toggle in the strip (`release = selectedId`; active reads
  "Releases ✓"). Tooltip: "Comes off after a moment and continues his own
  path." Only the selected player's release is set from his strip; select
  the other man to make him the one who releases. Setting it on one clears
  it on the other (one `release` field).

### 7.6 Engaged strip group

Replaces `Blocks…`:
`[Blocks DE ▾] [Releases]` (+ red `!` before the group when
`derived.valid = false`, tooltip = the existing warning sentence).
`Blocks DE ▾` menu:
```
Change the defender…        → banner as §7.2; on pick, replaces b, re-infers the point if auto
Move the meeting point…     → §7.4
Remove the block            (red)
```

### 7.7 Clearing / changing

- Remove the block: deletes the engagement; strip returns to `Blocks…`;
  undoable.
- Change the defender: keeps the engagement id and release, replaces `b`.
- Removing a player removes his engagements with the existing toast.

### 7.8 Blocker has no path

Allowed (§7.3 case 2). If the engine reports the point unreachable, the `!`
shows with its sentence, and the summary ends "· can't reach the block".
The coach fixes it by drawing a path (the point re-infers if `auto`) or
dragging the ×.

### 7.9 Paths edited later (`auto` flag)

Add `auto?: boolean` to `Engagement` (optional; `sanitizePlay` defaults it
to `false` when missing or not boolean; `SCHEMA_VERSION` stays 1 because
readers tolerate the absence). Rules:
- When the blocker's path is redrawn, adjusted (anchor drag ends) or
  cleared, and `auto === true`, recompute the point per §7.3.
- Dragging the marker or picking a point sets `auto = false`.
- The defender's path changes never move the point.
- Engagements created by "Move the meeting point" or by dragging are
  `auto = false`. Legacy engagements load as `false`.

## 8. More menu

Opens below More, left-aligned, min width 280 px, grouped with uppercase
group titles and 1 px rules. Exactly these items, in this order:

```
HOW HE RUNS IT
  Speed          [Controlled | Normal | Fast]              segmented, inline
  After the route  ● Keeps running (auto)  ○ Stops           only for offense, not QB, with a path (existing condition)
ASSIGNMENT
  Copy his assignment to…                                   disabled without a path
  Mirror his assignment to…                                 disabled without a path
  Clear assignment                          Delete          disabled without a path
THROW POINT                                                only for the QB when a pass/PA is set and he has a path
  Set on field…  /  Use end of drop                         (the second only when releasePoint exists)
PLAYER
  Rename…
  Remove from play                                          red
```

Wording for After the route: "Keeps running (auto)" when `endBehavior` is
undefined and `resolveEnd` says continue; "Stops (auto)" when auto resolves
to settle; the coach's explicit choice shows without "(auto)". Choosing the
auto-matching option clears the override (stores `undefined`).

Not in More, on purpose: Blocks (strip, constant), Timing (strip), body and
look (derived, no control), Then… (ball menu), Situation (dock).

Rename opens the inline field in the chip position (existing `InlineName`).
Remove asks no confirmation (undoable) and shows the existing toast.

## 9. Playback dock

Left to right:

| # | Control | Reads | Behavior |
|---|---|---|---|
| 1 | Ball | §6.1 | opens the ball menu upward |
| — | divider | | |
| 2 | ⟲ Restart (icon, 30 px, tooltip "Restart · R") | | if playing: jump to 0 and keep playing; else: set time 0 (stopped). Disabled when duration = 0. Replaces today's Reset + Restart |
| 3 | Play (36 px, solid gold, 18 px side padding) | `▶ Play` / `❚❚ Pause` | toggle; at the end, Play restarts. Disabled when duration = 0 |
| 4 | ◁ (icon) | | pause, time = max(0, t − 0.1) |
| 5 | ▷ (icon) | | pause, time = min(duration, t + 0.1) |
| 6 | Scrub (flex 1, min 160 px) | | range 0..duration step 0.01; SNAP tick (blue, 2 px, label above) at `snapAt`; gold fill to the thumb; thumb 15 px gold. Input blurs on pointerup |
| 7 | Time (96 px, tabular) | `−0.5 s` / `+1.3 s` | `fmtRel(time)`; `—` when duration = 0 |
| 8 | Rate pill | `1× ▾` | popover: 0.5× · 1× · 1.5× (current ●). Tooltip "Playback rate" |
| — | divider | | |
| 9 | Situation chip | `1st & 10 · own 35 ▾` | existing popover, opens upward |
| 10 | Display ▾ | | §9.6 |

Resting: Play enabled iff duration > 0; time `−0.5 s` (pre-snap) or `—`.
Playing: Play → Pause (still solid gold), fill advances, SNAP tick stays,
time counts. From across a room: the only large gold thing in the dock is
Play/Pause, and the gold fill length is the progress.

VIEW (Overhead | Coach | Player, with a small VIEW label) and Present stay
in the top bar (§2). They are not in the dock.

### 9.5 Rate popover
Three rows; choosing closes. `R` is Restart, not rate.

### 9.6 Display popover
```
PATHS      [All | Offense | Defense | None]     (existing filter; stored with the play)
Labels                 ✓                        (existing showLabels; session only)
Field markings         ✓                        (existing situation.show; stored with the play; removed from the Situation popover)
```

## 10. Keyboard shortcuts

Ignored when focus is in `input`, `textarea` or `[contenteditable]`, and
when a modifier other than Shift is held (except the undo/redo chords).
Toolbar buttons call `blur()` on click so Space never re-triggers the last
button.

| Key | Action | When |
|---|---|---|
| Space | Play / Pause | duration > 0; cancels draw-armed or a pick first |
| D | Arm drawing for the selected player | a player is selected; overhead; not Present |
| E | Toggle Adjust | selected player has a path |
| B | Toggle the ball menu | not Present; not picking |
| Delete / Backspace | Clear the selected player's assignment | selected; not Present; no menu open |
| Esc | Cancel / back (precedence §10.1) | always |
| R | Restart | duration > 0 |
| ← / → | Step −0.1 s / +0.1 s (Shift: 0.5 s) | duration > 0; Present too |
| Ctrl/Cmd + Z | Undo | not Present |
| Ctrl/Cmd + Shift + Z, Ctrl + Y | Redo | not Present |

Removed: `V` (no move mode). Not added: number keys for views, P for
Present, Enter to confirm (nothing needs confirming).

### 10.1 Esc precedence (first match wins)
renaming → open menu → telestrating → drawing (discard draft) → draw-armed
→ picking (cancel) → adjusting → choosing-viewer (back to Overhead) →
selected (deselect) → nothing.

### 10.2 Browser conflicts
Space and arrows call `preventDefault` only when handled (so page scrolling
never happens inside the app anyway; `body` has `overflow: hidden`). Ctrl+Z
inside an input is left to the browser. Backspace outside inputs is
prevented (no history navigation).

## 11. Microcopy

### 11.1 Persistent labels
- Top bar: `PEIRA Motion Lab`, play name, `Saved` / `Saving…` / `Not saved`,
  `↶` (tooltip "Undo · Ctrl+Z"), `↷` ("Redo · Ctrl+Shift+Z"), `VIEW`,
  `Overhead` `Coach` `Player`, `Present` (tooltip "Hide the tools and
  teach").
- Strip resting: `Formation ▾`; hint "Drag a player to move him. Click a
  player to give him a job."
- Strip selected: `✎ Draw assignment` (tooltip "Draw what he does · D"),
  `Redraw`, `Adjust` ("Move the points of his route · E"), `TIMING`,
  `Pre-snap` `On snap` `Delayed`, `Blocks…` / `Engages…`, `More ▾`.
- Dock: `Set the ball`, `⟲` ("Restart · R"), `▶ Play` ("Play · Space"),
  `❚❚ Pause`, `◁` ("Back 0.1 s · ←"), `▷` ("Forward 0.1 s · →"), `1× ▾`,
  situation chip, `Display ▾`.
- Present: `✎ Draw` ("Draw on the field while paused"), `Clear marks`,
  `Exit Present`.

### 11.2 Banners (waiting states)
| State | Sentence |
|---|---|
| draw-armed | ✎ Draw **Z**'s assignment: drag on the field. |
| drawing | ✎ Drawing **Z**'s assignment. Let go to finish. |
| pick-carrier handoff | 🏈 Handoff. **Choose who gets the ball.** |
| pick-carrier pitch | 🏈 Pitch. **Choose who gets the ball.** |
| pick-target pass | 🏈 Pass. **Choose the receiver.** |
| pick-fake | 🏈 Play action. **Choose who the QB fakes to.** |
| pick-target after fake | 🏈 Faking to **RB**. Now **choose the receiver.** |
| pick-catch | 🏈 Pass to **Z**. **Click where on his route the ball arrives.** |
| pick-release | 🏈 **Click where on the QB's path he throws from.** |
| then variants | 🏈 Then **RB** hands off. **Choose who gets it.** / Then **H** pitches. **Choose who gets it.** / Then **RB** throws. **Choose the receiver.** / Then **RB** throws to **Z**. **Click where on his route the ball arrives.** |
| pick-partner (offense) | **Choose the defender Z blocks.** |
| pick-partner (defense) | **Choose who DE engages.** |
| pick-engage-point | **Click where Z and DE meet.** |
| copy-to | ⧉ Copy **Z**'s assignment. **Click the player who gets it.** |
| copy-to mirror | ⧉ Mirror **Z**'s assignment. **Click the player who gets it.** |
| choosing-viewer | 👁 **Click the player to watch from.** |
| telestrating | ✎ Draw on the field while paused. **Esc** to stop. |
Every banner ends with a `Cancel` button whose tooltip is "Cancel · Esc".

### 11.3 Toasts (existing 2.6 s toast)
- "Catch adjusted for timing" (existing)
- "Second action cleared, the first action changed." (existing wording tidied)
- "Z has no route, so he catches it where he stands. Draw his route, then set the catch point again."
- "Z blocks DE where his path ends. Drag the × to move it."
- "Z blocks DE halfway to him. Drag the × to move it, or draw Z's path."
- "F removed. His ball action went with him." (existing)
- "Formation "Trips Rt" saved." / "Formation "Trips Rt" loaded. Assignments and the ball were cleared." (renamed from Look)
- "Browser storage is unavailable. Plays will not be saved." (existing)

### 11.4 Hints in the strip (resting only)
- Default: "Drag a player to move him. Click a player to give him a job."
- Ball warning present: the warning sentence, prefixed "Ball: ".
- Ball hold/early: "QB holds 0.6 s at the top of his drop for Z's timing." (existing sentences)

## 12. Error and edge states

1. **No player selected, D pressed / Draw needed:** the key does nothing;
   the resting hint text flashes gold once (200 ms) to draw the eye. No
   toast.
2. **Draw with no player** (Draw button is only rendered when a player is
   selected, so this cannot happen from the UI).
3. **Pass with no eligible receiver** (only the QB on offense): the Pass /
   Handoff / Pitch / Play action items are disabled with tooltip "Add an
   offensive player first." Keep stays enabled.
4. **Engagement target removed:** the engagement is deleted with the
   existing toast; the blocker's strip returns to `Blocks…`.
5. **Selected player removed:** selection cleared; strip → resting; viewer
   cleared if he was the viewer (existing).
6. **Route cleared or redrawn while the ball references it:** the engine
   re-projects the catch point on the next render. If the receiver now has
   no route the catch is at his alignment and the `!` badge does not
   appear (that is valid); the strip summary for him reads "· catches it
   where he stands". If the projection moves the catch, the existing
   "Catch adjusted for timing" toast fires. Nothing is deleted
   automatically.
7. **Invalid or unfinished field pick:** clicking off-route in a
   catch/release step does nothing (the hover ghost already shows the
   nearest legal point when within 3 yd). Clicking an illegal player does
   nothing. Only Esc/Cancel/Play/view change end the pick.
8. **Save failure:** "Not saved" per §3.3; the next edit retries; the
   startup toast covers storage being unavailable entirely.
9. **Conflict from another tab/session:** out of scope for persistence
   changes. Presentation only: on `visibilitychange` to visible, if the
   stored `updatedAt` of the current play is newer than the one this tab
   last wrote, show a non-blocking notice bar under the top bar: "This play
   was changed in another tab. [Reload it] [Keep mine]". Keep mine
   overwrites on the next save. (Optional, P2, no schema change.)
10. **Play deleted elsewhere:** if a save finds the current id missing from
    storage, it re-adds it (current behavior of `savePlay`). No UI.
11. **Player view with the viewer removed:** falls back to choosing-viewer.
12. **Blocks… with every defender engaged:** button disabled, tooltip per
    §7.2.

## 13. Before → after control map

Every control in today's `App.tsx`. "Removed" always says where the
capability lives instead.

| Current control | Current location | New location | Visible when | Notes |
|---|---|---|---|---|
| Brand | top bar | top bar | always | unchanged |
| Play name ▾ | top bar | top bar | always (text only in Present) | menu below |
| Play menu › Rename… | play menu | play menu | menu open | unchanged |
| Play menu › New play (this look) | play menu | play menu › New play (this formation) | menu open | renamed |
| Play menu › Duplicate | play menu | play menu | menu open | unchanged |
| Play menu › Delete play | play menu | play menu (last, red) | menu open | confirm kept |
| Play menu › Open list | play menu | play menu | menu open | unchanged |
| Saved / Not saved | top bar | top bar | not Present | adds Saving… |
| ↶ ↷ | top bar | top bar | not Present | tooltips carry keys |
| Top-bar hint | top bar | removed | — | the strip hint and banners carry all instructions |
| View seg Overhead/Coach/Player | top bar | top bar with VIEW label | always | unchanged behavior |
| Move / Draw seg (V, D) | top bar | removed | — | move = drag a marker; draw = handle / Draw button / D (§5) |
| 🏈 Ball button | top bar | dock, far left | not Present | sentence form |
| Ball › QB Keep | ball popover | ball menu › QB keeps it | menu | |
| Ball › Handoff… / Pitch… / Pass… / Play Action… | ball popover | ball menu, same order | menu | renamed per §6.3 |
| Ball › Throw point › Throw from here… / Use default | ball popover | ball menu › Advanced ▸, and QB › More › Throw point | pass/PA set + QB path | |
| Ball › Then… › Handoff… / Pitch… / Pass… | ball popover | ball menu › Then… | ball set, not keep | |
| Ball › Clear second action | ball popover | ball menu › Clear the second action | ballThen exists | |
| Ball › Clear ball action | ball popover | ball menu › Clear the ball | ball set | |
| Present | top bar (solid gold) | top bar (outlined gold) | not Present | |
| Players ▾ › Add offensive / defensive player | context row | strip › Formation ▾ › Add player | resting | |
| Players ▾ › counts line | context row | Formation ▾ footer | resting | |
| Look ▾ › Save look… | context row | Formation ▾ › Save this formation… | resting | renamed |
| Look ▾ › Load / New play / × | context row | Formation ▾ › Saved formations rows | resting | renamed |
| Situation chip + popover | context row (resting) and Present | dock, right group | always incl. Present | Markings toggle moves to Display |
| Situation › Markings Shown/Hidden | situation popover | Display ▾ › Field markings | always | same `situation.show` |
| Resting hint | context row | strip | resting | |
| Player chip ▾ › Rename… / Remove from play | context row (selected) | More › PLAYER group | selected | chip is no longer a button |
| Timing seg + delay input | context row | strip | selected | unchanged |
| Speed seg | context row | More › HOW HE RUNS IT | selected | |
| End seg Auto/Continue/Settle | context row | More › After the route | selected, offense non-QB with path | reworded |
| Assignment ▾ › Draw path | context row | strip › Draw assignment / Redraw | selected | |
| Assignment ▾ › Edit path | context row | strip › Adjust | selected with path | |
| Assignment ▾ › Copy to… / Mirror to… | context row | More › ASSIGNMENT | selected | |
| Assignment ▾ › Clear assignment | context row | More › Clear assignment + Delete key | selected | |
| Throw From Here / Use Default (QB) | context row | More › THROW POINT; Ball › Advanced | QB, pass set, QB path | |
| Engage… | context row | strip › Blocks… / Engages… | selected | default meet point (§7) |
| Engaged group: ↔ name, release note, `!`, Release / Release ✓, Remove | context row | strip › `[Blocks DE ▾] [Releases]` + `!` | selected & engaged | Remove and point moves inside the ▾ menu |
| Clear All Paths | context row (always) | play menu › Clear all assignments | menu | disabled when no paths |
| Setup instruction + Cancel | context row | banner (replaces strip) | any pick | one component |
| Viewer chip + Change ▾ | context row | strip (Player view) | Player view | unchanged |
| Player-view Cancel (choosing viewer) | context row | banner Cancel | choosing viewer | |
| Coach-view sentence | context row | strip | Coach view | |
| Present: situation chip, selected chip, ball note | context row (Present) | dock chip; field ring; dock ball note removed (ball sentence not shown in Present) | Present | selected chip dropped: the ring on the field is enough |
| Present: ✎ Draw, Clear marks, Exit Present | top bar | top bar | Present | |
| Reset (R) | bottom bar | dock ⟲ Restart | always | merged with Restart (§9) |
| ▶ Play / Pause | bottom bar | dock, 36 px | always | |
| Restart | bottom bar | dock ⟲ | always | merged |
| Scrub + SNAP mark | bottom bar | dock | always | blurs after use |
| Time `−0.5s / +2.4s` | bottom bar | dock, current time only | always | |
| Playback speed seg | bottom bar | dock rate pill ▾ | always | renamed Rate |
| Paths seg All/Offense/Defense/None | bottom bar | Display ▾ › Paths | always | |
| Labels toggle | bottom bar | Display ▾ › Labels | always | |
| Field: anchors (data-anchor) | board, edit mode | board, adjusting | Adjust | |
| Field: engage × markers | board | board | authoring | |
| Field: throw diamond, requested-catch ghost, catch marker, hover ghost, body/look indicator, engaged links, ball | board | board | as today | |
| New: route handle | — | board on the selected player | §5.2 | |
| New: ◁ ▷ step | — | dock | always | |
| Keyboard V | window | removed | — | no mode to switch |
| Keyboard D, E, B, Esc, Space, R, Delete, Ctrl+Z/Y/Shift+Z | window | kept per §10; ← → added | | |

## 14. Laptop responsive rules

- Bar heights 44 / 44 / 56 at every width. Stage padding 10 px top/bottom,
  12 px sides. Field aspect fixed by the viewBox; it is height-bound below
  ~1420 px wide.
- Top bar order and truncation: brand (never shrinks) · play name (max 200
  px, ellipsis) · save text · undo/redo · spacer · VIEW label (hidden below
  1300 px) · view seg · Present.
- Strip: chip · Draw/Redraw · Adjust · TIMING label (hidden below 1300 px) ·
  timing seg · Blocks… · More · spacer · summary (ellipsis, min 0). At 1280
  the strip fits with the summary ≥ 200 px.
- Dock: ball (max 240 px, ellipsis; 160 px below 1300 px) · transport ·
  scrub (min 160 px) · time · rate · situation chip (max 180 px) · Display.
- Popovers: `position: absolute`, `z-index: 20`; ball, rate, situation and
  Display open upward (`bottom: calc(100% + 6px)`); play, Formation, More,
  Blocks open downward; all clamp to the viewport horizontally (if the
  right edge would overflow, right-align to the anchor). Popovers never
  exceed 60 vh; internal lists scroll.
- Minimum supported width 1180 px; below that the dock hides the situation
  chip label (icon only). No horizontal scrolling anywhere.
- Present at 1280: top bar hides the brand's "Motion Lab" word.

## 15. Implementation slices

Each slice is independently testable, keeps the engine untouched, and ends
with the `window.__lab` harness updated and tests A–E (§16) re-run. Files
are `src/App.tsx` and `src/styles.css` unless noted.

### P0 — interaction problems

**ML-UX-1 · Drawing without a mode (highest risk, isolated)**
- Replace `mode`/`setup`/`dragRef.kind` with `interaction` (§3.1); remove
  `V` and the Move/Draw segment; add `draw-armed` and `drawing`; Esc cancels
  a stroke; window blur cancels; `D` arms; Draw/Redraw buttons arm.
- Add the route handle (`data-handle`) per §5.2 with the pulse and
  `sessionStorage` flag.
- Add the banner component for `draw-armed` / `drawing` (temporary: reuse
  the context row area).
- Result: no Move/Draw segment; drag marker moves; drag handle draws; D
  arms; banner shows while drawing.
- Regression: route geometry (same `simplify`, same sampling), path
  translation on player drag, catch/release points travelling with the
  player, anchor drag, Delete clears, undo grouping. Harness: replace
  `L.route`'s `key('d')` with a handle drag (`L.drawFromHandle`) and keep a
  `L.routeViaKey` variant; run A–E.

**ML-UX-2 · Three zones and the dock transport**
- Bar heights 44/44/56; top bar contents per §2 (hint removed, VIEW label,
  Present outlined); dock skeleton: ⟲ (merged Reset/Restart), Play 36 px,
  ◁ ▷, scrub with blur-on-pointerup, time = `fmtRel(time)` only, rate pill;
  ← → keys; `blur()` on toolbar clicks.
- Move Paths + Labels into a Display popover; keep them functional.
- Result: the screen reads as top bar / strip / field / dock.
- Regression: scrub determinism, SNAP mark position, rate change, keyboard
  Space/R, layout at 1280 / 1366 / 1440 with no overflow (`scrollWidth ===
  clientWidth` on every bar).

**ML-UX-3 · The ball in the dock**
- Move the ball button and menu to the dock (opens upward); sentence
  summaries (§6.2); menu structure (§6.3) with Now card, Change to, Then…,
  Advanced ▸ (throw point), Clear the ball; `!` badge; pick banners (§11.2)
  through the same banner component; view auto-switch (§6.8); no-route
  receiver toast.
- Result: "Set the ball" outlined gold beside Play; every ball pick shows a
  banner.
- Regression: pass/pitch/handoff/play-action transitions, Then… chain,
  Throw From Here set/reset, second-action clearing toast, warnings.

**ML-UX-4 · Strip hierarchy and More**
- Strip per §4 (chip, Draw/Redraw, Adjust, Timing, Blocks…/Engages…, More,
  summary); More per §8; End reworded; Rename/Remove moved; Speed moved;
  Copy/Mirror moved; Clear All Paths into the play menu; Formation ▾
  merging Players and Look; renames in §13.
- Result: seven strip controls; resting strip = Formation + sentence.
- Regression: timing/speed/end changes still write the same fields;
  copy/mirror flows; rename (4-char cap); remove with reference cleanup;
  looks save/load/new play; add player.

**ML-UX-5 · Blocks with an inferred meet point**
- `pick-partner` creates the engagement immediately with the §7.3 point and
  `auto = true`; engaged strip group with the `Blocks DE ▾` menu and
  `Releases`; legality (other side, not engaged); `auto` handling on path
  changes (§7.9); optional field added to `Engagement`, defaulted in
  `sanitizePlay` (only engine-adjacent file touched: `play.ts` sanitizer
  and the `interactions.ts` type, one optional field, no logic).
- Result: Blocks… is one field click in the common case.
- Regression: Test A and Test C timings unchanged when the point equals the
  path end; release window 0.5 s; warnings for unreachable points; drag
  marker sets `auto = false`; existing plays load (`auto` undefined → false).

### P1 — hierarchy and layout

**ML-UX-6 · Saving state, situation chip, Display markings, rate pill**
- `saving` state; situation chip to the dock (opens upward); Field
  markings toggle moved from the Situation popover to Display; rate pill.
- Regression: autosave flush on switch/hide; hash shift; markings on/off.

**ML-UX-7 · Route summary**
- Derived summary per §4.4 (`endDirection`, `turnAngle`, drawn length,
  timing, speed, engagement, ball role).
- Regression: none in behavior; verify strings for A–E plays.

**ML-UX-8 · Views and Present chrome**
- Coach/Player strip sentences; choosing-viewer banner; Present top bar
  per §2; Present dock without the ball; hidden authoring marks list.
- Regression: Present guards (no edits, no keys), telestration, viewer
  change, present exit discards strokes.

### P2 — polish

**ML-UX-9 · Handle and cursor polish** — arrowhead, coarse-pointer hit
area, pulse rules, board cursor classes, `prefers-reduced-motion`.

**ML-UX-10 · States and motion** — hover/pressed/disabled tokens, 120 ms
popover fade, tooltips with keys on every control in §11.1, focus rings.

**ML-UX-11 · Edge presentation** — hint flash on D with no selection,
disabled ball items when no eligible receiver, other-tab notice (§12.9).

**ML-UX-12 · Regression sweep** — harness rewrite finalized; full run of
§16 against the finished UI at 1280 / 1366 / 1440; screenshot set of every
state in §3.3 for the docs.

## 16. Regression contract (DO NOT BREAK)

Validated on the current build (17 Sep 2026) and required to hold after
every slice. Numbers are from the test harness with the default look and
the plays in tests A–E.

Engine and data
- Route geometry: `simplify` at 0.45 yd, Chaikin smoothing keeping breaks
  ≥ 60°, `renderPath`, path translation with the player, anchors editable.
- Timing: pre-snap finishes at the snap (snap at 0.5 s with default
  pre-snap length); on-snap; delayed by N s. Speed tiers 4.5 / 6.5 / 8.5.
- Ball: keep; handoff (mesh ≤ 1.5 yd, MIN_QB_HOLD 0.15, closest-point
  fallback with warning); pitch (window 2–7 yd, tolerant 9); pass (catch
  projected onto the route, release scan EARLY / NORMAL / HOLD, sync
  tolerance 0.35 s, adjustment toast); play action (0.4 s fake); Throw From
  Here override; two-step chain skipped with a warning if the first never
  transfers.
- Engagements: reach 2.5 yd, min 60% pacing, same-side rule, release hold
  0.5 s then continue own path, warnings when unreachable.
- Continue/Settle: heuristic + override; continuation only as far as the
  ball needs; stops on the boundary.
- Orientation: body/look, head limit ±80°, defenders look at the ball,
  targets look at the ball in flight, engaged pairs face each other.
- Views: Overhead, Coach (COACH_CAMERA), Player (camera rides with the
  viewer; hides him; engaged camera); identical ball position at the same
  t in all views.
- Scrub determinism: setting the same t twice gives the same frame.
- Undo/redo: 60 steps, 350 ms grouping, reset on play switch, off in
  Present.
- Persistence: keys `peira.motionlab.plays/looks/currentPlay`, envelope
  `{v:1, items}`, sanitize on read, flush on switch/hide/unload, "opening
  is not an edit".
- Looks: save (positions only), load (clears ball/then/engagements), new
  play from look; independence of copies.
- Copy/Mirror: relative anchors from the target's alignment; mirror negates
  lateral; copies timing/delay/speed/endBehavior only; no link.
- Situation: label, line to gain, hash shift translating everything,
  markings toggle, field numbers in all views.
- Play management: new/open/duplicate/delete/rename; open list by
  updatedAt.
- Present: no editing, telestration overhead only, strokes discarded.

Numeric checks (harness transitions `t:phase`)
- Test A inside zone: `0:spot 0.5:snap 0.8:carry 1.2:handoff 1.4:carry`;
  both engagement links present from 1.0 s.
- Test B trips out: H/X relative anchors `(0,9.6),(6,9.6)`, Y mirrored
  `(0,9.6),(−6,9.6)`; `… 1.1:flight 2.1:carry`.
- Test C chip and flat: link window 0.8–1.2 s; QB holds 0.6 s; `1.5:flight
  2.2:carry`.
- Test D reverse: `0.9:handoff 1.1:carry 4.4:handoff 4.6:carry`.
- Test E look independence: original play and look unchanged after edits
  to the play made from the look.
- Pitch: `0.9:pitch 1.4:carry`. Play action: `1.0:fake 1.4:flight
  2.4:carry`. Throw From Here: diamond `#4da3ff` when manual, stored
  `releasePoint`, cleared by Use end of drop.

Harness
- `window.__lab` helpers must keep working by intent (route, pick,
  clickField, engage, release, pass, pitch, handoff, then, copyTo, setT,
  timeline, transitions, storage, play, playMenu) with label updates; the
  tick must stay `queueMicrotask`/rAF, never `setTimeout`.

## 17. Open questions (genuinely unresolved)

1. **Handle direction for defenders.** Spec says +y (downfield) for both
   sides. If coaches read a defender's handle pointing away from the ball
   as wrong, flip defense to −y. Decide after the first hands-on use.
2. **Block legality.** Spec restricts Blocks… to the other side and to
   unengaged players. The engine allows any pair. If a coach needs
   same-side "engage" (e.g. a double team modeled as two engagements on one
   defender), relax the "not already engaged" rule for the defender only.
3. **`auto` on `Engagement`.** One optional boolean on the stored object,
   defaulted by the sanitizer. Confirm this is acceptable under "no
   persistence architecture changes" (it is additive and ignorable).
4. **Restart semantics while playing.** Spec: ⟲ during playback jumps to 0
   and keeps playing. If coaches expect it to stop, change to stop at 0.
