/// <reference types="node" />
// File-scoped Node types: the stylesheet and the editor source are read from
// disk, as motionLabCss.test.ts does (vitest.config.ts sets `css: false`).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker, routeHandle, stroke } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * THE HANDLE AND THE CURSORS (ML-UX-9, SPEC §5.2, §5.3).
 *
 * The board carries ONE state class and CSS sets every cursor from it -
 * no inline cursor anywhere. Two of those cursors had never worked: nothing
 * applied the prototype's `.dragging`, so "grabbing" never showed during a
 * drag, and ML-UX-1's move from `mode-*` to `board-*` left the Adjust
 * anchors' grab rule pointing at a class that no longer existed.
 *
 * The handle gains a second, 40 px hit area for a finger. Its hit area still
 * starts at radius 26 rather than the SPEC's 16 (owner decision): 16 would
 * cover the marker's edge and selection ring, and a press meant to move the
 * man would draw instead.
 *
 * A tap on the handle is not a draw, the handle steps aside while anything is
 * dragged, and the window losing focus ends a drag rather than leaving the
 * board stuck in `board-moving`.
 *
 * THE TAP TESTS RUN FIRST. `drewOnce` is a page-load module variable
 * (ML-UX-1's decision), so the first real draw anywhere in this file ends the
 * pulse for every test after it - and "a tap leaves the pulse alone" can only
 * be asserted before that.
 */

installPointerStubs()

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(here, p), 'utf-8').replace(/\r\n/g, '\n')
const CSS = read('../motionLab.css')

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const fixture = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!
const byLabel = (play: Play, label: string) => play.players.find((p) => p.label === label)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}
function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
const boardClass = () => board().getAttribute('class')
const app = () => document.querySelector('.app') as HTMLElement
const pulsing = () => !app().classList.contains('drew-once')
const stripBtn = (name: string | RegExp) => within(document.querySelector('.bar.context') as HTMLElement).getByRole('button', { name })
/** Let the editor's 400 ms autosave quiet period pass. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const stored = (p: Play) => createLocalPlayRepository().listPlays().find((q) => q.id === p.id)!
const savedMan = (p: Play, id: string) => stored(p).players.find((q) => q.id === id)!
/** Where a man is standing now, read back out of the rendered board. */
const markerAt = (id: string) => playerMarker(id).getAttribute('transform')

/**
 * Where a coach's pointer really lands on the route handle: the middle of its
 * hit area, 42 units up the screen from the man - 2.1 yd downfield (U = 20).
 *
 * jsdom decides WHAT was hit from the event's target and WHERE from its
 * coordinates, so pressing the handle element at the man's own spot - which
 * `drawFromHandle` does - is a gesture no browser can make, and it is exactly
 * the one that hid the tap bug. These tests press where the handle is. The
 * handle is asserted unflipped, so the arithmetic cannot quietly go stale.
 */
const HANDLE_MID = (26 + 58) / 2
function onHandle(id: string, p: { x: number; y: number }): [number, number] {
  expect(routeHandle(id)!.getAttribute('transform')).toBeNull()
  return [p.x, p.y + HANDLE_MID / U]
}
/** Press the handle at `at`, move through `moves`, let go at the last point. */
const pressHandle = (id: string, at: [number, number], moves: [number, number][] = []) =>
  stroke(routeHandle(id)!, [at, ...moves])

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = fixture()
})
afterEach(cleanup)

