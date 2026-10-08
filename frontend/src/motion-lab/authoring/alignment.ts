// WHERE A MAN IS LINED UP - read from the formation, never from his name.
//
// The line of scrimmage is found from the man who snaps it, outward (lineIds).
// Everything else about an offensive man's alignment is read from that same
// line: one of the men on it, off it close in (a wing, an H-back), or split
// out where a receiver lines up. Moving "the men on the line" and the stance a
// tight end defaults to therefore always agree about who is on it.
//
// Pure: no React, no engine state. The 3D viewer uses this file verbatim.

import type { Player } from '../engine/formation'
import { snapperOf } from './roles'

/** How far off the line of scrimmage a man can be and still be ON it. */
export const ON_LINE = 1.0
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
export const MAX_SPLIT = 3.0

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

/**
 * Where an offensive man stands relative to the line (lineIds):
 *
 *   attached - he is one of the men on the line;
 *   split    - more than a split (MAX_SPLIT) outside the end of the line, on
 *              the ball or off it: where a receiver lines up;
 *   wing     - anywhere else: off the line but inside that - a wing, an
 *              H-back, a man in the backfield.
 *
 * null when there is no line to read (nobody snaps it, or too few men are on
 * it), and for the defense.
 */
export type Alignment = 'attached' | 'wing' | 'split'

export function alignmentOf(p: Player, players: Player[]): Alignment | null {
  if (p.side !== 'offense') return null
  const line = lineIds(players)
  if (!line.ids.size) return null
  if (line.ids.has(p.id)) return 'attached'
  const xs = players.filter((q) => line.ids.has(q.id)).map((q) => q.x)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const outside = p.x < lo ? lo - p.x : p.x > hi ? p.x - hi : 0
  return outside > MAX_SPLIT ? 'split' : 'wing'
}
