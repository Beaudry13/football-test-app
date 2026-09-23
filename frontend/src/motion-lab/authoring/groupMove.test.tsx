/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs } from '../testing/pointerStubs'
import { BOUNDS, U, Y_MAX } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Play } from '../engine/play'
import { clampDelta, groupIds, lineIds, translate, type Movable } from './groupMove'
import { withRoles } from './roles'

/**
 * MOVING MEN IN GROUPS (P3.3).
 *
 * A coach moving a look to a hash, or sliding his front, should not drag
 * eleven men one at a time - and what those men are doing has to come with
 * them. Two things are easy to get wrong and are pinned here: the delta is
 * clamped ONCE for the whole group (clamping point by point squashes a
 * formation against a sideline), and a block point only travels when both of
 * its men do.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}
const strip = () => document.querySelector('.bar.context') as HTMLElement
const stripBtn = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const pop = () => strip().querySelector('.popover') as HTMLElement
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const manIn = (play: Play, id: string) => stored(play).players.find((p) => p.id === id)!

/** Arm one of the Formation menu's moves. */
function arm(name: string | RegExp) {
  fireEvent.click(stripBtn(/^Formation/))
  fireEvent.click(within(pop()).getByRole('button', { name }))
}
/** Drag the armed group from one field point to another. */
async function drag(from: [number, number], to: [number, number], { finish = true } = {}) {
  fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(from[0], from[1]) })
  fireEvent.pointerMove(board(), { pointerId: 1, ...client(to[0], to[1]) })
  if (finish) {
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(to[0], to[1]) })
    act(() => void fireEvent.keyDown(window, { key: 'Enter' }))
    await settle()
  }
}
const esc = () => act(() => void fireEvent.keyDown(window, { key: 'Escape' }))

let play: Play
const man = (label: string, side: 'offense' | 'defense' = 'offense') =>
  play.players.find((p) => p.label === label && p.side === side)!

beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

// ---------------------------------------------------------------------------
// Who moves
// ---------------------------------------------------------------------------

describe('finding the line without knowing a single position name', () => {
  const lineman = (id: string, x: number, y = -0.7): Player => ({
    id, side: 'offense', label: id, x, y, path: [], timing: 'on-snap', delay: 0.5, speed: 'controlled',
  })
  const withLine = (men: Player[], snapperId = 'C') =>
    men.map((p) => (p.id === snapperId ? { ...p, role: 'snapper' as const } : p))
  const labelsOf = (men: Player[]) => [...lineIds(men).ids].sort()

  it('takes the normal five', () => {
    const men = withLine([lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3)])
    const far = { ...lineman('X', 8), id: 'X' }
    expect(labelsOf([...men, far])).toEqual(['C', 'LG', 'LT', 'RG', 'RT'])
  })

  it('takes an unbalanced line, a sixth lineman and a tackle over', () => {
    const unbalanced = withLine([lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3), lineman('TO', 32.1)])
    expect(labelsOf(unbalanced)).toHaveLength(6)

    // Tackle over: the extra man is on the LEFT, so the chain has to walk
    // both ways from the snapper, not just outward on one side.
    const tackleOver = withLine([lineman('TO', 21.3), lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3)])
    expect(labelsOf(tackleOver)).toHaveLength(6)
  })

  it('stops at a real split, and keeps men who are simply wide off it', () => {
    const men = withLine([
      lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3),
      lineman('SLOT', 36.0), // 5.7 yd away: a split end, not a lineman
      { ...lineman('RB', 24.7, -5.5), speed: 'normal' as const }, // behind the line
    ])
    expect(labelsOf(men)).toEqual(['C', 'LG', 'LT', 'RG', 'RT'])
  })

  it('takes an attached tight end too, because alignment cannot tell them apart', () => {
    // A tight end attached 2.0 yd outside the tackle lines up exactly where a
    // sixth lineman would. The editor says how many men it will move and
    // shows them, rather than pretending to know which is which.
    const men = withLine([lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3), lineman('Y', 32.3, -0.8)])
    expect(labelsOf(men)).toContain('Y')
  })

  it('still finds the line in a play written before roles existed', () => {
    // No roles anywhere, but a man called C: the prototype's own lookup, kept
    // for exactly these documents (roleHolder's fallback).
    const men = [lineman('LT', 23.1), lineman('LG', 24.9), lineman('C', 26.7, -0.6), lineman('RG', 28.5), lineman('RT', 30.3)]
    expect([...lineIds(men).ids].sort()).toEqual(['C', 'LG', 'LT', 'RG', 'RT'])
  })

  it('refuses rather than guessing when nobody snaps it and nobody is called C', () => {
    const men = [lineman('LT', 23.1), lineman('LG', 24.9), lineman('PIV', 26.7, -0.6), lineman('RG', 28.5)]
    const choice = lineIds(men)
    expect(choice.ids.size).toBe(0)
    expect(choice.refusal).toMatch(/snapper/i)
  })

  it('refuses when the snapper stands alone', () => {
    const men = withLine([lineman('C', 26.7, -0.6), lineman('X', 8), lineman('Z', 46)])
    const choice = lineIds(men)
    expect(choice.ids.size).toBe(0)
    expect(choice.refusal).toMatch(/line/i)
  })

  it('uses the ROLE, never the label: a man called C who does not snap it is not the anchor', () => {
    const men = [
      lineman('LT', 23.1), lineman('LG', 24.9), { ...lineman('C', 26.7, -0.6) }, lineman('RG', 28.5), lineman('RT', 30.3),
      { ...lineman('WING', 45), role: 'snapper' as const },
    ]
    // The snapper is the wing, alone out there, so there is no line to take.
    expect(lineIds(men).refusal).toMatch(/line/i)
  })
})

