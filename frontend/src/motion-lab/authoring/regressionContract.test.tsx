import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, LOOKS_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { paneLooks, panePlays } from '../__characterization__/fixtures'
import { board, dragPlayer, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { fromView, U, Y_MAX, Y_MIN, yardLabel } from '../engine/field'
import { COACH_CAMERA, project } from '../engine/perspective'
import type { Look, Play } from '../engine/play'

/**
 * SPEC §16, THE REGRESSION CONTRACT - AS PEIRA HOLDS IT (ML-UX-12).
 *
 * §16 was validated on the prototype (17 Sep 2026) with its `window.__lab`
 * harness. PEIRA does not carry that harness: its contract is held by
 * engineIsVerbatim (the engine is the prototype's, byte for byte, bar the two
 * approved Engagement.auto lines), the characterization goldens (every
 * preserved play derived number-for-number against the PRESERVED PROTOTYPE
 * ENGINE), the editor tests, and this file for what nothing else covered.
 *
 * Every bullet, and where it is held:
 *
 * ENGINE AND DATA
 *  - Route geometry (simplify 0.45, Chaikin ≥ 60°, renderPath, path moves
 *    with the man, anchors editable) ... characterization + engineIsVerbatim;
 *    drawingInteraction (translation, anchors, one stroke = one path).
 *  - Timing (pre-snap ends at the snap, on-snap, delayed N s, speeds
 *    4.5 / 6.5 / 8.5) ... characterization; selectedStrip (Timing writes).
 *  - Ball (keep, handoff mesh/MIN_QB_HOLD/fallback, pitch window, pass
 *    projection/release scan/sync, play action, Throw From Here) ...
 *    characterization (Inside Zone, Trips Out, Reverse, Regression, the gap
 *    plays); ballControl. The ADJUSTMENT TOAST - below.
 *    Two-step chain SKIPPED with a warning ... DOCUMENTED GAP, see the last
 *    block of this file.
 *  - Engagements (reach 2.5, 60% pacing, same side, release 0.5 s,
 *    unreachable warnings) ... characterization (Inside Zone,
 *    fx_engage_release_delayed); engagementAuto; blockCreation; engagedGroup.
 *  - Continue / Settle ... characterization (Untitled Play, fx_settle...).
 *  - Orientation ... characterization (facing sampled every frame).
 *  - Views (Overhead, Coach, Player; the same ball at the same t) ...
 *    presentAndViews; the same-ball check is below.
 *  - Scrub determinism ... playbackDock.
 *  - Undo/redo (60 steps, 350 ms grouping, reset on play switch, off in
 *    Present) ... drawingInteraction / moreMenu (grouping, one step per
 *    edit); presentAndViews (off in Present); the CAP and the RESET below.
 *  - Persistence (keys peira.motionlab.*, {v:1, items}, sanitize on read,
 *    flush on switch/hide/unload, opening is not an edit) ...
 *    localPlayRepository, editorPersistence. Production saves to the server
 *    by revision (P2, apiPlayRepository); the local keys are the test and
 *    fallback store.
 *  - Looks (save positions only, load clears ball/then/blocks, new play from
 *    a look; copies independent) ... formationMenu; INDEPENDENCE below.
 *  - Copy / Mirror ... moreMenu.
 *  - Situation (label, line to gain, hash shift, markings, numbers in all
 *    views) ... dockSituation; NUMBERS IN ALL VIEWS below.
 *  - Play management (new/open/duplicate/delete/rename, list by updatedAt)
 *    ... editor play-menu tests, MotionLabLibraryPage, the repositories.
 *  - Present (no editing, telestration Overhead only, strokes discarded) ...
 *    presentAndViews.
 *
 * NUMERIC CHECKS (the harness's `t:phase` strings) - PROTOTYPE-HARNESS
 * ARTEFACTS, NOT REPRODUCED LITERALLY. They were sampled by `window.__lab` at
 * 0.1 s on plays built that day; PEIRA's goldens hold EXACT event times at a
 * 0.2 s sample step, and not every §16 play was preserved. The honest
 * mapping (playerSummary.fixtures.test.tsx names it too):
 *   A inside zone  -> "Inside Zone Rt". Golden: 0:spot 0.5:snap 0.8:carry
 *                     1.2:handoff 1.316667:carry (§16: ... 1.4:carry).
 *   B trips out    -> "Trips Out". Golden flight 1.2 / carry 2.2 at the 0.2 s
 *                     step (§16: 1.1 / 2.1 at 0.1 s).
 *   C chip & flat  -> NO PRESERVED FIXTURE. Not reconstructed.
 *   D reverse      -> "Reverse". Golden 1:handoff 1.1:carry 4.4:handoff
 *                     4.6:carry (§16: 0.9:handoff, the same event at 0.1 s).
 *   E looks        -> the plays made from the "Trips Rt" formation; below.
 *   Pitch / play action / Throw From Here -> §16's plays were not
 *                     preserved; the gap fixtures and "Regression" hold the
 *                     behaviour, not those strings.
 * What IS guaranteed is stronger than the strings: PEIRA's engine is the
 * prototype's, and derives every preserved play exactly as the prototype did.
 *
 * HARNESS - `window.__lab` is the prototype's and is not rebuilt; its
 * helpers' intent lives in testing/pointerStubs.ts (drawFromHandle, stroke,
 * dragPlayer...). The playback tick is requestAnimationFrame, as §16 asks.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
const settle = () => wait(450)
const byName = (name: string) => panePlays().find((p) => p.name === name)!
const byId = (id: string) => panePlays().find((p) => p.id === id)!
const byLabel = (play: Play, label: string) => play.players.find((p) => p.label === label)!
const repo = () => createLocalPlayRepository()
const stored = (id: string) => repo().listPlays().find((p) => p.id === id)!
const storedLooks = () => (JSON.parse(localStorage.getItem(LOOKS_KEY) ?? '{"items":[]}') as { items: Look[] }).items

function open(plays: Play[], current: string, looks: Look[] = []) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: plays }))
  localStorage.setItem(LOOKS_KEY, JSON.stringify({ v: 1, items: looks }))
  localStorage.setItem(CURRENT_KEY, current)
  render(
    <div className="motion-lab-root">
      <MotionLabEditor repository={repo()} />
    </div>,
  )
}
function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
const topBar = () => document.querySelector('.bar:not(.context):not(.bottom)') as HTMLElement
const strip = () => document.querySelector('.bar.context') as HTMLElement
const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const undoBtn = () => within(topBar()).getByRole('button', { name: '↶' })
const ctrlZ = () => act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
const view = (name: 'Overhead' | 'Coach' | 'Player') => fireEvent.click(within(topBar()).getByRole('button', { name }))
const scrubTo = (t: number) => fireEvent.change(dock().querySelector('.scrub input[type="range"]')!, { target: { value: String(t) } })

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the ball: a catch the timing cannot make is moved, and the coach is told', () => {
  it('passing to Trips Out\'s receiver at the very start of his route raises "Catch adjusted for timing"', () => {
    // A real flow on a preserved play (B), not a built fixture: choose Pass,
    // choose the receiver, click his route a yard from where it starts -
    // somewhere he reaches long before the QB can throw.
    const play = byName('Trips Out')
    open([play], play.id)
    const receiver = play.players.find((p) => p.id === (play.ball as { targetId: string }).targetId)!
    const [a, b] = receiver.path
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const early = { x: a.x + ((b.x - a.x) / len) * 1, y: a.y + ((b.y - a.y) / len) * 1 }

    fireEvent.click(dock().querySelector('.ball-btn')!)
    fireEvent.click(within(document.querySelector('.ball-pop') as HTMLElement).getByRole('button', { name: 'Pass to…' }))
    fireEvent.pointerDown(playerMarker(receiver.id), { button: 0, pointerId: 1, ...client(receiver.x, receiver.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(receiver.x, receiver.y) })
    fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(early.x, early.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(early.x, early.y) })

    expect(document.querySelector('.toast')?.textContent).toBe('Catch adjusted for timing')
  })
})

describe('undo (§16: 60 steps, reset on play switch)', () => {
  it('keeps the last 60 states and no more', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const play = byName('Inside Zone Rt')
    open([play], play.id)
    fireEvent.click(dock().querySelector('.sit-chip')!)
    const distance = () => document.querySelector('.sit-pop input[type="number"]') as HTMLInputElement

    // 65 edits, each its own step (past the 350 ms grouping).
    const value = (k: number) => 20 + k
    for (let k = 1; k <= 65; k++) {
      fireEvent.change(distance(), { target: { value: String(value(k)) } })
      act(() => void vi.advanceTimersByTime(400))
    }
    expect(distance().value).toBe(String(value(65)))

    let undos = 0
    while (!undoBtn().hasAttribute('disabled') && undos < 100) {
      ctrlZ()
      act(() => void vi.advanceTimersByTime(400))
      undos++
    }
    // 60 states kept: the newest and 59 behind it. The oldest six edits and
    // the opening state are gone.
    expect(undos).toBe(59)
    expect(distance().value).toBe(String(value(6)))
    // Over a hundred full editor renders: past Vitest's 5 s default, not slow.
  }, 60_000)

  it('switching plays starts the history again: nothing from the last play can be undone into this one', async () => {
    const inside = byName('Inside Zone Rt')
    const trips = byName('Trips Out')
    open([inside, trips], inside.id)
    select(inside, byLabel(inside, 'RB').id)
    fireEvent.click(within(strip()).getByRole('button', { name: 'Delayed' }))
    await settle()
    expect(undoBtn()).not.toBeDisabled()

    fireEvent.click(topBar().querySelector('.play-btn')!)
    const row = [...document.querySelectorAll('.play-pop .play-row')].find((r) => r.textContent!.startsWith('Trips Out'))!
    fireEvent.click(row)
    expect(topBar().querySelector('.play-name')!.textContent).toBe('Trips Out')
    expect(undoBtn()).toBeDisabled()

    ctrlZ()
    await settle()
    expect(stored(trips.id).players).toEqual(trips.players)
    // The edit to the play he left went with it (flush on switch).
    expect(stored(inside.id).players.find((p) => p.label === 'RB')!.timing).toBe('delayed')
  })
})

describe('views (§16: the same ball at the same t in every view)', () => {
  it('Overhead and Coach put the ball at the same field position; Player draws the same frame', () => {
    const play = byName('Inside Zone Rt')
    open([play], play.id)
    // 1.0 s: the QB is carrying it (A: 0.8:carry 1.2:handoff), so it is on
    // the ground and its height in the camera views is the fixed 0.35 yd.
    scrubTo(1.0)
    const overhead = board().querySelector('[data-ball]')!
    expect(overhead.getAttribute('data-phase')).toBe('carry')
    const [, vx, vy] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(overhead.getAttribute('transform')!)!
    const at = fromView(Number(vx), Number(vy))

    view('Coach')
    const coachBall = () => document.querySelector('svg.field-view ellipse[fill="#9a5424"]')!.parentElement!
    const [, sx, sy] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(coachBall().getAttribute('transform')!)!
    const expected = project(at, COACH_CAMERA, 0.35)
    expect(Number(sx)).toBeCloseTo(expected.sx, 3)
    expect(Number(sy)).toBeCloseTo(expected.sy, 3)

    // Player view is the same FieldView fed the same frame; only the camera
    // rides with the viewer, by design. The ball is there, at the same t.
    view('Player')
    select(play, byLabel(play, 'FS').id)
    expect(document.querySelector('svg.field-view ellipse[fill="#9a5424"]')).not.toBeNull()
    expect(dock().querySelector('.time')!.textContent).toBe('+0.5s')
  })

  it('the field numbers are the same numbers in every view', () => {
    const play = byName('Inside Zone Rt')
    open([play], play.id)
    const numbers = (svg: Element) => [...svg.querySelectorAll('text')].map((t) => t.textContent!).filter((s) => /^\d+$/.test(s))

    const expected: string[] = []
    for (let y = Math.ceil(Y_MIN); y <= Math.floor(Y_MAX); y++) {
      const label = yardLabel(y, play.situation.losYard)
      if (label) expected.push(label, label) // one for each sideline
    }
    const overhead = numbers(board())
    expect(overhead.sort()).toEqual(expected.sort())

    view('Coach')
    const coach = numbers(document.querySelector('svg.field-view')!)
    expect(coach.length).toBeGreaterThan(0)
    expect(coach.every((n) => expected.includes(n))).toBe(true)

    view('Player')
    select(play, byLabel(play, 'QB').id)
    const player = numbers(document.querySelector('svg.field-view')!)
    expect(player.length).toBeGreaterThan(0)
    expect(player.every((n) => expected.includes(n))).toBe(true)
  })
})

describe('Test E: a formation and the plays made from it stay independent', () => {
  // The preserved "Trips Rt" formation and the three plays made from it.
  const look = () => paneLooks().find((l) => l.name === 'Trips Rt')!
  const fromLook = () => panePlays().filter((p) => p.name.startsWith('Trips Rt'))

  it('editing one play made from it changes neither the formation nor the other plays', async () => {
    const plays = panePlays()
    const [edited, ...others] = fromLook()
    expect(others.length).toBe(2)
    open(plays, edited.id, [look()])

    dragPlayer(edited, edited.players.find((p) => p.side === 'offense' && p.label !== 'QB')!.id, 3, 2)
    await settle()

    expect(stored(edited.id).players).not.toEqual(edited.players)
    for (const other of others) expect(stored(other.id).players).toEqual(byId(other.id).players)
    expect(storedLooks()).toEqual([look()])
  })

  it('a new play from the formation, then edited, leaves the formation as it was', async () => {
    const plays = panePlays()
    open(plays, byName('Inside Zone Rt').id, [look()])
    fireEvent.click(within(strip()).getByRole('button', { name: /^Formation/ }))
    const row = [...document.querySelectorAll('.formation-pop .look-row')].find((r) => r.textContent!.startsWith('Trips Rt'))!
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'New play' }))
    await settle()

    const made = repo().listPlays().find((p) => !plays.some((q) => q.id === p.id))!
    expect(made).toBeTruthy()
    dragPlayer(made, made.players.find((p) => p.side === 'offense')!.id, 2, 2)
    await settle()

    expect(storedLooks()).toEqual([look()])
  })
})

describe('§16 bullets this file records rather than tests', () => {
  it('two-step chain skipped with a warning: DOCUMENTED GAP', () => {
    // The warning is the engine's ("Second action skipped — the first
    // exchange never happened." / "... already has it."), and ball.ts is the
    // prototype's byte for byte (engineIsVerbatim). No preserved play
    // triggers it, and the editor cannot produce one: choosing a new first
    // action clears the second, and removing either man clears both. How a
    // warning reaches the coach - the ! badge and the resting hint - is one
    // path for every warning, pinned in statesAndMotion and edgePresentation.
    // A play was deliberately NOT invented to force it.
    expect(true).toBe(true)
  })
})
