import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker, stroke } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import type { Play } from '../engine/play'
import { groupIds, translate } from './groupMove'
import { playerSummary } from './playerSummary'
import { buildSchedule } from '../engine/timeline'

/**
 * ONE MAN, TWO PHASES (P3.4): pre-snap MOTION, then the post-snap ROUTE.
 *
 * The strip talks about one phase at a time, and only says so when he has
 * two: a man with motion gets `Motion | Route`, which scopes Draw, the
 * handle, Adjust and Delete. Everything else about the strip is unchanged for
 * everyone else. And the two lines never come apart - the route begins where
 * the motion ends, whatever the coach does to either one.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const key = (k: string, mods: Record<string, boolean> = {}) => act(() => void fireEvent.keyDown(window, { key: k, ...mods }))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}
const strip = () => document.querySelector('.bar.context') as HTMLElement
const stripBtn = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const maybeStripBtn = (name: string | RegExp) => within(strip()).queryByRole('button', { name })
const phaseSeg = () => strip().querySelector('[data-phase-seg]')
const more = () => fireEvent.click(stripBtn(/^More/))
const moreItem = (name: string | RegExp) => within(strip().querySelector('.more-pop') as HTMLElement).getByRole('button', { name })
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const manIn = (play: Play, id: string) => stored(play).players.find((p) => p.id === id)!
const toast = () => document.querySelector('.toast')?.textContent ?? ''
const boardClass = () => board().getAttribute('class')

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
/** An armed stroke on the grass, as a coach draws after pressing Draw or D. */
const drawArmed = (points: [number, number][]) => stroke(board(), points)

const H = 'O9' // at (38, -1.6), no route in this fixture
const JET: Pt[] = [{ x: 38, y: -1.6 }, { x: 31, y: -1.6 }]
const WHEEL: Pt[] = [{ x: 31, y: -1.6 }, { x: 35, y: -2.5 }, { x: 44, y: 2 }, { x: 46, y: 14 }]

/** The fixture with H given motion (and optionally a route). */
function withH(base: Play, patch: Partial<Player>): Play {
  return { ...base, players: base.players.map((p) => (p.id === H ? { ...p, ...patch } : p)) }
}

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

// ---------------------------------------------------------------------------
// The strip only talks about phases when there are two
// ---------------------------------------------------------------------------