// ---------------------------------------------------------------------------
// How far, and what comes along
// ---------------------------------------------------------------------------

describe('one delta for the whole group', () => {
  const state = (): Movable => {
    const p = { ...play, players: withRoles(play.players) }
    return { players: p.players, ball: p.ball, ballThen: p.ballThen, engagements: p.engagements }
  }

  it('keeps relative spacing when the group runs out of field', () => {
    const s = state()
    const ids = groupIds(s.players, 'formation').ids
    const widest = Math.max(...s.players.map((p) => p.x))
    const delta = clampDelta(s, ids, 'formation', 40, 0)

    expect(delta.x).toBeCloseTo(BOUNDS.maxX - widest, 5)
    const moved = translate(s, ids, delta)
    const gaps = (men: Player[]) => men.map((p) => p.x).sort((a, b) => a - b).map((x, i, a) => (i ? +(x - a[i - 1]).toFixed(6) : 0))
    expect(gaps(moved.players)).toEqual(gaps(s.players))
    expect(Math.min(...moved.players.map((p) => p.x))).toBeGreaterThanOrEqual(BOUNDS.minX - 1e-9)
    expect(Math.max(...moved.players.map((p) => p.x))).toBeLessThanOrEqual(BOUNDS.maxX + 1e-9)
  })

  it('clamps against the left sideline the same way', () => {
    const s = state()
    const ids = groupIds(s.players, 'formation').ids
    const narrowest = Math.min(...s.players.map((p) => p.x), ...s.players.flatMap((p) => p.path.map((q) => q.x)))
    const delta = clampDelta(s, ids, 'formation', -40, 0)
    expect(delta.x).toBeCloseTo(BOUNDS.minX - narrowest, 5)
  })

  it('moves the formation sideways only', () => {
    const s = state()
    const ids = groupIds(s.players, 'formation').ids
    expect(clampDelta(s, ids, 'formation', 2, -5).y).toBe(0)
  })

  it('will not walk a subgroup across the line of scrimmage', () => {
    const s = state()
    const offense = groupIds(s.players, 'offense').ids
    const frontMost = Math.max(...s.players.filter((p) => offense.has(p.id)).map((p) => p.y))
    expect(clampDelta(s, offense, 'offense', 0, 10).y).toBeCloseTo(-0.1 - frontMost, 5)

    const defense = groupIds(s.players, 'defense').ids
    const deepest = Math.min(...s.players.filter((p) => defense.has(p.id)).map((p) => p.y))
    expect(clampDelta(s, defense, 'defense', 0, -10).y).toBeCloseTo(0.1 - deepest, 5)
  })

  it('takes each man\'s route with him, anchors and all', () => {
    const s = state()
    const ids = groupIds(s.players, 'offense').ids
    const moved = translate(s, ids, { x: 1.5, y: -1 })
    for (const before of s.players.filter((p) => ids.has(p.id) && p.path.length)) {
      const after = moved.players.find((p) => p.id === before.id)!
      expect(after.path).toEqual(before.path.map((q) => ({ x: q.x + 1.5, y: q.y - 1 })))
    }
  })

  it('takes pre-snap motion with him (today: his path, run before the snap)', () => {
    const s = state()
    const mover = s.players.find((p) => p.side === 'offense' && p.path.length >= 2)!
    const withMotion: Movable = { ...s, players: s.players.map((p) => (p.id === mover.id ? { ...p, timing: 'pre-snap' as const } : p)) }
    const ids = groupIds(s.players, 'offense').ids
    const moved = translate(withMotion, ids, { x: 2, y: 0 })
    const after = moved.players.find((p) => p.id === mover.id)!
    expect(after.timing).toBe('pre-snap')
    expect(after.path).toEqual(mover.path.map((q) => ({ x: q.x + 2, y: q.y })))
  })

  it('the catch point follows its receiver, and stays put when he does not move', () => {
    const s = state()
    const pass = { kind: 'pass' as const, targetId: man('Y').id, catchPoint: { x: 30, y: 6 }, releasePoint: { x: 26.66, y: -5 } }
    const withPass: Movable = { ...s, ball: pass }

    const offense = groupIds(s.players, 'offense').ids
    expect((translate(withPass, offense, { x: 3, y: 0 }).ball as typeof pass).catchPoint).toEqual({ x: 33, y: 6 })

    const defense = groupIds(s.players, 'defense').ids
    expect((translate(withPass, defense, { x: 3, y: 0 }).ball as typeof pass).catchPoint).toEqual({ x: 30, y: 6 })
  })

  it('the throw point follows the passer, and only him', () => {
    const s = state()
    const pass = { kind: 'pass' as const, targetId: man('Y').id, catchPoint: { x: 30, y: 6 }, releasePoint: { x: 26.66, y: -5 } }
    const withPass: Movable = { ...s, ball: pass }

    const line = groupIds(s.players, 'line').ids // the passer is not on the line
    expect((translate(withPass, line, { x: 2, y: 0 }).ball as typeof pass).releasePoint).toEqual({ x: 26.66, y: -5 })

    const offense = groupIds(s.players, 'offense').ids
    expect((translate(withPass, offense, { x: 2, y: 0 }).ball as typeof pass).releasePoint).toEqual({ x: 28.66, y: -5 })
  })
})

