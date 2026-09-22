# Motion Lab Editor: UX/UI Design Handoff

> Direction APPROVED 19 September 2026. The implementation brief is
> `SPEC-editor-interaction.md`; where the two differ, the spec wins. This
> file remains the rationale and the record of the exploration.

Date: 19 September 2026. Scope: the authoring interface of `prototypes/motion-lab/`
only. The engine (paths, timing, ball, engagements, orientation, perspective,
persistence, play/look schema) is unchanged by this design. This is a
reorganization of existing controls, not a rebuild.

Companion: `docs/editor-redesign.html` (also published as the "Motion Lab
Editor Redesign" artifact) holds the annotated audit, the three layout
directions, the three revisions and mockups of every final state.

Principle applied throughout: **simple by default, powerful when you ask for
it.** The screen should read as MOVE PLAYERS → DRAW ASSIGNMENTS → SET THE
BALL → PLAY without becoming a wizard. The field is the product; no new
sidebars, panels or modals.

---

## 1. Current UX problems

Measured on the live prototype at 1366×768: three chrome bars (55 + 50 + 54
px) leave the field 585 px tall (76% of the screen); 25 buttons are visible
before anything is selected. The structure (top bar, context row, field,
bottom bar) is sound. The problems are hierarchy, mode, wording and noise.

1. **Move / Draw is a global mode switch.** Drawing an assignment, the most
   important interaction in the product, sits behind a toggle that also
   changes what dragging a player means. It is the main source of "what do I
   click now" and of accidental moves-when-meaning-to-draw.
2. **Two hints, both weak.** A muted, truncated instruction in the top bar
   and a second one in the context row. Neither is where the eye goes.
3. **Present and Play compete.** Two solid-gold primaries on screen at once;
   Present is the loudest control and is not part of authoring.
4. **The ball lives top-right, far from Play,** and reads like a settings
   menu. "🏈 Ball: Play Action → RB → Z · then Pitch → H" is engine syntax.
5. **The view switch looks like an editing mode.** Overhead / Coach / Player
   sits between Undo and Move, and switching silently disables editing.
6. **Selected-player controls arrive at equal weight.** Timing, Speed and
   End are three segmented controls (nine buttons) plus Assignment ▾ and
   Engage…. "Auto (continue) / Continue / Settle" is engine vocabulary.
7. **"Clear All Paths" is permanently on screen,** right-aligned and
   destructive, for something used once per play.
8. **The playback bar mixes display preferences** (Paths filter, Labels)
   with transport and has no step control.
9. **Setup items (Players ▾, Look ▾, Situation) share the resting row with
   the hint,** so the resting state reads as three unrelated menus.
10. **Keyboard badges on every button** (V, D, B, Space, R) add texture
    without teaching much; the room is mouse-driven.
11. **Draw mode is sticky.** After a stroke the editor stays in Draw, so the
    next drag on a different player draws a new route for him instead of
    moving him. Surprising the first time, every time.
12. **Engage… asks for two field clicks** (partner, then meet point) when the
    meet point is almost always where the blocker's path ends.

What is right and must stay: the field is the input (receiver, catch point,
carrier, partner, meet point, throw point and viewer are all picked by
clicking on the field with dashed rings on the legal choices); fixed-height
bars so the field never jumps; the existing football vocabulary (Pre-Snap /
On Snap / Delayed, Controlled / Normal / Fast, "QB holds 0.6 s at the top of
his drop for Y's timing"); derived body and look with no coach-facing
control.

## 2. Control priority map

Classified by how often a coach touches the control while building an
ordinary play. Nothing is removed; the level decides where it lives and how
loud it is.

**PRIMARY (always one click away)**
- Select and move a player (drag, no mode)
- Draw his assignment
- Ball action
- Play / Pause, Restart, scrub
- Undo / Redo
- Play name and saved state

**SECONDARY (visible in context)**
- Timing: Pre-snap / On snap / Delayed
- Blocks… (engage) and Releases
- Adjust route (anchors), Redraw
- Overhead / Coach / Player view
- Present
- Situation chip
- Formation: saved looks, add / remove player
- Playback rate; Display (paths filter, labels, markings)

**ADVANCED (under More or Advanced)**
- Speed tier per player
- After the route: keeps running / stops (continue / settle)
- Delay seconds
- Copy to… / Mirror to…
- Throw point (Throw From Here)
- Then… second ball action
- Play-action fake target
- Hash shift, markings on/off
- Rename / Remove player, Clear all assignments

## 3. The three layout directions explored

All three were evaluated on field space at 1366×768 (height-bound: every
horizontal bar costs field height directly, every side panel costs width
once the field is width-bound), speed, learnability, clutter,
discoverability, advanced access, laptop and meeting-room use.

**A. Floating controls near the player.** One thin top bar, no strip.
Selecting a player pops a small card beside him (Draw / Timing / More). Ball
and transport share a bottom dock.
Field space: best (no strip). Speed: controls at the cursor. Learnability:
the card jumps around. Clutter: the card covers the play it edits, exactly
where the coach is looking. Advanced: nested popovers. Meeting room: hard to
project and point at.

**B. Tool rail + inspector.** Vertical rail (Select, Draw, Ball, Block,
Present) on the left, persistent inspector on the right with every property
of the selected player.
Field space: −9% height at 1366×768, worse at 1440×900 where the field is
width-bound. Speed: everything visible, more mouse travel. Learnability:
familiar design-tool pattern. Clutter: permanent panel, dashboard feel.
Advanced: always exposed. Meeting room: field shrinks on projection.

**C. Field-first: one strip above, one dock below.** Top bar = the play
file. A single fixed strip above the field = whoever is selected (or the
formation when nobody is). The dock = the ball, then the transport, then
display. Field space: +20 px over today, +64 px in Present. Speed: the strip
is one glance above the field. Learnability: three stable zones a
first-timer can name. Clutter: the strip holds at most seven controls.
Advanced: one click under More. Meeting room: nothing covers the field.

## 4. Why C

A loses on the one thing that matters most, the field it covers, and a card
that follows the selection cannot be pointed at from across a room. B is the
most discoverable and the most "software": it spends field width permanently
to show properties a coach changes once a game. C keeps the current bones,
which the coach who already built a real play knows, fixes the hierarchy,
and still gives three stable zones. C was then taken through three
revisions (see the companion page): revision 1 moved the furniture; the
critique found twelve strip controls, a gold Draw button that stayed gold
after drawing, no on-field drawing affordance, an empty ball state that did
not look unfinished, and Situation buried in Formation. Revision 2 fixed
those and added the route handle; its critique produced side-specific
"Blocks… / Engages…", the outlined Present, step buttons, and moved the
situation chip to the dock. The final pass then simplified the dock.

## 5. Final editor structure

Three stable zones, fixed heights, field between them never covered by
chrome.

```
TOP BAR (44 px)   PEIRA Motion Lab · [Inside Zone Rt ▾] Saved · ↶ ↷ · … · VIEW [Overhead | Coach | Player] · [Present]
STRIP   (44 px)   selected:  [Z chip] [✎ Draw assignment] [Adjust] TIMING [Pre-snap | On snap | Delayed] [Blocks…] [More ▾] … route summary
                  resting:   [Formation ▾]  "Drag a player to move him. Click a player to give him a job."
                  drawing / picking:  gold-edged banner with one sentence and Cancel (Esc)
FIELD             overhead board, or FieldView in Coach / Player view
DOCK    (56 px)   [🏈 Set the ball ▾] │ [⟲] [▶ Play] [◁] [▷] scrub with SNAP · +1.3 s · [1× ▾] │ [1st & 10 · own 35 ▾] [Display ▾]
```

Present mode: strip removed (field gains 44 px); top bar keeps play name,
VIEW, ✎ Draw, Clear marks, Exit Present; dock keeps transport, situation,
Display.

Persistent controls at rest: 25 today → 14 final (top bar 8, strip 1, dock
5). Popovers open over the field and never push it: the ball menu opens
upward from the dock, More opens downward from the strip, so neither covers
the line of scrimmage.

## 6. Primary toolbar / controls

- **Top bar** is the play file: name (menu: Rename, New play, Duplicate,
  Open list, Clear all assignments, Delete), saved state text, Undo/Redo,
  VIEW segment, Present (outlined gold).
- **Strip** is the selected player. Exactly one solid-gold button in it:
  Draw assignment (until he has one; then it becomes a quiet Redraw).
- **Dock** is the play in motion. Play is the largest control on screen (36
  px) and the only solid-gold button outside a banner. The ball sits
  immediately left of the transport with a divider, so step 3 reads into
  step 4.
- Keyboard: Space play/pause, D draw, E adjust, B ball, Delete clear
  assignment, Esc cancel/deselect, ← → step 0.1 s, R reset, Ctrl+Z /
  Ctrl+Shift+Z. Keys appear in tooltips, not on buttons.

## 7. Selected-player experience

Answers three questions in one glance: who, what is he doing, what can I
change.

- **Who:** a chip with his label in the offense/defense color and the side
  word ("Z · Offense").
- **What:** a route summary at the right end of the strip, derived from the
  path and schedule: "Route · 9 yds up, then out · fast", "Drop · 5 yds",
  "Blocks DE · releases", "Motion · pre-snap · 6 yds", "No assignment yet."
- **What I can change, at first glance:** Draw assignment (or Redraw +
  Adjust), Timing segment, Blocks… (offense) / Engages… (defense), More ▾.
  The Delayed seconds field appears inline only when Delayed is chosen.
- **Under More ▾:** Speed (Controlled / Normal / Fast), After the route
  (Keeps running · auto / Stops where the route ends), Copy his assignment
  to…, Mirror his assignment to…, Clear assignment, Rename, Remove from play.
  For the QB with a pass set: Throw point: set on field / use end of drop.
- **Body and look** stay derived and are shown only as the existing indicator
  on the selected player. No control is added; the More menu does not
  mention them.
- **Engagement, once set:** the Blocks… button becomes "Blocks DE" with a
  Releases toggle and an × to remove; the warning "!" stays where it is.

## 8. Drawing experience

Mental model: CLICK PLAYER → DRAW WHAT HE DOES. No persistent mode.

- Dragging a marker always moves the player, in every state except a field
  pick.
- Three ways to draw, all leading to the same transient drawing state:
  1. **The route handle.** When a player is selected, a short gold stub with
     an arrowhead appears just outside his marker, pointing downfield (up for
     defense). Dragging from it draws his assignment. The cursor is a
     crosshair over the handle; over the marker it is a grab hand. The
     handle pulses on the first selection of a session and stops pulsing
     after the first successful draw.
  2. The **Draw assignment** button in the strip.
  3. The **D** key.
- While the mouse is down the strip is replaced by a gold-edged banner:
  "✎ Drawing Z's assignment. Drag on the field; let go to finish." with
  Cancel (Esc). The route renders as a dashed gold line.
- Releasing finishes the route and returns to the selected state. Drawing
  is never sticky. Drawing again replaces the route (confirmation not
  needed; Undo covers it).
- **Adjust** (E) shows the anchors as today; Esc or clicking elsewhere
  leaves it.
- A drag shorter than one yard is treated as a click (selects, draws
  nothing), as today.
- Delete clears the assignment; Undo restores it in one step (existing
  350 ms grouping).
- Timing, speed and end behavior are untouched by drawing; defaults stay
  On snap / position default speed / auto end.

## 9. Ball-action experience

Treated as football, not animation.

- Dock button reads a sentence: "Set the ball" (outlined gold when empty),
  then "Pass to Z", "Handoff to RB", "Handoff to RB, then pitch to H",
  "Play action to RB, pass to Z". Truncates at 220 px with the full sentence
  in the tooltip and the menu.
- Menu (opens upward) is one question with five answers:
  - QB keeps it
  - Handoff to…
  - Pitch to…
  - Pass to…
  - Play action: fake, then pass…
- When an action exists the menu opens with a "Now:" sentence at the top
  ("Pass to Z, caught 9 yds downfield. QB throws from the top of his drop."
  or the existing hold / early sentence), then "Change to" with the same
  five, then "Then…" (second action; existing rules, same wording as today:
  cleared with a toast when the first action changes), then an **Advanced ▸**
  disclosure holding Throw point (Set on field… / Use end of drop) and, for
  play action, the fake target, then "Clear the ball" in red.
- Every pick still happens on the field with the existing dashed-ring
  highlighting and dimming, under the same gold banner used for drawing:
  "🏈 Pass. Click the receiver." → "Click on Z's route where the ball should
  arrive." with Cancel (Esc).
- Warnings ("QB and RB never meet, handing off at their closest point")
  stay as the "!" on the ball button and as the sentence in the resting
  strip.

## 10. Playback experience

Visually distinct from authoring: the dock is a darker band, Play is the
one large solid-gold control, the scrub fills gold as time advances, the
SNAP tick is blue, the time is relative to the snap ("−0.5 s" pre-snap,
"+1.3 s" after).

- Controls: Restart (⟲), Play/Pause, step back / step forward 0.1 s, scrub,
  time, rate pill (0.5× / 1× / 1.5×).
- Nothing in the strip changes while playing, so the coach can pause and
  keep editing. Any edit still resets the clock to pre-snap (existing rule).
- VIEW (Overhead / Coach / Player) lives in the top bar under a small VIEW
  label so it reads as "how I am watching", never as an editing mode. In
  Coach or Player view the strip shows a quiet sentence ("Watching from the
  FS. Switch to Overhead to edit.") and, in Player view, a Change button.
  Choosing Player with nobody chosen keeps the overhead up with the banner
  "Click the player to watch from."

## 11. Advanced-control experience

New user never needs them; power user reaches each in one click.

| Control | Where | Football wording |
|---|---|---|
| Speed tier | Player › More | Speed: Controlled / Normal / Fast |
| End behavior | Player › More | After the route: Keeps running (auto) / Stops where the route ends |
| Delay seconds | Strip, inline when Timing = Delayed | "Delayed · 0.5 s" |
| Copy / Mirror | Player › More | Copy his assignment to… / Mirror his assignment to… |
| Engage | Strip | Blocks… (offense) / Engages… (defense) |
| Release | Strip, once engaged | Releases after the block (toggle) |
| Throw From Here | Ball › Advanced, and QB › More | Throw point: set on field / use end of drop |
| Then… | Ball menu | Then… |
| Play-action fake | Ball › Advanced | Fake to… |
| Situation | Dock chip | Down · distance · ball on · hash |
| Field markings | Dock › Display | Field markings on/off |
| Hash shift | Situation popover | Hash: Left / Middle / Right (moves the whole look, as today) |
| Body / look | Not a control | Derived; indicator on the selected player only |

Blocks… default (P1): after the coach clicks the defender, the meet point is
placed at the end of the blocker's path if he has one, otherwise halfway
between the two men, and shown as the existing draggable marker. The
second click is only needed when the default is wrong.

## 12. Play management

- Play name button in the top bar opens: Rename…, New play (this
  formation), Duplicate, Open (list sorted by last edited, current
  highlighted), Clear all assignments, Delete play. Unchanged behavior; the
  list stays inside the popover.
- Formation ▾ (resting strip) absorbs the old Players ▾ and Look ▾: Add
  offensive player, Add defensive player, Save this formation…, Saved
  formations (Load / New play / delete). "Look" becomes "Formation"
  everywhere a coach reads it; the code and storage keys keep `Look`.
- Copy / Mirror stay per player under More.

## 13. Saved / saving states

Single text next to the play name, no icon, no animation:
- **Saved** (muted) after a successful write.
- **Saving…** (muted) during the 400 ms quiet period and the write.
- **Not saved** (red, bold) when the write fails, with the reason in the
  tooltip ("Browser storage is full or blocked").
The toast on load when storage is unavailable stays. Nothing else about
persistence changes.

## 14. Laptop behavior

| Screen | Chrome | Field today | Field final | Field in Present |
|---|---|---|---|---|
| 1366×768 | 44+44+56 | 1342×585 | 1342×605 | 1342×649 |
| 1440×900 | 44+44+56 | 1416×717 | 1416×732 | 1416×741 |
| 1280×720 | 44+44+56 | 1256×537 | 1256×557 | 1256×601 |

- No basic authoring scrolls. Only the Open list and Saved formations
  scroll inside their popovers.
- At 1280 the top bar drops the VIEW label and the ball sentence truncates to
  "Pass to Z".
- Everything a coach touches in a meeting is at least 30 px tall; Play is
  36 px. Bars keep the existing "never wrap, never clip, flexible items
  shrink" CSS.

## 15. First-time-user experience

- Resting strip says exactly what to do: "Drag a player to move him. Click
  a player to give him a job."
- Selecting a player shows one gold button (Draw assignment) and a pulsing
  route handle on the field.
- The dock shows "Set the ball" in outlined gold until it is set, and Play
  in solid gold. The three-then-four sequence is visible without a tutorial.
- Every waiting state (drawing, any field pick) uses the same gold banner
  with one sentence and a Cancel, so "the editor is waiting for me" always
  looks the same.
- Nothing advanced is visible until More or Advanced is opened.

## 16. Power-user experience

- Keyboard for everything primary; ← → stepping in a room.
- Draw without touching a button: click, drag the handle, next player.
- Timing is one click in the strip; Speed, After the route, Copy, Mirror
  are one click under More.
- Blocks… is one field click in the common case.
- Ball changes are two clicks to the menu plus the same field picks.
- Present is one click and keeps views, scrub, step, situation and
  telestration.
- Nothing was removed: every engine capability remains reachable.

## 17. Controls / labels renamed

| Today | Final |
|---|---|
| Draw Path (D) | Draw assignment; Redraw once one exists |
| Edit Path (E) | Adjust |
| Clear Path | Clear assignment |
| Clear All Paths | Clear all assignments (in the play menu) |
| Engage… | Blocks… (offense) / Engages… (defense) |
| Release | Releases after the block |
| End: Auto (continue) / Continue / Settle | After the route: Keeps running (auto) / Stops where the route ends |
| Throw From Here / Use Default | Throw point: set on field / use end of drop |
| Look ▾ / Players ▾ | Formation ▾ |
| Save look… / Saved looks | Save this formation… / Saved formations |
| 🏈 Ball: Pass → Z | Pass to Z; empty state "Set the ball" |
| · then Pitch → H | , then pitch to H |
| Speed (playback) | Rate (avoids the player Speed tier) |
| Move / Draw segment | removed |
| Show Paths / Labels | Display ▾ (Paths, Labels, Field markings) |

## 18. Controls de-emphasized

- Move / Draw switch: removed as a persistent control.
- Present: outlined gold instead of solid.
- Speed tier, After the route, Copy, Mirror, Rename, Remove: under More.
- Clear all assignments: in the play menu.
- Keyboard badges: tooltips only.
- Top-bar hint: removed; one hint line lives in the strip.
- Paths filter, Labels, markings: one Display menu.
- Rate: a pill instead of a segment.
- Play length in the time readout: removed.

## 19. Controls made more prominent

- Draw assignment: the one solid-gold button in the strip.
- The route handle on the selected player.
- The ball: beside Play, outlined gold until set, in a sentence.
- Play: the largest control, the only solid gold outside banners.
- Mode banners for drawing and every field pick.
- What the selected player does, in words, in the strip.
- Step back / forward.

## 20. Intentionally not changed

- All field-pick flows and their visuals (dashed rings, dimming, catch
  marker, ghost of the requested catch, throw diamond, engage markers).
- Fixed-height bars; the field never moves under the cursor.
- Timing, speed and end vocabulary in the engine; derived orientation with
  no coach-facing control; the catch-adjusted toast; ball and engagement
  warnings and their sentences.
- The Situation popover contents and hash-shift behavior.
- Present mode's rules (no editing; telestration overhead only; strokes
  discarded on exit).
- Engine, path math, ball logic, engagement logic, undo model, autosave,
  storage keys and the play/look schema.

## 21. Implementation notes for Claude Code

All changes are in `App.tsx` and `styles.css`; no engine module changes.

- **Remove `mode: 'move' | 'draw'` as a persistent state.** Keep `'edit'`
  (Adjust). Drawing becomes a transient `drawing: boolean` set on
  pointerdown from the handle (`data-handle` on the selected player's group),
  from the Draw button, or from the D key (which arms a one-shot: the next
  pointerdown anywhere on the field starts the stroke from the selected
  player, as today). On pointerup the stroke is simplified and `drawing`
  clears. Dragging a `data-player` element in the resting state always moves.
- **Route handle:** render for the selected player only, in overhead
  authoring, outside Present: a 25-px stub plus arrowhead pointing away from
  the LOS. Hit area ≥ 14 px radius. Cursor `crosshair`. Pulse class until
  `sessionStorage.mlDrewOnce` is set.
- **Banner component** replaces the strip whenever `drawing || setup`:
  gold left rule, one sentence from the existing `instruction()` switch, a
  Cancel button wired to the existing `cancelSetup` / drawing cancel.
- **Strip (selected):** chip · Draw/Redraw · Adjust (when `hasPath`) · Timing
  seg (+ delay input when delayed) · Blocks…/Engages… (existing
  `engageControls`) · More ▾ (existing Assignment popover items plus Speed
  seg, End seg relabeled, Rename, Remove; Throw point items for the QB).
  Route summary on the right from `drawnSchedule`: length in yards,
  direction words from `endDirection`, speed tier, timing when pre-snap.
- **Dock:** move the ball button and popover here (popover `bottom: calc(100%
  + 6px)`), add ◁ ▷ (`setTime(t ∓ 0.1)`, clamped), replace the rate seg with
  a pill + popover, replace Paths seg + Labels with a Display popover
  (Paths seg, Labels toggle, Markings toggle bound to `situation.show`),
  move the situation chip here. Time readout: `fmtRel(time)` only.
- **Top bar:** brand · play name menu (add "Clear all assignments") · saved
  text (add `saving` state: set true in the autosave effect, false in
  `flushSave`) · undo/redo · spacer · VIEW label + seg · Present
  (`gold-line`). Remove the hint. Keyboard hints move to `title`.
- **Resting strip:** Formation ▾ (merge the Players and Look popovers) +
  hint sentence. Move Clear All Paths into the play menu.
- **Blocks… default meet point (P1):** in `pickPlayer` case `pick-partner`,
  compute the point (end of `players[forId].path` if length ≥ 2, else the
  midpoint between the two men, clamped), push the engagement immediately
  and select the blocker; keep the marker draggable. Drop the
  `pick-engage-point` step from the default flow but keep it reachable via
  "Move the meet point…" in the engaged state's × menu if wanted.
- **Renames** are string changes in JSX; keep ids, storage keys and engine
  names.
- **CSS:** bar heights 44 / 44 / 56; `.banner`; `.handle`; `.btn.gold-line`;
  dock groups separated by a 1-px divider; remove `.key` badges from
  buttons.
- **Tests:** the `window.__lab` harness helpers `route`, `pick`, `engage`,
  `pass`, `then`, `copyTo` need updating for the new button labels and the
  handle-based draw (add `L.drawFromHandle`). Re-run tests A–E and the
  pass/pitch/play-action regressions after the P0 batch.

## 22. Prioritized implementation list

**P0 — highest-value UX fixes**
1. Remove the Move / Draw switch; drag on a marker always moves; drawing
   starts from the route handle, the Draw button or D; drawing ends with the
   drag.
2. Move the ball control into the dock beside Play; "Set the ball"
   outlined-gold empty state; sentence-form summary; menu as one question
   with five answers.
3. Strip hierarchy: chip · Draw · Adjust · Timing · Blocks… · More. Speed,
   After the route, Copy, Mirror, Clear, Rename, Remove under More.
4. Gold mode banners for drawing and every field pick, with one Cancel.
5. Top bar = play file only. Present outlined. Hint removed. Keyboard
   badges → tooltips. Bar heights 44 / 44 / 56.

**P1 — important refinements**
6. Blocks… defaults the meet point (end of the blocker's path, else the
   midpoint) and keeps the marker draggable.
7. Route summary in the strip.
8. Step buttons and ← → keys (0.1 s); Saving… state; situation chip and
   Display ▾ in the dock; rate pill; time relative to snap only.
9. Renames from section 17; Formation ▾ absorbing Players and Looks; Clear
   all assignments in the play menu.
10. Side-specific Blocks… / Engages… wording and the engaged-state strip
    ("Blocks DE · Releases ✓ · ×").

**P2 — polish / optional**
11. Route handle polish: arrowhead shape, crosshair cursor, first-selection
    pulse that stops after the first successful draw of the session.
12. Ball menu Advanced ▸ disclosure (throw point, fake target); "Now:"
    sentence at the top of the menu.
13. Hover, disabled and pressed states at one consistent contrast step;
    120 ms transitions on popovers; tooltips carrying the key.
14. Present: collapse the top bar further below 1280 px; keep telestration
    single-color.
15. First-time hint variants in the strip that react to state ("Z has no
    assignment. Drag the gold handle, or press D.").