describe('a tap on the handle is not a draw (SPEC §5.4, §5.7)', () => {
  it('press and release with no movement: no route, the pulse stays, nothing saves', async () => {
    open(play)
    const lt = byLabel(play, 'LT') // no route yet
    select(play, lt.id)
    await settle()
    const before = JSON.stringify(stored(play))
    expect(pulsing()).toBe(true)

    pressHandle(lt.id, onHandle(lt.id, lt))
    await settle()

    expect(savedMan(play, lt.id).path).toEqual([])
    expect(JSON.stringify(stored(play))).toBe(before)
    expect(pulsing()).toBe(true)
    expect(boardClass()).toBe('board board-idle')
    expect(routeHandle(lt.id)).not.toBeNull()
  })

  it('a wobble well under a yard is still a tap', async () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const [hx, hy] = onHandle(lt.id, lt)

    pressHandle(lt.id, [hx, hy], [[hx + 0.3, hy + 0.2], [hx - 0.2, hy + 0.4], [hx + 0.1, hy]])
    await settle()

    expect(savedMan(play, lt.id).path).toEqual([])
    expect(pulsing()).toBe(true)
  })

  it('a tap on a man who already has a route leaves it exactly as it was', async () => {
    open(play)
    const rb = byLabel(play, 'RB')
    expect(rb.path.length).toBeGreaterThan(1)
    select(play, rb.id)
    await settle()
    const before = JSON.stringify(stored(play))

    pressHandle(rb.id, onHandle(rb.id, rb))
    await settle()

    expect(savedMan(play, rb.id).path).toEqual(rb.path)
    expect(JSON.stringify(stored(play))).toBe(before)
    expect(pulsing()).toBe(true)
  })

  it('armed stays armed: a tap on the handle, or on the grass, draws nothing', async () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    key('d')
    expect(boardClass()).toBe('board board-armed')

    pressHandle(lt.id, onHandle(lt.id, lt))
    expect(boardClass()).toBe('board board-armed')

    // Before, a click on the grass while armed drew a straight line from the
    // man to it: the same measurement, the same bug.
    stroke(board(), [[lt.x + 6, lt.y + 3]])
    expect(boardClass()).toBe('board board-armed')
    await settle()

    expect(savedMan(play, lt.id).path).toEqual([])
    expect(pulsing()).toBe(true)
  })

  it('the line is a yard of pointer movement: 0.9 is a tap, 1.1 is a route - and only that uses up the pulse', async () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const [hx, hy] = onHandle(lt.id, lt)

    pressHandle(lt.id, [hx, hy], [[hx + 0.9, hy]])
    await settle()
    expect(savedMan(play, lt.id).path).toEqual([])
    expect(pulsing()).toBe(true)

    pressHandle(lt.id, [hx, hy], [[hx + 1.1, hy]])
    await settle()
    const path = savedMan(play, lt.id).path
    expect(path.length).toBeGreaterThan(1)
    // The route is what it always was: from the man, through the press.
    expect(path[0]).toEqual({ x: lt.x, y: lt.y })
    // THE FIRST REAL DRAW IN THIS FILE: no test after this one sees a pulse.
    expect(pulsing()).toBe(false)
  })

  it('a normal drag from the handle draws as it always did', async () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const [hx, hy] = onHandle(lt.id, lt)

    pressHandle(lt.id, [hx, hy], [[hx + 1, hy + 3], [hx + 3, hy + 7]])
    await settle()

    const path = savedMan(play, lt.id).path
    expect(path[0]).toEqual({ x: lt.x, y: lt.y })
    expect(path[path.length - 1].x).toBeCloseTo(hx + 3, 5)
    expect(path[path.length - 1].y).toBeCloseTo(hy + 7, 5)
    expect(boardClass()).toBe('board board-idle')
  })
})