describe('blocks, when only one of the two men moves', () => {
  const state = (engagement: Partial<Movable['engagements'][number]>): Movable => {
    const players = withRoles(play.players)
    const blocker = players.find((p) => p.side === 'offense' && p.path.length >= 2)!
    const partner = players.find((p) => p.side === 'defense')!
    return {
      players,
      ball: null,
      ballThen: null,
      engagements: [{ id: 'e1', kind: 'engage', a: blocker.id, b: partner.id, point: { x: 20, y: 1 }, ...engagement }],
    }
  }

  it('moves the point when both of them move', () => {
    const s = state({ auto: true })
    const all = groupIds(s.players, 'formation').ids
    expect(translate(s, all, { x: 2, y: 0 }).engagements[0].point).toEqual({ x: 22, y: 1 })
  })

  it('re-infers a point PEIRA guessed when only the blocker moves', () => {
    const s = state({ auto: true })
    const offense = groupIds(s.players, 'offense').ids
    const blocker = s.players.find((p) => p.id === s.engagements[0].a)!
    const moved = translate(s, offense, { x: 2, y: 0 })
    // The guess is the end of his path, which has just moved with him.
    expect(moved.engagements[0].point).toEqual({ x: blocker.path[blocker.path.length - 1].x + 2, y: blocker.path[blocker.path.length - 1].y })
  })

  it('leaves a point the coach placed exactly where he put it', () => {
    const s = state({ auto: false })
    const offense = groupIds(s.players, 'offense').ids
    expect(translate(s, offense, { x: 2, y: 0 }).engagements[0].point).toEqual({ x: 20, y: 1 })
  })

  it('leaves a block alone when neither man moves', () => {
    const s = state({ auto: true })
    const line = new Set<string>()
    expect(translate(s, line, { x: 2, y: 0 }).engagements[0]).toEqual(s.engagements[0])
  })
})

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

