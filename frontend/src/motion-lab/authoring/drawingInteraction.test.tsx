import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker, routeHandle, stroke } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * DRAWING WITHOUT A MODE (ML-UX-1).
 *
 * The editor used to ask the coach to choose Move or Draw, and then read every
 * drag through that choice. It does not any more: the pointer's TARGET decides.
 * Drag a man and he moves. Drag the gold handle beside the man you picked and
 * you draw his assignment. D and the Draw button arm the next drag, for coaches
 * who would rather not hunt for the handle.
 *
 * These tests are about that choice and nothing else. What a route MEANS -
 * simplification, sampling, timing, the ball - belongs to the engine, is
 * unchanged, and is pinned by __characterization__.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const repo = () => createLocalPlayRepository()
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))

/** "Inside Zone Rt": a real play, so nothing here is drawn on an empty field. */
const fixture = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={repo()} />)
}

/** The draft stroke: the dashed gold polyline the board draws while drawing. */
const draftLine = () => board().querySelector('polyline[stroke-dasharray="8 6"]')

/**
 * Let the editor's 400 ms autosave quiet period pass.
 *
 * Reading a route back through the repository is how these tests avoid
 * asserting on SVG coordinates, but it means waiting for the same debounce a
 * coach's browser waits for.
 */
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

/** Where a man is standing now, read back out of the rendered board. */
function markerAt(id: string): { x: number; y: number } {
  const t = playerMarker(id).getAttribute('transform')!
  const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(t)!
  return { x: Number(x), y: Number(y) }
}

const savedPlay = (play: Play) => repo().listPlays().find((p) => p.id === play.id)!
const pathOf = (play: Play, id: string) => savedPlay(play).players.find((p) => p.id === id)!.path

let play: Play
let Y: string
beforeEach(() => {
  localStorage.clear()
  play = fixture()
  Y = play.players.find((p) => p.label === 'Y')!.id
})
afterEach(cleanup)

describe('the pointer target decides', () => {
  it('dragging a marker moves the player - it never draws', async () => {
    open(play)
    const before = markerAt(Y)
    const p = play.players.find((pl) => pl.id === Y)!

    fireEvent.pointerDown(playerMarker(Y), { button: 0, pointerId: 1, ...client(p.x, p.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(p.x + 3, p.y + 4) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + 3, p.y + 4) })
    await settle()

    expect(markerAt(Y)).not.toEqual(before)
    // He was carrying no assignment and still is: the drag was a move.
    expect(pathOf(play, Y)).toEqual([])
  })

  it('dragging the gold handle draws the assignment, anchored at the player', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    drawFromHandle(play, Y, [
      [p.x + 1, p.y + 3],
      [p.x + 3, p.y + 7],
    ])
    await settle()

    const path = pathOf(play, Y)
    expect(path.length).toBeGreaterThan(1)
    expect(path[0]).toEqual({ x: p.x, y: p.y })
    // Drawing is not moving: he is standing exactly where he was.
    expect(savedPlay(play).players.find((q) => q.id === Y)).toMatchObject({ x: p.x, y: p.y })
  })

  it('there is no handle until a player is selected, and none on anyone else', async () => {
    open(play)
    expect(routeHandle(Y)).toBeNull()

    select(play, Y)

    expect(routeHandle(Y)).not.toBeNull()
    expect(play.players.filter((p) => p.id !== Y).every((p) => routeHandle(p.id) === null)).toBe(true)
  })
})

