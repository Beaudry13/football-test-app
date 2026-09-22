// Moving men in groups: the whole formation sideways to a hash, the offense,
// the defense, or the line.
//
// A coach repositioning a look should not drag eleven men one at a time, and
// the football that belongs to those men has to travel with them: their
// routes, their blocks, the spot the ball is caught. This module is the pure
// arithmetic of that - who moves, how far they are allowed to, and what the
// play looks like afterwards. The editor owns the gesture; nothing here
// touches React or the engine.
//
// RELATIVE SPACING IS THE POINT. Every moved point takes the SAME delta, and
// the delta is clamped once for the whole group. Clamping each point on its
// own is what used to squash a formation against a sideline: the widest man
// stopped and everybody else kept coming.

import { isPass, type BallAction } from '../engine/ball'
import { BOUNDS } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import type { Engagement } from '../engine/interactions'
import { inferMeetPoint } from './meetPoint'
import { snapperOf } from './roles'

export type MoveGroup = 'formation' | 'offense' | 'defense' | 'line'

export interface Movable {
  players: Player[]
  ball: BallAction | null
  ballThen: BallAction | null
  engagements: Engagement[]
}

/** How far off the line of scrimmage a man can be and still be ON it. */
const ON_LINE = 1.0
/**
 * The widest gap between two men that still reads as one line.
 *
 * Real splits: 1.8 yd between linemen in the shipped formations, 2.0 yd from
 * the tackle to an attached tight end, 5.7 yd to the next receiver. So this
 * threshold separates the LINE from the men spread away from it - and NOT a
 * tight end from a sixth lineman, which no alignment rule can do, because an
 * attached tight end lines up exactly where a sixth lineman would. The editor
 * says how many men it is about to move, and shows them, rather than
 * pretending to know which of them the coach thinks of as linemen.
 */
const MAX_SPLIT = 3.0
/** A man may not be moved onto the other side's half of the line. */
const LOS_MARGIN = 0.1

/** Everyone the line has to have before it is worth calling a line. */
const MIN_LINE = 3

export interface GroupChoice {
  ids: Set<string>
  /** Why nothing can move, when that is the answer. */
  refusal?: string
}

/**
 * THE MEN ON THE LINE, found from the snapper outward.
 *
 * Walk out from the man who snaps it, left and right, taking anyone level
 * with him on the line while the gap to the man already taken is a split
 * rather than a space. That handles an unbalanced line, a sixth lineman, a
 * tackle over and unusual splits without knowing a single position name - and
 * it refuses rather than guessing when there is nobody to start from.
 */
export function lineIds(players: Player[]): GroupChoice {
  const snapper = snapperOf(players)
  if (!snapper) {
    return { ids: new Set(), refusal: 'Nobody snaps it yet — make a snapper first (More › Make snapper).' }
  }
  const online = players
    .filter((p) => p.side === 'offense' && Math.abs(p.y - snapper.y) <= ON_LINE)
    .sort((a, b) => a.x - b.x)
  const at = online.findIndex((p) => p.id === snapper.id)
  const taken = [online[at]]
  for (let i = at - 1; i >= 0; i--) {
    if (taken[0].x - online[i].x > MAX_SPLIT) break
    taken.unshift(online[i])
  }
  for (let i = at + 1; i < online.length; i++) {
    if (online[i].x - taken[taken.length - 1].x > MAX_SPLIT) break
    taken.push(online[i])
  }
  if (taken.length < MIN_LINE) {
    return { ids: new Set(), refusal: 'Only the snapper is on the line — move the offense instead.' }
  }
  return { ids: new Set(taken.map((p) => p.id)) }
}

/** Who moves, for each group. */
export function groupIds(players: Player[], group: MoveGroup): GroupChoice {
  switch (group) {
    case 'formation':
      return { ids: new Set(players.map((p) => p.id)) }
    case 'offense':
      return { ids: new Set(players.filter((p) => p.side === 'offense').map((p) => p.id)) }
    case 'defense':
      return { ids: new Set(players.filter((p) => p.side === 'defense').map((p) => p.id)) }
    case 'line':
      return lineIds(players)
  }
}

const bothMove = (e: Engagement, ids: Set<string>) => ids.has(e.a) && ids.has(e.b)
const eitherMoves = (e: Engagement, ids: Set<string>) => ids.has(e.a) || ids.has(e.b)

/**
 * Every point that travels with this group.
 *
 * The clamp is computed from these and nothing else, so what is allowed to
 * move is exactly what is checked.
 */
