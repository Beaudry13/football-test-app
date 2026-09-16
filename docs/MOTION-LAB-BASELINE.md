# Motion Lab — prototype baseline (P0)

**Status: RECORD ONLY.** Written 16 Sep 2026, before any PEIRA integration.
Nothing here is imported by the PEIRA frontend or backend. Nothing described as
a limitation below has been fixed, on purpose.

This document defines what "the working prototype" means, so P1 can prove it
moved into PEIRA without losing behaviour. The authoritative source is the code
at the preservation commit; where this file and the code disagree, the code
wins.

---

## 1. Where it is

| | |
|---|---|
| Path | `prototypes/motion-lab/` |
| Branch | `preserve/motion-lab-prototype` (never merged to `master`) |
| Preservation commit | `9282b92` — source byte-for-byte as it stood on 16 Sep 2026 |
| Based on | `master` at `4ee420e` (the production baseline at the time) |
| Dev server | `npm run dev` → `http://localhost:5180` (`vite.config.ts`); `.claude/launch.json` entry `motion-lab` |
| Excluded from the commit | `node_modules/`, `dist/`, `tsconfig.tsbuildinfo` (generated) |

### Toolchain

| | Declared (`package.json`) | Installed when preserved |
|---|---|---|
| react / react-dom | ^19.2.8 | 19.3.0 |
| vite | ^8.2.0 | 8.3.0 |
| typescript | ~6.0.2 | 6.0.3 |
| @vitejs/plugin-react | ^6.0.4 | 6.1.1 |
| @types/react | ^19.2.17 | 19.3.0 |
| Node | — | 24.19.0 |

**Runtime dependencies: `react` and `react-dom` only.** No Fabric, no router,
no state library. The PEIRA frontend declares the same React/Vite/TypeScript
ranges, so integration adds no dependency.

**Gates at preservation:** `npx tsc` exit 0; `vite build` exit 0 (28 modules,
294.70 kB JS / 8.77 kB CSS). **The prototype has no tests.**

---

## 2. Data

### Storage (browser localStorage, one origin)

| Key | Holds |
|---|---|
| `peira.motionlab.plays` | `{ v: 1, items: Play[] }` |
| `peira.motionlab.looks` | `{ v: 1, items: Look[] }` |
| `peira.motionlab.currentPlay` | the id of the play last open |

`SCHEMA_VERSION = 1` (`src/play.ts`). Everything read back goes through
`sanitizePlay` / `sanitizeLook`, which repair or drop — never invent — data.

**localStorage belongs to one origin** (`http://localhost:5180`). Plays saved
there are invisible to PEIRA's origin and to any other browser or profile.

**Opening the prototype can write.** On load, a browser with no plays gets a
new "Untitled Play" saved; edits autosave after 400 ms and on tab hide/unload.
Back up a browser's data BEFORE opening the prototype in it.

### What a play stores — coach intent only

```
Play     { v, id, name, createdAt, updatedAt,
           players: Player[], ball: BallAction|null, ballThen: BallAction|null,
           engagements: Engagement[], situation: Situation, filter }
Player   { id, side, label, x, y, path: Pt[] (anchors), timing, delay, speed, endBehavior? }
Ball     keep | handoff{carrierId} | pitch{targetId}
         | pass{targetId, catchPoint, releasePoint?}
         | play-action{fakeId, targetId, catchPoint, releasePoint?}
Engage   { id, kind:'engage', a, b, point, release? }
Situation{ losYard 1..99, hash left|middle|right, down 1..4, distance, show }
Look     { v, id, name, updatedAt, players (paths stripped) }
```

**Never stored:** schedules, snap time, meeting/release/flight times, ball
frames, continuation, body/look orientation, duration, catch adjustment,
playback position, camera, telestration marks.

### Coordinates

Yards. `x` 0–53.33 from the left sideline; `y` relative to the line of
scrimmage, positive downfield. Visible window `y ∈ [-13, 17]`, with a 2-yard
side margin. `toView` / `fromView` in `src/field.ts` are the only yard↔pixel
mapping. `losYard` places the window on the real field for labels only.

---

## 3. Engine

