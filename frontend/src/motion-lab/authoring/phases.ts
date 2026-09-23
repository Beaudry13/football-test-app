// One man, two phases: PRE-SNAP MOTION and the POST-SNAP route (P3.4).
//
// The engine stitches them into one line (timeline.ts); this module is the
// editor's side of the same deal - the rules that keep the two lines joined
// while a coach edits either one. They are pure, so the strip, the board,
// copy/mirror and the group moves all obey exactly the same ones.
//
// THE JOIN IS THE WHOLE POINT. His route begins where his motion ends, and
// nothing a coach does to one line may pull them apart:
//   - move the end of his motion  -> the route slides with it, shape intact;
//   - clear his motion            -> the route slides back to his alignment;
//   - draw his route              -> it starts at the end of his motion.
// The endpoint is never stored on its own. It is the last motion anchor.

import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import type { Engagement } from '../engine/interactions'

export type Phase = 'motion' | 'route'

export const hasMotion = (p: Player | null | undefined): p is Player & { motion: Pt[] } =>
  !!p && !!p.motion && p.motion.length >= 2

/** A route drawn the old way, as pre-snap timing - until the coach decides. */
export const isLegacyPreSnap = (p: Player | null | undefined): boolean =>
  !!p && p.timing === 'pre-snap' && !hasMotion(p)

/** Where the snap catches him: the end of his motion, or where he lines up. */
export function snapPoint(p: Player): Pt {
  return hasMotion(p) ? p.motion[p.motion.length - 1] : { x: p.x, y: p.y }
}

const shiftAll = (pts: Pt[], dx: number, dy: number): Pt[] => pts.map((q) => ({ x: q.x + dx, y: q.y + dy }))

/**
 * Give him this motion (or none), keeping his route's shape and its start on
 * the new snap point. The route is translated, never redrawn.
 */
export function withMotion(p: Player, motion: Pt[] | undefined): Player {
  const from = snapPoint(p)
  const { motion: _old, ...rest } = p
  const next: Player = motion && motion.length >= 2 ? { ...rest, motion } : rest
  const to = snapPoint(next)
  const path = p.path.length >= 2 ? shiftAll(p.path, to.x - from.x, to.y - from.y) : p.path
  return { ...next, path }
}

/** Move one motion anchor. Moving the LAST one moves the route with it. */
export function withMotionAnchor(p: Player, index: number, at: Pt): Player {
  if (!hasMotion(p)) return p
  const motion = p.motion.slice()
  motion[index] = at
  return withMotion(p, motion)
}

/** A legacy pre-snap line becomes his motion; his route is still to draw. */
export function convertToMotion(p: Player): Player {
  if (!isLegacyPreSnap(p) || p.path.length < 2) return p
  return { ...p, motion: p.path, path: [], timing: 'on-snap' }
}

/** A legacy pre-snap line becomes an ordinary route that runs on the snap. */
export const runOnSnap = (p: Player): Player => ({ ...p, timing: 'on-snap' })

/** Move the man, and both his lines with him. */
export function movedTo(p: Player, x: number, y: number): Player {
  const dx = x - p.x
  const dy = y - p.y
  return {
    ...p,
    x,
    y,
    path: shiftAll(p.path, dx, dy),
    ...(p.motion ? { motion: shiftAll(p.motion, dx, dy) } : null),
  }
}

// ---------------------------------------------------------------------------
// The one combination the schedule cannot run
// ---------------------------------------------------------------------------

/**
 * A man can pause ONCE: to wait at the snap (Delayed) or to come off a block
 * (Releases). A man with motion who did both would need two pauses. So of
 * motion, Delayed and Releases, whichever two he has, the third is refused -
 * before he presses it, with the reason in football words.
 */
export const releases = (p: Player, engagements: Engagement[]) => engagements.some((e) => e.release === p.id)

export const WHY_NOT_DELAYED = "He motions and comes off his block, so he can't also wait at the snap. Take off the release or the motion first."
export const WHY_NOT_RELEASE = "He motions and waits at the snap, so he can't also come off a block. Take off the delay or the motion first."
export const WHY_NOT_MOTION = "He waits at the snap and comes off his block, so he can't also motion. Take off the delay or the release first."

export function delayedBlocked(p: Player, engagements: Engagement[]): string | null {
  return hasMotion(p) && releases(p, engagements) ? WHY_NOT_DELAYED : null
}
export function releaseBlocked(p: Player): string | null {
  return hasMotion(p) && p.timing === 'delayed' ? WHY_NOT_RELEASE : null
}
export function motionBlocked(p: Player, engagements: Engagement[]): string | null {
  return p.timing === 'delayed' && releases(p, engagements) ? WHY_NOT_MOTION : null
}