describe('the pulse (SPEC §5.2; lifetime per ML-UX-1)', () => {
  it('reduced motion still turns it off, and the pulse itself is untouched', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.motion-lab-root \.app:not\(\.drew-once\) svg\.board \.route-handle \{\s*animation: none;/,
    )
    expect(CSS).toMatch(/\.motion-lab-root \.app:not\(\.drew-once\) svg\.board \.route-handle \{\s*animation: motion-lab-handle-pulse 1\.4s ease-in-out infinite;/)
    expect(CSS).toMatch(/@keyframes motion-lab-handle-pulse \{\s*0%,\s*100% \{\s*opacity: 1;\s*\}\s*50% \{\s*opacity: 0\.45;/)
  })
})

describe('one board state class at a time (SPEC §5.3)', () => {
  it('idle', () => {
    open(play)
    expect(boardClass()).toBe('board board-idle')
  })

  it('armed, then drawing', () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    key('d')
    expect(boardClass()).toBe('board board-armed')

    fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(lt.x + 1, lt.y + 1) })
    expect(boardClass()).toBe('board board-drawing')
  })

  it('moving a player, and back to idle when he is let go', () => {
    open(play)
    const rb = byLabel(play, 'RB')
    fireEvent.pointerDown(playerMarker(rb.id), { button: 0, pointerId: 1, ...client(rb.x, rb.y) })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(rb.x + 1, rb.y) })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(rb.x + 1, rb.y) })
    expect(boardClass()).toBe('board board-idle')
  })

  it('Adjust, then moving an anchor, then Adjust again', () => {
    open(play)
    select(play, byLabel(play, 'RB').id)
    key('e')
    expect(boardClass()).toBe('board board-adjusting')

    const anchor = board().querySelector('[data-anchor]')!
    fireEvent.pointerDown(anchor, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerUp(board(), { pointerId: 1, clientX: 12, clientY: 12 })
    expect(boardClass()).toBe('board board-adjusting')
  })

  it("moving a block's ×", () => {
    open(play)
    const marker = board().querySelector('[data-engage]')!
    fireEvent.pointerDown(marker, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerUp(board(), { pointerId: 1, clientX: 10, clientY: 10 })
    expect(boardClass()).toBe('board board-idle')
  })

  it('picking', () => {
    open(play)
    select(play, byLabel(play, 'LT').id)
    fireEvent.click(stripBtn('Blocks…'))
    expect(boardClass()).toBe('board board-picking')
  })

  it('Present, then telestrating', () => {
    open(play)
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))
    expect(boardClass()).toBe('board board-present')
    fireEvent.click(screen.getByRole('button', { name: '✎ Draw' }))
    expect(boardClass()).toBe('board board-tele')
  })

  it('a click on a man is a press and a release: moving, then idle again', () => {
    open(play)
    select(play, byLabel(play, 'RB').id)
    expect(boardClass()).toBe('board board-idle')
  })
})

/** The stylesheet's rules, @media flattened, comments stripped. */
function cssRules(css: string): { selectors: string[]; body: string; index: number }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { selectors: string[]; body: string; index: number }[] = []
  const walk = (src: string) => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open === -1) break
      let depth = 0
      let end = open
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++
        else if (src[end] === '}' && --depth === 0) break
      }
      const prelude = src.slice(i, open).trim()
      const body = src.slice(open + 1, end)
      if (prelude.startsWith('@media')) walk(body)
      else if (!prelude.startsWith('@')) out.push({ selectors: prelude.split(',').map((s) => s.trim()), body, index: out.length })
      i = end + 1
    }
  }
  walk(text)
  return out
}
const RULES = cssRules(CSS)
const R = '.motion-lab-root svg.board'
/** The cursor the LAST rule naming exactly this selector sets. */
function cursorOf(selector: string): string | undefined {
  const hits = RULES.filter((r) => r.selectors.includes(selector) && /cursor:/.test(r.body))
  const last = hits[hits.length - 1]
  return last?.body.match(/cursor:\s*([\w-]+)/)?.[1]
}
const indexOf = (selector: string) => Math.max(...RULES.filter((r) => r.selectors.includes(selector) && /cursor:/.test(r.body)).map((r) => r.index))

