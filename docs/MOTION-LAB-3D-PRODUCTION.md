# Motion Lab → Preview 3D: how it works, and what production needs

Status (22 October 2026, connected-system cycle): **works end to end locally,
not deployed, not configured in any production build.** Nothing in this
document has been applied to production. Production still shows no 3D control
(owner decision, 20 October 2026), because `VITE_MOTION_LAB_3D_URL` is unset
there.

## How it works now

The coach presses **Preview 3D** in Motion Lab's top bar.

- **Where it opens.** The 3D viewer fills the screen over the editor
  (`Preview3DOverlay.tsx`). There is no new tab and no pop-up to allow. The
  editor stays mounted underneath, so its selection, undo history and scroll
  are all as they were.
  - The bar at the top shows **← Back to Motion Lab**, which has keyboard focus
    when the preview opens, then the play's name, then "Unsaved" when the play
    has not been saved yet.
  - Back closes the preview. So does Escape while the bar has focus. Once the
    coach clicks into the 3D view, the view keeps its own keys.
- **Which play.** It is always the play on screen.
  - A saved play is handed over as the server holds it, but only after the
    coach's last edit has been written. The page flushes the editor's 400 ms
    quiet period, then waits for the save to land. The coach is never told to
    "try again in a moment".
  - The unsaved scratch play previews too, as a **draft**: the document on
    screen, with `play: { id: null, revision: null, draft: true, … }`.
  - Nothing is created or saved in order to preview.
- **The handoff.** This is the same contract as V6 (`peira-motion-lab-3d`,
  version 1), now framed:
  - The viewer opens at `?source=peira&play=<id | draft>&embed=1`.
  - The viewer posts `peira-3d:ready {requestId, playId}` to its parent, at the
    allowed PEIRA origins only.
  - The page answers that request once, to the viewer's origin only.
  - The page checks the sender window, the origin, the play id and the request
    id (`answerViewer` in `viewIn3D.ts`).
  - The viewer checks the reply's window, origin and request id, then validates
    the payload strictly. It refuses a malformed play rather than repairing it.
  - A draft must say `draft: true`. A missing id never means "draft" on its own.
- **What the viewer shows.**
  - Embedded, the viewer's own title block is hidden, because Motion Lab's bar
    names the play.
  - What remains: views (Coaching: All-22, End Zone, Offense, Defense;
    Broadcast), labels and paths toggles, and the dock (restart, step,
    play/pause, timeline with Snap/Whistle marks, speed 0.25×–2×, loop).
  - There is no score bug, no game HUD and no debug UI.
  - If the viewer is ever opened as a tab of its own, its title block names the
    play in coach words ("From Motion Lab · saved 2:14 PM" or "Not saved yet")
    and carries **← Back to Motion Lab**, which closes the tab. PEIRA itself no
    longer opens it that way: the old pop-up path (`viewIn3D`) was removed on
    22 October 2026 once the overlay replaced it.
- **Coach-authored truth.**
  - The viewer runs Motion Lab's own engine on the document, untouched. The
    vendored copy is byte-identical (`sync.mjs --check`: all 10 files).
  - An authored stance always wins. A man without one gets exactly the
    "Position default" that Motion Lab's editor shows.
  - Nothing is inferred: no route, motion, assignment, leverage, coverage or
    meaning.

## The catch-point gap: documented, not fixed

When the ball arrives, a receiver can be slightly off the authored catch point:
- 0.07–0.08 yd on four of the five real pass plays;
- 0.48 yd on one;
- about 0.8 yd on the fixtures' go route (`realPlays.ts` → `catchGaps`).

Motion Lab starts a man at full speed. The viewer starts him from rest, and
matches his route's start and finish times.

There is no clean deterministic fix:
- Exactness everywhere needs bursts off the line of up to 20× an athlete's
  acceleration. That was tried in an earlier pass and reverted.
- Moving the catch point or the catch time would change coach-authored timing,
  which the owner decided is authoritative (30 September 2026).

The ball still arrives at his hands. **Left as is**, until the owner chooses
between realism and exactness.

## What production 3D still needs

These are in order. Every step is an owner action, and none has been done.

1. **Host the viewer.**
   - It is a static Vite build of the private repo
     `Beaudry13/peira-3d-viewer`: `npm run build` → `dist/` (~27 MB, of which
     the characters are ~17 MB).
   - Any static host works, for example a second Netlify site.
   - Serve it over HTTPS, at a stable origin (e.g. `https://3d.<peira-domain>`).
   - Before the build is public, read the viewer's `docs/LICENSES.md`. Today it
     says the athlete model and stadium are PEIRA's own work and that no
     external model, texture, team mark or likeness is included.
2. **Build the viewer with PEIRA's origins.**
   - Set `VITE_PEIRA_ORIGINS` to a comma-separated list of exact origins, for
     example `https://<peira-domain>,https://<site>.netlify.app` if coaches use
     both.
   - The default is localhost only, so a production PEIRA page cannot hand it a
     play until this is set.
   - Do not add wildcards. Leave Netlify deploy previews out unless someone
     wants to preview 3D there.
3. **Restrict who may frame the viewer.**
   - On the viewer host, set
     `Content-Security-Policy: frame-ancestors https://<peira-domain>` (same
     list as above).
   - Do not set `X-Frame-Options: DENY`.
   - Without this header any site could frame the viewer. It still could not
     hand it a play, because origins are checked, but it could show an empty
     stadium under its own name.
4. **Point PEIRA at it.**
   - Set `VITE_MOTION_LAB_3D_URL=https://<viewer host>/` in PEIRA's Netlify
     build environment, then build and publish. Netlify publishing is locked
     today, and unlocking it is the owner's call.
   - This is a build-time variable. Setting it changes nothing until the next
     publish.
   - When it is set, Preview 3D appears. When it is unset, the control is
     absent. No other code change is needed.
5. **Nothing else.**
   - No backend change and no CORS rule: the viewer never calls PEIRA's API.
     The play travels by `postMessage` from the coach's own signed-in page.
   - No token or session ever reaches the viewer.
   - PEIRA sets no Content-Security-Policy today, so its page may frame the
     viewer. If PEIRA ever adds a CSP, it must include `frame-src <viewer host>`.

## Known limits (accepted for now)

- **First open is slow.** It takes seconds while the viewer loads its engine and
  characters ("Building the stadium…"). Later opens use the browser cache.
- **Escape is the bar's.** Once the coach clicks into the 3D view, the view
  keeps its keys, and "Back to Motion Lab" stays on screen as the way out.
- **Phone layouts were not part of this pass.**
- **No handoff/pitch or second ball action** in the viewer, and no pause on a
  block release (from V6).