describe('arming', () => {
  it('the Draw assignment button arms drawing, and the next field drag draws', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    fireEvent.click(screen.getByRole('button', { name: /Draw assignment|Redraw/ }))
    // Started on empty grass, nowhere near the man - and it still draws HIS route.
    stroke(board(), [
      [p.x + 6, p.y + 2],
      [p.x + 7, p.y + 6],
    ])
    await settle()

    expect(pathOf(play, Y)[0]).toEqual({ x: p.x, y: p.y })
  })

  it('D arms drawing for the selected player', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    key('d')
    stroke(board(), [
      [p.x + 5, p.y + 1],
      [p.x + 6, p.y + 5],
    ])
    await settle()

    expect(pathOf(play, Y).length).toBeGreaterThan(1)
  })

  it('an armed stroke may start on the selected man himself', async () => {
    // A coach who just pressed D and puts the pointer down on the man he picked
    // means to draw from him, not to nudge him. Armed outranks "marker = move".
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    const before = markerAt(Y)

    key('d')
    stroke(playerMarker(Y), [
      [p.x, p.y],
      [p.x + 1, p.y + 4],
      [p.x + 2, p.y + 8],
    ])
    await settle()

    expect(pathOf(play, Y).length).toBeGreaterThan(1)
    expect(markerAt(Y)).toEqual(before)
  })

  it('D with nobody selected does nothing at all', async () => {
    open(play)
    const untouched = JSON.stringify(savedPlay(play).players)

    key('d')
    stroke(board(), [
      [20, 1],
      [22, 5],
    ])
    await settle()

    expect(JSON.stringify(savedPlay(play).players)).toBe(untouched)
  })

  it('an armed stroke started on ANOTHER man re-targets to him', async () => {
    open(play)
    const X = play.players.find((p) => p.label === 'X')!
    select(play, Y)

    key('d')
    stroke(playerMarker(X.id), [
      [X.x, X.y],
      [X.x + 1, X.y + 4],
      [X.x + 2, X.y + 8],
    ])
    await settle()

    expect(pathOf(play, X.id).length).toBeGreaterThan(1)
    expect(pathOf(play, Y)).toEqual([])
  })
})

describe('getting out of it', () => {
  it('Esc mid-stroke discards the draft and leaves the old route alone', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()
    const first = pathOf(play, Y)
    expect(first.length).toBeGreaterThan(1)

    // A second stroke, abandoned half way.
    drawFromHandle(play, Y, [[p.x - 4, p.y + 5]], { finish: false })
    key('Escape')
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x - 4, p.y + 5) })
    await settle()

    expect(pathOf(play, Y)).toEqual(first)
    expect(draftLine()).toBeNull()
  })

  it('Esc while merely armed cancels the arming and touches no route', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    key('d')
    key('Escape')
    // No longer armed, so this is an ordinary drag of the man.
    const before = markerAt(Y)
    fireEvent.pointerDown(playerMarker(Y), { button: 0, pointerId: 1, ...client(p.x, p.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(p.x + 2, p.y + 2) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + 2, p.y + 2) })
    await settle()

    expect(pathOf(play, Y)).toEqual([])
    expect(markerAt(Y)).not.toEqual(before)
  })

  it('the window losing focus throws an in-flight stroke away', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    drawFromHandle(play, Y, [[p.x + 3, p.y + 7]], { finish: false })
    act(() => void fireEvent.blur(window))
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + 3, p.y + 7) })
    await settle()

    expect(pathOf(play, Y)).toEqual([])
    expect(draftLine()).toBeNull()
  })

  it('a stroke under a yard is an accidental click: nothing is drawn', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()
    const first = pathOf(play, Y)

    drawFromHandle(play, Y, [[p.x + 0.3, p.y + 0.2]])
    await settle()

    expect(pathOf(play, Y)).toEqual(first)
  })

  it('a drag off the field stays inside it, and still commits', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    drawFromHandle(play, Y, [
      [p.x + 2, p.y + 5],
      [-40, 90],
    ])
    await settle()

    const path = pathOf(play, Y)
    expect(path.length).toBeGreaterThan(1)
    for (const q of path) {
      expect(q.x).toBeGreaterThanOrEqual(0)
      expect(q.x).toBeLessThanOrEqual(53.33)
      expect(q.y).toBeLessThanOrEqual(17)
      expect(q.y).toBeGreaterThanOrEqual(-13)
    }
  })
})