describe('the cursor contract, in the stylesheet', () => {
  it('idle: the board is default, a man is grab', () => {
    expect(cursorOf(`${R}.board-idle`)).toBeUndefined() // nothing set: default
    expect(cursorOf(`${R} .player`)).toBe('grab')
  })

  it('moving: grabbing, on the board and on whatever the pointer is over', () => {
    expect(cursorOf(`${R}.board-moving`)).toBe('grabbing')
    expect(cursorOf(`${R}.board-moving *`)).toBe('grabbing')
    expect(cursorOf(`${R}.board-moving .player`)).toBe('grabbing')
    // Last, so it outranks the handle's crosshair and the ×'s grab while a
    // drag passes over them.
    expect(indexOf(`${R}.board-moving *`)).toBeGreaterThan(indexOf(`${R} .route-handle`))
    expect(indexOf(`${R}.board-moving *`)).toBeGreaterThan(indexOf('.motion-lab-root .engage-marker'))
  })

  it('armed and drawing: crosshair, men included', () => {
    for (const s of [`${R}.board-armed`, `${R}.board-drawing`, `${R}.board-armed .player`, `${R}.board-drawing .player`]) {
      expect(cursorOf(s), s).toBe('crosshair')
    }
  })

  it('Adjust: the anchors are grab again (dead since ML-UX-1)', () => {
    expect(cursorOf(`${R}.board-adjusting .anchor`)).toBe('grab')
  })

  it('picking: pointer on the men he can pick, and only them', () => {
    expect(cursorOf(`${R}.board-picking .player.pickable`)).toBe('pointer')
    expect(cursorOf(`${R}.board-picking .player`)).toBe('default')
  })

  it('Present: the board is default, a man is pointer; telestrating is crosshair', () => {
    expect(cursorOf(`${R}.board-present`)).toBe('default')
    expect(cursorOf(`${R}.board-present .player`)).toBe('pointer')
    expect(cursorOf(`${R}.board-tele`)).toBe('crosshair')
    expect(cursorOf(`${R}.board-tele .player`)).toBe('crosshair')
  })

  it('the handle is crosshair', () => {
    expect(cursorOf(`${R} .route-handle`)).toBe('crosshair')
  })

  it('no rule names a class the board no longer carries', () => {
    const all = RULES.flatMap((r) => r.selectors).join('\n')
    expect(all).not.toMatch(/board-draw-armed|\.mode-edit|\.dragging\b|svg\.board\.setup\b|svg\.board\.present\b|svg\.board\.tele\b/)
  })

  it('and nothing sets a cursor inline', () => {
    for (const src of ['./MotionLabEditor.tsx', '../view/OverheadBoard.tsx']) {
      expect(read(src), src).not.toMatch(/style=\{\{[^}]*\bcursor\b/)
    }
  })
})

describe('the route handle', () => {
  const rects = (id: string) => [...routeHandle(id)!.querySelectorAll('rect')]

  it('a mouse keeps its 28 px hit area, from radius 26 out to the tip', () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const fine = rects(lt.id).find((r) => !r.classList.contains('hit-coarse'))!
    expect([fine.getAttribute('x'), fine.getAttribute('width')]).toEqual(['-14', '28'])
    expect([fine.getAttribute('y'), fine.getAttribute('height')]).toEqual(['-58', '32'])
    // 58 - 32 = 26: the approved start, not the SPEC's 16.
    expect(-(Number(fine.getAttribute('y')) + Number(fine.getAttribute('height')))).toBe(26)
  })

  it('a finger gets a 40 px one, in the markup, over the same span', () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const coarse = routeHandle(lt.id)!.querySelector('rect.hit-coarse')!
    expect(coarse).not.toBeNull()
    expect([coarse.getAttribute('x'), coarse.getAttribute('width')]).toEqual(['-20', '40'])
    expect([coarse.getAttribute('y'), coarse.getAttribute('height')]).toEqual(['-58', '32'])
    expect(coarse.getAttribute('fill')).toBe('transparent')
  })

  it('CSS shows the coarse one only on a coarse pointer', () => {
    expect(CSS).toMatch(/\.motion-lab-root svg\.board \.route-handle \.hit-coarse \{\s*display: none;\s*\}/)
    expect(CSS).toMatch(/@media \(pointer: coarse\) \{\s*\.motion-lab-root svg\.board \.route-handle \.hit-coarse \{\s*display: inline;/)
  })

  it('the stub, the arrowhead and its tip are as they were', () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    const h = routeHandle(lt.id)!
    const stub = h.querySelector('line')!
    expect([stub.getAttribute('y1'), stub.getAttribute('y2'), stub.getAttribute('stroke-width')]).toEqual(['-28', '-44', '4'])
    expect(h.querySelector('path')!.getAttribute('d')).toBe('M -7 -44 L 7 -44 L 0 -58 Z')
    expect(h.querySelector('circle')!.getAttribute('r')).toBe('7')
  })

  it('points downfield for both sides, and back only at the top of the window', () => {
    const fs = byLabel(play, 'FS')
    const lt = byLabel(play, 'LT')
    open(play)
    select(play, lt.id)
    expect(routeHandle(lt.id)!.getAttribute('transform')).toBeNull()
    select(play, fs.id)
    expect(routeHandle(fs.id)!.getAttribute('transform')).toBeNull()
    cleanup()
    localStorage.clear()

    const high: Play = { ...play, players: play.players.map((p) => (p.id === fs.id ? { ...p, y: Y_MAX - 1 } : p)) }
    open(high)
    select(high, fs.id)
    expect(routeHandle(fs.id)!.getAttribute('transform')).toBe('scale(1 -1)')
  })
})