Pure TypeScript. No React, no storage, no clock, no randomness — so
scrubbing to `t` gives exactly what playing to `t` gives.

| File | Lines | Responsibility |
|---|---|---|
| `field.ts` | 62 | coordinate system, hashes, bounds, yard labels |
| `geometry.ts` | 198 | simplify, `renderPath` smoothing (sharp breaks kept), arc length, end classification |
| `formation.ts` | 109 | `Player`, timing, speed tiers, default 11 v 11 |
| `timeline.ts` | 139 | `buildSchedule`, `posAt`, continuation past a drawn route |
| `interactions.ts` | 216 | engagements: cut paths, pace to arrive together, release |
| `ball.ts` | 444 | possession chain: snap, carry, handoff, fake, pitch, flight, second action |
| `orientation.ts` | 219 | body facing and look direction, precomputed at 1/30 s |
| `perspective.ts` | 134 | pinhole camera for Coach and Player views |
| `play.ts` | 209 | Play/Look/Situation model, sanitizers |

### Derivation order (`App.tsx`, "derived playback data")

```
players → buildSchedule → applyEngagements → deriveBall(ball, ballThen)
        → (receiver continuation written into the schedule)
        → buildOrientation → at time t: posAt / ballTimeline.at / orientationAt
```

### Tuning constants are behaviour

Changing any of these changes how EVERY saved play animates. They are what
the P1 golden tests pin:

- `formation.ts` `SPEED_YPS` controlled 4.5 / normal 6.5 / fast 8.5 yd/s
- `timeline.ts` pre-snap window 2.0 s, breath 0.5 s
- `ball.ts` snap 0.25 s under center / 0.45 s shotgun (depth > 3 yd), mesh
  1.5 yd, handoff 0.2 s, fake 0.4 s, pitch 2–7 yd (tolerant 9), quick-game
  release 0.6 s, flight 0.5–1.1 s, sync tolerance 0.35 s, max hold 2.0 s
- `interactions.ts` reach 2.5 yd, touch 0.45 yd, min pace 0.6, release after 0.5 s
- `orientation.ts` step 1/30 s, head limit 80°, turn/ease rates

---

## 4. Authoring and views (all in `App.tsx`, 1,743 lines)

**Authoring**
- Modes: Move (V), Draw (D, player selected), Edit anchors (E)
- Drag players; free-draw a path simplified to anchors; drag anchors
- Per player: timing (Pre-Snap / On Snap / Delayed + delay), speed
  (Controlled / Normal / Fast), end behaviour (auto / Continue / Settle),
  clear path (Delete/Backspace), remove from play
- Add offensive / defensive player
- Ball (B): keep, handoff, pitch, pass, play action; a second action
  (handoff / pitch / pass) after the first; catch point with "Catch adjusted
  for timing"; Throw From Here (manual release point) or default release
- Engage two players at a point; optional release (engage → release)
- Copy To… / Mirror To… a player's assignment onto another player
- Situation: down, distance, ball spot (1–99), hash (moves the whole look)
- Path filter: All / Offense / Defense / None; labels on/off
- Undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y), 60 steps, 350 ms grouping

**Play management**
- Autosave (400 ms, and on tab hide/unload), save status
- New, open, rename, duplicate ("(copy)"), delete (confirm)
- Looks: save current arrangement, load into a play (independent copy), delete

**Playback and views**
- Play/pause (Space), reset (R), scrub, rates 0.5× / 1× / 1.5×
- Overhead (authoring), Coach (fixed perspective camera), Player (camera from a
  chosen player, following his body/look)
- Present mode: authoring hidden; highlight a player; telestration while paused,
  "Clear marks" — marks are never saved

---

## 5. Known limitations (recorded, NOT fixed)

Each changes existing behaviour or data if fixed, so each is a product decision.

1. **QB and center are found by LABEL.** `deriveBall` looks for offense
   `label === 'QB'` and `'C'` (`ball.ts`), and `setHash` finds the line by
   `LT/LG/C/RG/RT` (`App.tsx`). Relabelling the QB gives "No QB on the field."
   A real fix needs a stored role and schema v2.