describe('what drawing must not have changed', () => {
  it('a second stroke replaces the whole route, it never appends', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [
      [p.x + 1, p.y + 3],
      [p.x + 2, p.y + 9],
    ])
    await settle()
    const first = pathOf(play, Y)

    drawFromHandle(play, Y, [[p.x - 5, p.y + 4]])
    await settle()
    const second = pathOf(play, Y)

    expect(second).not.toEqual(first)
    expect(second[0]).toEqual({ x: p.x, y: p.y })
    // Replaced, not joined onto: the far end of the first stroke is gone.
    expect(second.some((q) => q.y > p.y + 8)).toBe(false)
  })

  it('undo puts the previous route back, in one step', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()
    const first = pathOf(play, Y)

    drawFromHandle(play, Y, [[p.x - 5, p.y + 3]])
    await settle()
    expect(pathOf(play, Y)).not.toEqual(first)

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(pathOf(play, Y)).toEqual(first)
  })

  it('undo restores the route, not what the coach was doing', async () => {
    // Interaction is not authoring state and is not in the history. After an
    // undo the coach is simply resting, never silently re-armed.
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(board().classList.contains('board-idle')).toBe(true)
    // ...and the handle is back, because resting is when it belongs.
    expect(routeHandle(Y)).not.toBeNull()
  })

  it('Adjust still drags anchors, and the handle steps aside while it does', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [
      [p.x + 1, p.y + 4],
      [p.x + 4, p.y + 8],
    ])
    await settle()
    const before = pathOf(play, Y)

    key('e')
    expect(routeHandle(Y)).toBeNull()
    const anchor = board().querySelector('[data-anchor="1"]')!
    fireEvent.pointerDown(anchor, { button: 0, pointerId: 1, ...client(before[1].x, before[1].y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(before[1].x + 2, before[1].y + 1) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(before[1].x + 2, before[1].y + 1) })
    await settle()

    const after = pathOf(play, Y)
    expect(after[1]).not.toEqual(before[1])
    expect(after[0]).toEqual(before[0])
    // Still adjusting: one anchor drag does not end the session.
    expect(board().classList.contains('board-adjusting')).toBe(true)
  })

  it('Delete clears the assignment and leaves anchor editing', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()
    key('e')
    expect(board().classList.contains('board-adjusting')).toBe(true)

    key('Delete')
    await settle()

    expect(pathOf(play, Y)).toEqual([])
    expect(board().classList.contains('board-idle')).toBe(true)
  })

  it('a drawn route travels with the man when he is moved afterwards', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])
    await settle()
    const before = pathOf(play, Y)

    fireEvent.pointerDown(playerMarker(Y), { button: 0, pointerId: 1, ...client(p.x, p.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(p.x + 3, p.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + 3, p.y) })
    await settle()

    const after = pathOf(play, Y)
    expect(after).toHaveLength(before.length)
    after.forEach((q, i) => {
      expect(q.x - before[i].x).toBeCloseTo(3, 5)
      expect(q.y).toBeCloseTo(before[i].y, 5)
    })
  })
})

describe('the board says what a drag will do', () => {
  it('rests, arms, draws, and comes back to rest', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!
    expect(board().classList.contains('board-idle')).toBe(true)

    key('d')
    expect(board().classList.contains('board-draw-armed')).toBe(true)

    stroke(playerMarker(Y), [
      [p.x, p.y],
      [p.x + 2, p.y + 6],
    ], { finish: false })
    expect(board().classList.contains('board-drawing')).toBe(true)
    expect(draftLine()).not.toBeNull()

    act(() => void fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + 2, p.y + 6) }))
    expect(board().classList.contains('board-idle')).toBe(true)
    expect(draftLine()).toBeNull()
  })

  it('drops the handle pulse once a route has been drawn', async () => {
    open(play)
    select(play, Y)
    const p = play.players.find((pl) => pl.id === Y)!

    drawFromHandle(play, Y, [[p.x + 2, p.y + 6]])

    expect(document.querySelector('.app')!.classList.contains('drew-once')).toBe(true)
  })
})