describe('the handle steps aside while anything is dragged (SPEC §5.2)', () => {
  it('gone while he is being moved - nothing of it left to hit - and back when he is let go', () => {
    open(play)
    const lt = byLabel(play, 'LT')
    select(play, lt.id)
    expect(routeHandle(lt.id)).not.toBeNull()
    const from = markerAt(lt.id)

    fireEvent.pointerDown(playerMarker(lt.id), { button: 0, pointerId: 1, ...client(lt.x, lt.y) })
    expect(board().querySelector('[data-handle]')).toBeNull()
    expect(boardClass()).toBe('board board-moving')

    fireEvent.pointerMove(board(), { pointerId: 1, ...client(lt.x + 2, lt.y + 1) })
    expect(board().querySelector('[data-handle]')).toBeNull()
    // He still moves, and his selection ring - inside his group - with him.
    expect(markerAt(lt.id)).not.toBe(from)
    expect(playerMarker(lt.id).querySelector('circle[fill="none"][stroke="var(--accent)"]')).not.toBeNull()

    fireEvent.pointerUp(board(), { pointerId: 1, ...client(lt.x + 2, lt.y + 1) })
    expect(routeHandle(lt.id)).not.toBeNull()
    expect(boardClass()).toBe('board board-idle')
  })

  it("and while a block's × is dragged", () => {
    open(play)
    const marker = board().querySelector('[data-engage]')!
    const en = stored(play).engagements.find((x) => x.id === marker.getAttribute('data-engage'))!

    fireEvent.pointerDown(marker, { button: 0, pointerId: 1, ...client(en.point.x, en.point.y) })
    // Pressing the × selects its blocker - whose handle waits for the drag.
    expect(board().querySelector('[data-handle]')).toBeNull()
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(en.point.x, en.point.y) })
    expect(routeHandle(en.a)).not.toBeNull()
  })
})