2. **College hashes are hard-coded.** `HASH_LEFT = 20` yd (`field.ts`). High
   school ≈ 17.8 yd, NFL ≈ 23.6 yd. Alignments are stored absolutely, so a
   later field-type setting would not move saved players.
3. **17-yard downfield limit.** `Y_MAX = 17` and `clampToField` clamp every
   player, anchor and route. Deep routes (Four Verticals, shots) cannot be
   drawn past 17 yards.
4. **localStorage-only persistence.** One browser, one origin; no accounts,
   sync, export or import.
5. **Global CSS.** `styles.css` sets `:root` custom properties (`--bg`,
   `--panel`, `--text`, `--accent`, …) and bare `*`, `body`, `button` and
   `input[type='range']` rules. Loaded inside PEIRA it would restyle every page for the rest
   of the session. Must be scoped before integration.
6. **`App.tsx` concentration.** Authoring, the overhead SVG renderer, play
   management, playback and shell live in one 1,743-line component with ~30
   `useState`s. There is no reusable read-only overhead view yet.
7. **Global keyboard shortcuts.** One `window` keydown listener; it ignores
   `INPUT` targets only, not `TEXTAREA`, `SELECT` or contenteditable.
8. **No tests** of any kind.
9. **Storage calls are synchronous** and made directly from `App.tsx`.

---

## 6. Characterization fixtures (P0-E)

### Preserved real data

`prototypes/motion-lab-baseline/localstorage/browser-pane-20260916T114345.json`
is a verified, byte-exact export of the Claude desktop browser pane's
`http://localhost:5180` localStorage (3 keys; SHA-256 per key recorded in the
file and re-checked after saving). It holds 8 plays and 1 look, created
16 Sep 2026 08:56–10:23 — the same window the prototype source was last
edited. **They are development/test data** (owner-confirmed, 16 Sep 2026),
kept because they are useful fixtures, not because they hold coaching work.

The play the owner built by hand was never saved and does not need
preserving (owner decision, 16 Sep 2026). Nothing else is outstanding.

### Coverage by behaviour

| Behaviour | Covered by preserved play | Gap |
|---|---|---|
| Normal pass | "Trips Out" (pass, QB path), "Untitled Play" (pass, stationary QB) | |
| QB drop / football-aware release | "Trips Out", "Regression" (QB has a path) | |
| Handoff | "Inside Zone Rt" | |
| Two-step possession chain | "Reverse" (handoff → handoff) | |
| Play action | "Regression" | |
| Engage | "Inside Zone Rt" (2 engagements, no release) | |
| Receiver Continue (explicit) | "Untitled Play" | |
| Non-default situation / hash | "Trips Rt — new play" (3rd & 7, opp 38, left hash) | |
| Look | "Trips Rt" (22 players) | |
| Pre-snap motion | — | **missing** |
| Pitch / toss | — | **missing** |
| Engage → release | — | **missing** |
| Receiver Settle (explicit) | — | **missing** |
| Throw From Here (manual release point) | — | **missing** |
| Delayed timing | — | **missing** |

### Recommended fixture set for P1

Keep it small: the preserved plays above, and
**at most six small purpose-built plays** for the gaps — or fewer, combined
where one play can exercise two behaviours without making a failure hard to
read (e.g. pre-snap motion + pitch; engage → release + delayed timing;
Settle + Throw From Here).

They should be authored in the prototype AT THE PRESERVATION COMMIT, exported
with the same read-only method, and committed as input JSON. Expected values
are then generated by running the preserved engine — never written by hand.

For each fixture the golden record should capture, at `t = 0`, `snapAt`,
every 0.1 s to `duration`, and `duration`:

- `buildSchedule`: `snapAt`, `playersEnd`, per-player `start` / `end`
- `posAt` for every player
- `deriveBall(...).at(t)`: `pos`, `phase`, `carrierId`, `lift`; plus
  `releasePoint`, `catchPoint`, `catchAdjusted`, `warning`, `end`
- `applyEngagements(...).derived`: `valid`, `time`, `until`, `warning`
- `orientationAt`: body and look angles
- `sanitizePlay` round-trip equals the input

Compare with a small tolerance (1e-6 yd / rad / s). A difference is a
behaviour change and must be explained, not re-baselined.
