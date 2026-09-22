// Player movement → playback schedule. Pure: field yards in, field yards out.
//
// Playback time t runs 0 → duration. The SNAP sits at t = snapAt; pre-snap
// motion happens before it, everything else after. When nobody is in motion
// the pre-snap window shrinks to a short breath so the snap is still a
// visible moment rather than frame zero.
//
// This file is the ONE answer to "where is this player at time t" - the
// overhead renderer, the field renderer and the ball all ask it.

import { distanceToBounds } from './field'
import { SPEED_YPS, type Player } from './formation'
import { classifyEnd, cumulativeLength, endDirection, pointAtDistance, renderPath, type EndBehavior, type Pt } from './geometry'

const PRE_SNAP_WINDOW = 2.0
const PRE_SNAP_BREATH = 0.5

export interface Schedule {
  pts: Pt[]
  cum: number[]
  length: number
  speed: number
  /** Playback time at which this player starts moving. */
  start: number
  /** Playback time at which this player stops. */
  end: number
  /** Length of the DRAWN route; anything past it is continuation. */
  drawnLength: number
  /**
   * A pause on the way: he stops where he is at `from` and moves again at
   * `until`, then finishes the path. One per schedule; an engagement uses
   * it for the brief contact before a release. `end` includes it.
   */
  hold?: { from: number; until: number }
  /**
   * Yards of PRE-SNAP MOTION at the front of `pts`; the post-snap route is
   * everything after it. Absent for a player with no motion, so every
   * schedule the prototype built is unchanged. Anything that projects a
   * post-snap point onto his line - a catch, a throw, a block - must search
   * from here on, or it can land on where he was before the snap.
   */
  preLength?: number
}

const holdDur = (s: Schedule) => (s.hold ? s.hold.until - s.hold.from : 0)

/** Movement time consumed by t (playback), with any hold taken out. */
function movingTime(s: Schedule, t: number): number {
  if (!s.hold || t <= s.hold.from) return t - s.start
  if (t < s.hold.until) return s.hold.from - s.start
  return t - holdDur(s) - s.start
}

/** Playback time at which he is `along` yards into his path (hold included). */
export function timeAtAlong(s: Schedule, along: number): number {
  const t = s.start + along / s.speed
  if (!s.hold) return t
  return t > s.hold.from + 1e-6 ? t + holdDur(s) : t
}

export type ScheduleMap = Map<string, Schedule>

export function buildSchedule(players: Player[]): { schedule: ScheduleMap; snapAt: number; playersEnd: number } {
  // First pass: rendered paths and how long each takes at its own speed.
  const base = new Map<string, Omit<Schedule, 'start' | 'end'>>()
  let longestPre = 0
  for (const p of players) {
    // MOTION, THEN THE ROUTE (P3.4). One line, stitched where the snap
    // catches him, so every renderer and the ball read one schedule. The
    // motion is pre-snap and finishes AT the snap, exactly like the legacy
    // pre-snap path below; the route is everything after it.
    if (p.motion && p.motion.length >= 2) {
      const pre = renderPath(p.motion)
      const post = p.path.length >= 2 ? renderPath(p.path) : []
      const end = pre[pre.length - 1]
      const joined = post.length && Math.hypot(post[0].x - end.x, post[0].y - end.y) < 1e-6 ? post.slice(1) : post
      const pts = [...pre, ...joined]
      const cum = cumulativeLength(pts)
      const length = cum[cum.length - 1]
      const preLength = cumulativeLength(pre)[pre.length - 1]
      const speed = SPEED_YPS[p.speed]
      base.set(p.id, { pts, cum, length, speed, drawnLength: length, preLength })
      longestPre = Math.max(longestPre, preLength / speed)
      continue
    }
    if (p.path.length < 2) continue
    const pts = renderPath(p.path)
    const cum = cumulativeLength(pts)
    const length = cum[cum.length - 1]
    const speed = SPEED_YPS[p.speed]
    base.set(p.id, { pts, cum, length, speed, drawnLength: length })
    if (p.timing === 'pre-snap') longestPre = Math.max(longestPre, length / speed)
  }
  // Pre-snap motion FINISHES at the snap. The window grows if a motion is
  // longer than it, so the snap never lands mid-motion.
  const snapAt = longestPre > 0 ? Math.max(PRE_SNAP_WINDOW, longestPre + 0.3) : PRE_SNAP_BREATH
  const schedule: ScheduleMap = new Map()
  let playersEnd = snapAt
  for (const p of players) {
    const b = base.get(p.id)
    if (!b) continue
    if (b.preLength !== undefined) {
      // Motion ends at the snap; a delayed route waits there, which is this
      // schedule's one pause. (Motion + delay + a block release would need a
      // second one - the editor does not allow that combination.)
      const start = snapAt - b.preLength / b.speed
      const wait = p.timing === 'delayed' && b.length > b.preLength ? Math.max(0, p.delay) : 0
      const moving = b.length / b.speed
      schedule.set(p.id, { ...b, start, end: start + moving + wait, ...(wait > 0 ? { hold: { from: snapAt, until: snapAt + wait } } : null) })
      playersEnd = Math.max(playersEnd, start + moving + wait)
      continue
    }
    const dur = b.length / b.speed
    const start = p.timing === 'pre-snap' ? snapAt - dur : p.timing === 'delayed' ? snapAt + Math.max(0, p.delay) : snapAt
    schedule.set(p.id, { ...b, start, end: start + dur })
    playersEnd = Math.max(playersEnd, start + dur)
  }
  return { schedule, snapAt, playersEnd }
}