describe('the window losing focus ends a drag (ML-UX-9)', () => {
  const blur = () => act(() => void fireEvent.blur(window))

  it('a man stops where he had got to, saves there, and the next drag works', async () => {
    open(play)
    const rb = byLabel(play, 'RB')
    select(play, rb.id)
    await settle()

    fireEvent.pointerDown(playerMarker(rb.id), { button: 0, pointerId: 1, ...client(rb.x, rb.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(rb.x + 2, rb.y) })
    blur()

    expect(boardClass()).toBe('board board-idle')
    expect(routeHandle(rb.id)).not.toBeNull()
    const where = markerAt(rb.id)
    // The pointer carries on and lets go somewhere; he does not follow.
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(rb.x + 6, rb.y + 3) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(rb.x + 6, rb.y + 3) })
    expect(markerAt(rb.id)).toBe(where)
    expect(boardClass()).toBe('board board-idle')

    // Autosave went on as usual, for the move that happened - no rollback.
    await settle()
    expect(savedMan(play, rb.id).x).toBeCloseTo(rb.x + 2, 5)

    fireEvent.pointerDown(playerMarker(rb.id), { button: 0, pointerId: 2, ...client(rb.x + 2, rb.y) })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerMove(board(), { pointerId: 2, ...client(rb.x + 3, rb.y) })
    fireEvent.pointerUp(board(), { pointerId: 2, ...client(rb.x + 3, rb.y) })
    expect(boardClass()).toBe('board board-idle')
    await settle()
    expect(savedMan(play, rb.id).x).toBeCloseTo(rb.x + 3, 5)
  })

  it('an anchor stops, Adjust stays on, and the next anchor drag works', async () => {
    open(play)
    const rb = byLabel(play, 'RB')
    select(play, rb.id)
    key('e')
    const a = rb.path[1]
    const anchor = () => board().querySelector('[data-anchor="1"]')!

    fireEvent.pointerDown(anchor(), { button: 0, pointerId: 1, ...client(a.x, a.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(a.x + 2, a.y) })
    blur()

    expect(boardClass()).toBe('board board-adjusting')
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(a.x + 5, a.y + 2) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(a.x + 5, a.y + 2) })
    await settle()
    expect(savedMan(play, rb.id).path[1].x).toBeCloseTo(a.x + 2, 5)
    expect(savedMan(play, rb.id).path[1].y).toBeCloseTo(a.y, 5)

    fireEvent.pointerDown(anchor(), { button: 0, pointerId: 2, ...client(a.x + 2, a.y) })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerMove(board(), { pointerId: 2, ...client(a.x + 3, a.y) })
    fireEvent.pointerUp(board(), { pointerId: 2, ...client(a.x + 3, a.y) })
    expect(boardClass()).toBe('board board-adjusting')
    await settle()
    expect(savedMan(play, rb.id).path[1].x).toBeCloseTo(a.x + 3, 5)
  })

  it("a block's × stops where it had got to, and the next drag works", async () => {
    open(play)
    const marker = () => board().querySelector('[data-engage]')!
    const id = marker().getAttribute('data-engage')!
    const p0 = stored(play).engagements.find((x) => x.id === id)!.point
    const point = () => stored(play).engagements.find((x) => x.id === id)!.point

    fireEvent.pointerDown(marker(), { button: 0, pointerId: 1, ...client(p0.x, p0.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(p0.x + 2, p0.y) })
    blur()

    expect(boardClass()).toBe('board board-idle')
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(p0.x + 5, p0.y + 2) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(p0.x + 5, p0.y + 2) })
    await settle()
    expect(point().x).toBeCloseTo(p0.x + 2, 5)
    expect(point().y).toBeCloseTo(p0.y, 5)

    fireEvent.pointerDown(marker(), { button: 0, pointerId: 2, ...client(p0.x + 2, p0.y) })
    expect(boardClass()).toBe('board board-moving')
    fireEvent.pointerMove(board(), { pointerId: 2, ...client(p0.x + 3, p0.y) })
    fireEvent.pointerUp(board(), { pointerId: 2, ...client(p0.x + 3, p0.y) })
    expect(boardClass()).toBe('board board-idle')
    await settle()
    expect(point().x).toBeCloseTo(p0.x + 3, 5)
  })
})