describe('moving a group in the editor', () => {
  it('the Formation menu offers the hash and the four moves', () => {
    open(play)
    fireEvent.click(stripBtn(/^Formation/))
    const names = within(pop()).getAllByRole('button').map((b) => b.textContent!.trim())
    expect(names).toEqual(expect.arrayContaining(['Left', 'Middle', 'Right', 'Move formation…', 'Move offense…', 'Move defense…', 'Move offensive line…']))
  })

  it('the hash still moves the whole look from the dock, without distorting it', async () => {
    open(play)
    const before = play.players.map((p) => p.x).sort((a, b) => a - b)
    fireEvent.click(document.querySelector('button.sit-chip') as HTMLElement)
    fireEvent.click(within(document.querySelector('.bar.bottom') as HTMLElement).getByRole('button', { name: 'Left' }))
    await settle()

    const after = stored(play).players.map((p) => p.x).sort((a, b) => a - b)
    const gaps = (xs: number[]) => xs.map((x, i) => (i ? +(x - xs[i - 1]).toFixed(6) : 0))
    expect(gaps(after)).toEqual(gaps(before))
    expect(Math.min(...after)).toBeGreaterThanOrEqual(BOUNDS.minX - 1e-9)
  })

  it('moves the offense together, and says what it is moving', async () => {
    open(play)
    arm('Move offense…')
    expect(strip().textContent).toMatch(/Drag anywhere to move/)
    expect(strip().textContent).toMatch(/offense/i)

    const before = play.players
    await drag([26, -3], [28, -3])

    for (const p of before) {
      const after = manIn(play, p.id)
      const dx = p.side === 'offense' ? 2 : 0
      expect(after.x).toBeCloseTo(p.x + dx, 6)
      expect(after.y).toBeCloseTo(p.y, 6)
    }
  })

  it('moves the defense together', async () => {
    open(play)
    arm('Move defense…')
    await drag([26, 5], [26, 7])

    for (const p of play.players) {
      const after = manIn(play, p.id)
      expect(after.y).toBeCloseTo(p.side === 'defense' ? p.y + 2 : p.y, 6)
    }
  })

  it('moves the line together and leaves the backs where they are', async () => {
    open(play)
    arm('Move offensive line…')
    await drag([26, -1], [27, -1])

    const line = lineIds(withRoles(play.players)).ids
    for (const p of play.players) {
      const after = manIn(play, p.id)
      expect(after.x).toBeCloseTo(p.x + (line.has(p.id) ? 1 : 0), 6)
    }
    expect(line.has(man('QB').id)).toBe(false)
    expect(line.has(man('RB').id)).toBe(false)
  })

  it('moves the whole formation sideways only', async () => {
    open(play)
    arm('Move formation…')
    await drag([26, -1], [28, 3])

    for (const p of play.players) {
      const after = manIn(play, p.id)
      expect(after.x).toBeCloseTo(p.x + 2, 6)
      expect(after.y).toBeCloseTo(p.y, 6)
    }
  })

  it('a finished move is one undo step', async () => {
    open(play)
    arm('Move offense…')
    await drag([26, -3], [29, -3])
    expect(manIn(play, man('QB').id).x).toBeCloseTo(man('QB').x + 3, 6)

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()
    expect(manIn(play, man('QB').id).x).toBeCloseTo(man('QB').x, 6)
  })

  it('Esc puts everything back, and is not an undo step', async () => {
    open(play)
    await settle()
    const before = JSON.stringify(stored(play))

    arm('Move offense…')
    await drag([26, -3], [30, -3], { finish: false })
    esc()
    await settle()

    // Nothing moved...
    expect(JSON.stringify(stored(play))).toBe(before)
    expect(strip().textContent).not.toMatch(/Drag anywhere to move/)

    // ...and nothing was recorded: undo has no move to walk back.
    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()
    expect(JSON.stringify(stored(play))).toBe(before)
  })

  it('refuses to move a line it cannot find, and arms nothing', async () => {
    const noSnapper = { ...play, players: play.players.map((p) => (p.label === 'C' ? { ...p, label: 'WING', x: 46, y: -1.6 } : p)) }
    open(noSnapper)
    arm('Move offensive line…')
    await settle()

    expect(strip().textContent).not.toMatch(/Drag anywhere to move/)
    expect(document.querySelector('.toast')!.textContent).toMatch(/line|snapper/i)
  })

  it('never reads a label to decide who moves', () => {
    const src = readSource()
    expect(src).not.toMatch(/label === 'QB'/)
    expect(src).not.toMatch(/label === 'C'/)
    expect(src).not.toMatch(/'LT', 'LG'/)
  })
})

function readSource() {
  // The editor and the group maths, as shipped: P3.1 took label-as-identity
  // out and P3.3 must not bring it back in through the side door.
  return [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ...['./MotionLabEditor.tsx', './groupMove.ts'],
  ]
    .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8'))
    .join('\n')
}