function movingPoints(state: Movable, ids: Set<string>): { alignments: Pt[]; rest: Pt[] } {
  const alignments: Pt[] = []
  const rest: Pt[] = []
  for (const p of state.players) {
    if (!ids.has(p.id)) continue
    alignments.push({ x: p.x, y: p.y })
    // His route travels with him - anchors and all. A route may cross the
    // line of scrimmage, which is why only ALIGNMENTS answer to that rule.
    for (const a of p.path) rest.push(a)
  }
  for (const e of state.engagements) if (bothMove(e, ids)) rest.push(e.point)
  for (const a of [state.ball, state.ballThen]) {
    if (!isPass(a)) continue
    // The catch point belongs to the receiver's route; the throw point to the
    // passer's. Each moves only when its own man does.
    if (ids.has(a.targetId)) rest.push(a.catchPoint)
    if (a.releasePoint && passerMoves(state, ids)) rest.push(a.releasePoint)
  }
  return { alignments, rest }
}

const passerMoves = (state: Movable, ids: Set<string>) => {
  const passer = state.players.find((p) => p.side === 'offense' && p.role === 'passer')
  return !!passer && ids.has(passer.id)
}

/**
 * The most of this delta the whole group may take, as one number.
 *
 * Every moved point has to stay on the field, and no moved MAN may cross the
 * line of scrimmage onto the other side's half - so the delta is squeezed
 * until the furthest point in the group is legal, and then everybody uses it.
 */
export function clampDelta(state: Movable, ids: Set<string>, group: MoveGroup, dx: number, dy: number): Pt {
  const { alignments, rest } = movingPoints(state, ids)
  const all = [...alignments, ...rest]
  if (!all.length) return { x: 0, y: 0 }

  let lowX = -Infinity
  let highX = Infinity
  let lowY = -Infinity
  let highY = Infinity
  for (const q of all) {
    lowX = Math.max(lowX, BOUNDS.minX - q.x)
    highX = Math.min(highX, BOUNDS.maxX - q.x)
    lowY = Math.max(lowY, BOUNDS.minY - q.y)
    highY = Math.min(highY, BOUNDS.maxY - q.y)
  }
  if (group !== 'formation') {
    for (const p of state.players) {
      if (!ids.has(p.id)) continue
      if (p.side === 'offense') highY = Math.min(highY, -LOS_MARGIN - p.y)
      else lowY = Math.max(lowY, LOS_MARGIN - p.y)
    }
  }
  // The whole formation slides along the line of scrimmage: where it is on
  // the field is the situation's business (down, distance, spot).
  const wantY = group === 'formation' ? 0 : dy
  return { x: Math.min(highX, Math.max(lowX, dx)), y: Math.min(highY, Math.max(lowY, wantY)) }
}

/** The play with this group moved by an already-clamped delta. */
export function translate(state: Movable, ids: Set<string>, delta: Pt): Movable {
  const shift = (q: Pt): Pt => ({ x: q.x + delta.x, y: q.y + delta.y })
  const players = state.players.map((p) =>
    ids.has(p.id) ? { ...p, ...shift(p), path: p.path.map(shift) } : p,
  )
  const byId = new Map(players.map((p) => [p.id, p]))

  const engagements = state.engagements.map((e) => {
    if (bothMove(e, ids)) return { ...e, point: shift(e.point) }
    if (!eitherMoves(e, ids)) return e
    // One of them moved. A point PEIRA guessed follows the blocker, the same
    // way it follows him when his path is redrawn (SPEC §7.9); a point the
    // coach placed stays exactly where he put it, and the engine's own
    // "never gets near that spot" warning tells him if it no longer works.
    if (!e.auto) return e
    const blocker = byId.get(e.a)
    const partner = byId.get(e.b)
    return blocker && partner ? { ...e, point: inferMeetPoint(blocker, partner) } : e
  })

  const moveBall = (a: BallAction | null): BallAction | null => {
    if (!isPass(a)) return a
    const catchPoint = ids.has(a.targetId) ? shift(a.catchPoint) : a.catchPoint
    const releasePoint = a.releasePoint && passerMoves(state, ids) ? shift(a.releasePoint) : a.releasePoint
    return { ...a, catchPoint, ...(releasePoint ? { releasePoint } : {}) }
  }

  return { players, ball: moveBall(state.ball), ballThen: moveBall(state.ballThen), engagements }
}

/** What the banner calls the group, and how many men it is about to move. */
export function groupWords(group: MoveGroup, count: number): string {
  switch (group) {
    case 'formation':
      return `all ${count} men, sideways`
    case 'offense':
      return `the offense (${count})`
    case 'defense':
      return `the defense (${count})`
    case 'line':
      return `the ${count} men on the line`
  }
}