/** Where a player is at playback time t. */
export function posAt(schedule: ScheduleMap, p: Player, t: number): Pt {
  const s = schedule.get(p.id)
  if (!s || t <= s.start) return { x: p.x, y: p.y }
  return pointAtDistance(s.pts, s.cum, movingTime(s, t) * s.speed)
}

// ---- continuation -----------------------------------------------------

/**
 * The coach's override if set, otherwise what the route's shape suggests.
 * A pre-snap path is motion that finishes AT the snap; nobody keeps
 * sprinting off a motion, so it settles unless the coach says otherwise.
 */
export function resolveEnd(p: Player, s: Schedule): EndBehavior {
  if (p.endBehavior) return p.endBehavior
  if (p.timing === 'pre-snap') return 'settle'
  // Motion and no route yet: he stops where the snap caught him.
  if (s.preLength !== undefined && s.length - s.preLength < 1e-6) return 'settle'
  return classifyEnd(s.pts, s.cum)
}

/**
 * Where a CONTINUE receiver would be at t if he kept running past his
 * drawn route: straight on in the route's final direction, at his speed,
 * stopping at the field edge. Used by the ball planner before the schedule
 * has been extended; `extendUntil` then writes the same line into the
 * schedule so the renderers see it too.
 */
export function posBeyond(s: Schedule, p: Player, t: number): Pt {
  if (t <= s.end) return posAt(new Map([[p.id, s]]), p, t)
  const dir = endDirection(s.pts, s.cum)
  const end = s.pts[s.pts.length - 1]
  // Straight on, and simply stop at the edge of the field. Stopping ON the
  // line (rather than clamping x and y separately) is what keeps this
  // answer identical to the extended schedule the renderers run.
  const extra = Math.min((t - s.end) * s.speed, distanceToBounds(end, dir))
  return { x: end.x + dir.x * extra, y: end.y + dir.y * extra }
}

/**
 * A copy of the schedule with one player's route extended so he keeps
 * running until `until`. Only ever as much as the football needs; the
 * drawn route itself is untouched (`drawnLength` remembers where it ended).
 */
export function extendUntil(schedule: ScheduleMap, p: Player, until: number): ScheduleMap {
  const s = schedule.get(p.id)
  if (!s || until <= s.end) return schedule
  const target = posBeyond(s, p, until)
  const end = s.pts[s.pts.length - 1]
  const extra = Math.hypot(target.x - end.x, target.y - end.y)
  if (extra < 0.05) return schedule
  const pts = [...s.pts, target]
  const cum = [...s.cum, s.length + extra]
  const next = new Map(schedule)
  next.set(p.id, { ...s, pts, cum, length: s.length + extra, end: s.start + (s.length + extra) / s.speed + holdDur(s) })
  return next
}