describe('the phase switch', () => {
  it('is not there for a man without motion - the strip is unchanged', () => {
    open(play)
    select(play, H)
    expect(phaseSeg()).toBeNull()
    expect(stripBtn('✎ Draw assignment')).toBeInTheDocument()
  })

  it('appears once he has motion, on Route', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    expect(phaseSeg()).not.toBeNull()
    const active = phaseSeg()!.querySelector('button.active')!
    expect(active.textContent).toBe('Route')
    expect(stripBtn('Redraw route')).toBeInTheDocument()
  })

  it('goes back to Route when another man is selected and comes back', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    expect(stripBtn('Redraw motion')).toBeInTheDocument()

    select(play, 'O8')
    select(play, H)
    expect(phaseSeg()!.querySelector('button.active')!.textContent).toBe('Route')
  })

  it('is editor state: switching phases saves nothing', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    await settle()
    const before = localStorage.getItem(PLAYS_KEY)
    select(play, H)
    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    fireEvent.click(stripBtn('Adjust'))
    fireEvent.click(stripBtn('Redraw motion')) // armed, never drawn
    key('Escape')
    await settle()
    expect(localStorage.getItem(PLAYS_KEY)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Adding motion, drawing both phases
// ---------------------------------------------------------------------------

describe('adding motion and drawing both phases', () => {
  it('More › Add pre-snap motion… draws his motion, then points at the route', async () => {
    open(play)
    select(play, H)
    more()
    fireEvent.click(moreItem('Add pre-snap motion…'))
    expect(boardClass()).toBe('board board-armed')
    // Armed, the strip is the waiting row, and the row names the phase.
    expect(strip().textContent).toMatch(/Draw H's motion: drag on the field/)

    drawArmed([[38, -1.6], [35, -1.6], [31, -1.6]])
    await settle()

    const h = manIn(play, H)
    expect(h.motion![0]).toEqual({ x: 38, y: -1.6 })
    expect(h.motion![h.motion!.length - 1].x).toBeCloseTo(31, 6)
    expect(h.path).toEqual([])
    // No route yet, so the gold points at it.
    expect(phaseSeg()!.querySelector('button.active')!.textContent).toBe('Route')
    expect(stripBtn('✎ Draw route').className).toContain('primary')
  })

  it('an abandoned first motion leaves no phase switch behind', () => {
    open(play)
    select(play, H)
    more()
    fireEvent.click(moreItem('Add pre-snap motion…'))
    key('Escape')
    expect(phaseSeg()).toBeNull()
    expect(stripBtn('✎ Draw assignment')).toBeInTheDocument()
  })

  it('draws the route from where the motion ends, whatever the pointer does', async () => {
    play = withH(play, { motion: JET, path: [] })
    open(play)
    select(play, H)
    fireEvent.click(stripBtn('✎ Draw route'))
    drawArmed([[36, 0], [40, 4], [44, 12]])
    await settle()

    const h = manIn(play, H)
    expect(h.path[0]).toEqual(JET[1])
    expect(h.motion).toEqual(JET)
  })

  it('redrawing one phase never touches the other', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    fireEvent.click(stripBtn('Redraw motion'))
    drawArmed([[38, -1.6], [35, -2.5], [32, -2.5]])
    await settle()

    const h = manIn(play, H)
    const end = h.motion![h.motion!.length - 1]
    // The wheel slid to the new snap point, shape intact.
    const dx = end.x - JET[1].x
    const dy = end.y - JET[1].y
    expect(h.path.map((q) => ({ x: +(q.x - dx).toFixed(6), y: +(q.y - dy).toFixed(6) }))).toEqual(WHEEL.map((q) => ({ x: q.x, y: q.y })))
  })
})

// ---------------------------------------------------------------------------
// Adjust, one phase at a time
// ---------------------------------------------------------------------------

describe('adjusting one phase at a time', () => {
  const anchors = () => board().querySelectorAll('[data-anchor]').length

  it('shows the active phase\'s anchors only, and switching keeps Adjust on', () => {
    play = withH(play, { motion: [JET[0], { x: 34, y: -2 }, JET[1]], path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(stripBtn('Adjust'))
    expect(boardClass()).toBe('board board-adjusting')
    expect(anchors()).toBe(WHEEL.length - 1)

    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    expect(boardClass()).toBe('board board-adjusting')
    expect(anchors()).toBe(2)
  })

  it('dims the other line while adjusting, and hides neither', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(stripBtn('Adjust'))
    const motionLine = board().querySelector(`[data-motion-line="${H}"]`)!
    const routeLine = board().querySelector(`[data-route-line="${H}"]`)!
    expect(motionLine.getAttribute('opacity')).toBe('0.45')
    expect(routeLine.getAttribute('opacity')).toBe('1')
  })

  it('moving the end of his motion carries the route with it, shape intact', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    fireEvent.click(stripBtn('Adjust'))
    const last = board().querySelector('[data-anchor="1"]')!
    stroke(last, [[31, -1.6], [30, -2.6]])
    await settle()

    const h = manIn(play, H)
    expect(h.motion![1].x).toBeCloseTo(30, 6)
    expect(h.path[0]).toEqual(h.motion![1])
    expect(h.path[3].x - h.path[0].x).toBeCloseTo(WHEEL[3].x - WHEEL[0].x, 6)
    expect(h.path[3].y - h.path[0].y).toBeCloseTo(WHEEL[3].y - WHEEL[0].y, 6)
  })
})

// ---------------------------------------------------------------------------
// Delete and Clear
// ---------------------------------------------------------------------------

describe('clearing one phase', () => {
  it('Delete in Motion clears the motion, keeps the route and slides it home', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    key('Delete')
    await settle()

    const h = manIn(play, H)
    expect(h.motion).toBeUndefined()
    expect(h.path[0]).toEqual({ x: 38, y: -1.6 })
    expect(h.path).toHaveLength(WHEEL.length)
    expect(phaseSeg()).toBeNull()

    key('z', { ctrlKey: true })
    await settle()
    expect(manIn(play, H).motion).toEqual(JET)
    expect(manIn(play, H).path).toEqual(WHEEL)
  })

  it('Delete in Route clears the route and keeps the motion', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    key('Delete')
    await settle()

    expect(manIn(play, H).path).toEqual([])
    expect(manIn(play, H).motion).toEqual(JET)

    key('z', { ctrlKey: true })
    await settle()
    expect(manIn(play, H).path).toEqual(WHEEL)
  })

  it('More names each clear, and Delete player is still the whole man', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    more()
    expect(moreItem(/Clear the route/)).toBeInTheDocument()
    expect(moreItem(/Clear the motion/)).toBeInTheDocument()
    expect(moreItem('Delete player')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Legacy pre-snap lines
// ---------------------------------------------------------------------------

describe('a line drawn as pre-snap timing, the old way', () => {
  const legacy = () => withH(play, { timing: 'pre-snap', path: JET })

  it('opens exactly as it was saved, with the offer in the Pre-snap segment', () => {
    play = legacy()
    open(play)
    select(play, H)
    expect(phaseSeg()).toBeNull()
    expect(stripBtn(/^Pre-snap/)).toBeInTheDocument()
    expect(document.querySelector('.legacy-pop')).toBeNull() // nothing opens on its own
  })

  it('Make it his motion: his line becomes his motion, one undo step', async () => {
    play = legacy()
    open(play)
    select(play, H)
    fireEvent.click(stripBtn(/^Pre-snap/))
    fireEvent.click(within(document.querySelector('.legacy-pop') as HTMLElement).getByRole('button', { name: 'Make it his motion' }))
    await settle()

    const h = manIn(play, H)
    expect(h.motion).toEqual(JET)
    expect(h.path).toEqual([])
    expect(h.timing).toBe('on-snap')
    expect(phaseSeg()!.querySelector('button.active')!.textContent).toBe('Route')
    expect(toast()).toMatch(/now his motion/)

    key('z', { ctrlKey: true })
    await settle()
    expect(manIn(play, H).motion).toBeUndefined()
    expect(manIn(play, H).timing).toBe('pre-snap')
  })

  it('behaves as it always did until a route is drawn: at the end of the line at the snap', () => {
    const before = buildSchedule(legacy().players)
    const converted = legacy().players.map((p) => (p.id === H ? { ...p, motion: JET, path: [], timing: 'on-snap' as const } : p))
    const after = buildSchedule(converted)
    expect(after.snapAt).toBeCloseTo(before.snapAt, 6)
    const s0 = before.schedule.get(H)!
    const s1 = after.schedule.get(H)!
    expect(s1.start).toBeCloseTo(s0.start, 6)
    expect(s1.end).toBeCloseTo(s0.end, 6)
  })

  it('Run it on the snap instead: an ordinary route, and NO phase switch', async () => {
    play = legacy()
    open(play)
    select(play, H)
    fireEvent.click(stripBtn(/^Pre-snap/))
    fireEvent.click(within(document.querySelector('.legacy-pop') as HTMLElement).getByRole('button', { name: 'Run it on the snap instead' }))
    await settle()

    const h = manIn(play, H)
    expect(h.timing).toBe('on-snap')
    expect(h.path).toEqual(JET)
    expect(h.motion).toBeUndefined()
    expect(phaseSeg()).toBeNull()
    expect(maybeStripBtn(/^Pre-snap/)).toBeNull()
  })

  it('Leave it changes nothing at all', async () => {
    play = legacy()
    open(play)
    await settle()
    const before = localStorage.getItem(PLAYS_KEY)
    select(play, H)
    fireEvent.click(stripBtn(/^Pre-snap/))
    fireEvent.click(within(document.querySelector('.legacy-pop') as HTMLElement).getByRole('button', { name: 'Leave it' }))
    await settle()
    expect(localStorage.getItem(PLAYS_KEY)).toBe(before)
    expect(document.querySelector('.legacy-pop')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The one combination the schedule cannot run
// ---------------------------------------------------------------------------

describe('motion + Delayed + a block release: the third is refused, and says why', () => {
  /** H with motion, and a block on a defender that he comes off. */
  const releasing = () => ({
    ...withH(play, { motion: JET, path: WHEEL }),
    engagements: [{ id: 'eH', kind: 'engage' as const, a: H, b: 'D6', point: { x: 38, y: 3 }, release: H }],
  })

  it('motion + release: Delayed is blocked, with a tooltip and a tap toast', async () => {
    play = releasing()
    open(play)
    select(play, H)
    const delayed = stripBtn('Delayed')
    expect(delayed.getAttribute('aria-disabled')).toBe('true')
    expect(delayed.getAttribute('title')).toMatch(/comes off his block, so he can't also wait at the snap/)
    fireEvent.click(delayed)
    await settle()
    expect(manIn(play, H).timing).toBe('on-snap')
    expect(toast()).toMatch(/can't also wait at the snap/)
  })

  it('motion + delayed: Releases is blocked the same way', async () => {
    play = {
      ...withH(play, { motion: JET, path: WHEEL, timing: 'delayed', delay: 0.5 }),
      engagements: [{ id: 'eH', kind: 'engage' as const, a: H, b: 'D6', point: { x: 38, y: 3 } }],
    }
    open(play)
    select(play, H)
    const rel = stripBtn('Releases')
    expect(rel.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(rel)
    await settle()
    expect(stored(play).engagements[0].release).toBeUndefined()
    expect(toast()).toMatch(/can't also come off a block/)
  })

  it('delayed + release: Add pre-snap motion is blocked', async () => {
    play = {
      ...withH(play, { path: WHEEL.map((q) => ({ x: q.x + 7, y: q.y })), timing: 'delayed', delay: 0.5 }),
      engagements: [{ id: 'eH', kind: 'engage' as const, a: H, b: 'D6', point: { x: 38, y: 3 }, release: H }],
    }
    open(play)
    select(play, H)
    more()
    const add = moreItem('Add pre-snap motion…')
    expect(add.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(add)
    expect(boardClass()).not.toBe('board board-armed')
    expect(toast()).toMatch(/can't also motion/)
  })

  it('Delayed is still available to a man with motion and no release (case B)', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    expect(stripBtn('Delayed').getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(stripBtn('Delayed'))
    await settle()
    expect(manIn(play, H).timing).toBe('delayed')
  })
})

// ---------------------------------------------------------------------------
// Copy, mirror, group moves
// ---------------------------------------------------------------------------

describe('copy, mirror and moving the group take the motion too', () => {
  it('mirror carries the motion, mirrored about the new man', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    more()
    fireEvent.click(moreItem('Mirror his assignment to…'))
    const x = play.players.find((p) => p.id === 'O8')! // X at (8, -0.8)
    fireEvent.pointerDown(playerMarker('O8'), { button: 0, pointerId: 1, ...client(x.x, x.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(x.x, x.y) })
    await settle()

    const m = manIn(play, 'O8')
    // H motioned 7 yd toward the ball (-x); mirrored, X motions 7 yd +x.
    expect(m.motion![0]).toEqual({ x: 8, y: -0.8 })
    expect(m.motion![1].x).toBeCloseTo(15, 6)
    expect(m.path[0]).toEqual(m.motion![1])
  })

  it('a copy onto a man who comes off a block lands on the snap, and says so', async () => {
    play = {
      ...withH(play, { motion: JET, path: WHEEL, timing: 'delayed', delay: 0.5 }),
      engagements: [{ id: 'eX', kind: 'engage' as const, a: 'O8', b: 'D7', point: { x: 8, y: 5 }, release: 'O8' }],
    }
    open(play)
    select(play, H)
    more()
    fireEvent.click(moreItem('Copy his assignment to…'))
    const x = play.players.find((p) => p.id === 'O8')!
    fireEvent.pointerDown(playerMarker('O8'), { button: 0, pointerId: 1, ...client(x.x, x.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(x.x, x.y) })
    await settle()

    const m = manIn(play, 'O8')
    expect(m.motion).toBeDefined()
    expect(m.path.length).toBeGreaterThanOrEqual(2)
    expect(m.timing).toBe('on-snap')
    expect(toast()).toMatch(/comes off a block, so his delay was left off/)
  })

  it('a group move carries his motion and his route, one delta', () => {
    const p = withH(play, { motion: JET, path: WHEEL })
    const state = { players: p.players, ball: p.ball, ballThen: p.ballThen, engagements: p.engagements }
    const moved = translate(state, groupIds(p.players, 'offense').ids, { x: -2, y: -1 })
    const h = moved.players.find((q) => q.id === H)!
    expect(h.motion).toEqual(JET.map((q) => ({ x: q.x - 2, y: q.y - 1 })))
    expect(h.path).toEqual(WHEEL.map((q) => ({ x: q.x - 2, y: q.y - 1 })))
  })

  it('the hash move carries his motion too', async () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    fireEvent.click(document.querySelector('button.sit-chip') as HTMLElement)
    fireEvent.click(within(document.querySelector('.bar.bottom') as HTMLElement).getByRole('button', { name: 'Left' }))
    await settle()

    const h = manIn(play, H)
    const dx = h.x - 38
    expect(dx).toBeLessThan(0)
    expect(h.motion![0].x).toBeCloseTo(38 + dx, 6)
    expect(h.motion![1].x).toBeCloseTo(31 + dx, 6)
    expect(h.path[0]).toEqual(h.motion![1])
  })
})

// ---------------------------------------------------------------------------
// What the strip says
// ---------------------------------------------------------------------------

describe('the summary says both phases, motion first', () => {
  const say = (p: Play) => {
    const h = p.players.find((q) => q.id === H)!
    return playerSummary({ player: h, players: p.players, drawn: undefined, engagements: p.engagements, derived: [], ball: p.ball, ballThen: p.ballThen })
  }

  it('motion and a route: two clauses', () => {
    expect(say(withH(play, { motion: JET, path: WHEEL }))).toMatch(/^Motion 7 yds across · Route \d+ yds /)
  })

  it('delayed goes after both', () => {
    expect(say(withH(play, { motion: JET, path: WHEEL, timing: 'delayed', delay: 0.5 }))).toMatch(/· delayed 0\.5 s/)
  })

  it('motion and no route yet', () => {
    expect(say(withH(play, { motion: JET, path: [] }))).toBe('Motion · 7 yds across · no route yet')
  })

  it('a man with one line reads exactly as before', () => {
    expect(say(withH(play, { path: WHEEL.map((q) => ({ x: q.x + 7, y: q.y })) }))).toMatch(/^Route · \d+ yds /)
  })
})

// ---------------------------------------------------------------------------
// The board: where he is at the snap
// ---------------------------------------------------------------------------

describe('the board shows the join', () => {
  it('draws dotted motion, a snap bar in his own colour, and a solid route with the arrow', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    const motion = board().querySelector(`[data-motion-line="${H}"]`)!
    const route = board().querySelector(`[data-route-line="${H}"]`)!
    expect(motion.getAttribute('stroke-dasharray')).toBe('2 7')
    expect(motion.getAttribute('marker-end')).toBeNull()
    expect(route.getAttribute('stroke-dasharray')).toBeNull()
    expect(route.getAttribute('marker-end')).toBe('url(#arrow)')
    const bar = board().querySelector('[data-snap-bar]')!
    expect(bar.getAttribute('stroke')).toBe('var(--offense)')
  })

  it('in Route, his handle sits on the snap bar; in Motion, on him', () => {
    play = withH(play, { motion: JET, path: WHEEL })
    open(play)
    select(play, H)
    const handleGroup = () => board().querySelector(`[data-handle="${H}"]`)!.parentElement!
    // Route: the handle is outside his marker, translated to the snap point.
    expect(handleGroup().getAttribute('data-player')).toBeNull()
    expect(handleGroup().getAttribute('transform')).toBe(`translate(${31 * U} ${(Y_MAX + 1.6) * U})`)

    fireEvent.click(within(phaseSeg() as HTMLElement).getByRole('button', { name: 'Motion' }))
    expect(handleGroup().getAttribute('data-player')).toBe(H)
  })

  it('a man without motion is drawn exactly as before', () => {
    open(play)
    expect(board().querySelector('[data-snap-bar]')).toBeNull()
    expect(board().querySelector('[data-motion-line]')).toBeNull()
  })
})
