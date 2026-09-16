// Pure path math. Everything here works in FIELD coordinates (yards) and
// knows nothing about the screen, so the same path data could later be
// rendered overhead, zoomed, or from a perspective camera.

export interface Pt {
  x: number
  y: number
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** Perpendicular distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

/**
 * Ramer–Douglas–Peucker point reduction. Keeps the points that define the
 * shape (stems, breaks) and throws away the jitter between them. A small
 * epsilon deliberately preserves what the coach drew rather than
 * reinterpreting it.
 */
export function simplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  const first = pts[0]
  const last = pts[pts.length - 1]
  let maxD = 0
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], first, last)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= epsilon) return [first, last]
  const left = simplify(pts.slice(0, idx + 1), epsilon)
  const right = simplify(pts.slice(idx), epsilon)
  return left.slice(0, -1).concat(right)
}

/**
 * One pass of Chaikin corner cutting, endpoints pinned. Takes the edge off
 * the polyline corners so the animated player doesn't visibly "snap" at
 * every vertex, without turning a hard break into a wide arc.
 */
export function smooth(pts: Pt[], iterations = 1): Pt[] {
  let out = pts
  for (let k = 0; k < iterations; k++) {
    if (out.length < 3) return out
    const next: Pt[] = [out[0]]
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i]
      const b = out[i + 1]
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    next.push(out[out.length - 1])
    out = next
  }
  return out
}

/** Cumulative arc length at each vertex; cum[0] = 0. */
export function cumulativeLength(pts: Pt[]): number[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  return cum
}

/** Position `d` yards along the path (clamped to both ends). */
export function pointAtDistance(pts: Pt[], cum: number[], d: number): Pt {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1 || d <= 0) return pts[0]
  const total = cum[cum.length - 1]
  if (d >= total) return pts[pts.length - 1]
  // Binary search for the segment containing d.
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid
  }
  const segLen = cum[hi] - cum[lo]
  const t = segLen === 0 ? 0 : (d - cum[lo]) / segLen
  return {
    x: pts[lo].x + (pts[hi].x - pts[lo].x) * t,
    y: pts[lo].y + (pts[hi].y - pts[lo].y) * t,
  }
}

// ---- anchors → rendered path ------------------------------------------
//
// A stored path is a SHORT list of anchors: start, the direction changes
// the coach drew, end. The polyline that is drawn and animated is derived
// from those anchors here. Keeping only anchors is what makes Edit Path
// usable (a handful of handles, not hundreds) and what lets a moved break
// re-derive its curve instead of dragging a frozen sample cloud around.

/** Change of direction at b, in degrees (0 = straight on, 180 = reversal). */
export function turnAngle(a: Pt, b: Pt, c: Pt): number {
  const ax = b.x - a.x
  const ay = b.y - a.y
  const bx = c.x - b.x
  const by = c.y - b.y
  const la = Math.hypot(ax, ay)
  const lb = Math.hypot(bx, by)
  if (la === 0 || lb === 0) return 0
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
  return (Math.acos(cos) * 180) / Math.PI
}

/**
 * A turn at least this hard is a football BREAK (out, dig, post, corner,
 * slant) and is rendered as a true corner. Anything gentler is a curve the
 * coach drew by hand and gets rounded. Automatic, so a break dragged in
 * Edit Path stays sharp without the coach having to say so.
 */
export const SHARP_BREAK_DEG = 60

/**
 * Corner-cut every SMOOTH vertex (Chaikin, 25%), leave every SHARP vertex
 * alone, endpoints pinned. Two passes give hand-drawn arcs a clean curve;
 * a sharp vertex keeps its exact angle through both.
 */
export function renderPath(anchors: Pt[], passes = 2): Pt[] {
  let out = anchors
  for (let k = 0; k < passes; k++) {
    if (out.length < 3) return out
    const sharp = out.map((p, i) => i > 0 && i < out.length - 1 && turnAngle(out[i - 1], p, out[i + 1]) >= SHARP_BREAK_DEG)
    const next: Pt[] = [out[0]]
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]
      const b = out[i]
      const c = out[i + 1]
      if (sharp[i]) {
        next.push(b)
      } else {
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
        next.push({ x: b.x * 0.75 + c.x * 0.25, y: b.y * 0.75 + c.y * 0.25 })
      }
    }
    next.push(out[out.length - 1])
    out = next
  }
  return out
}

// ---- end-of-route geometry ---------------------------------------------
//
// What a receiver does when his drawn route runs out. Geometry only: no
// route names, no recognition. Two signals, both cheap:
//   1. the route finishes working BACK toward the line (comeback, curl, hitch)
//   2. the route finishes with a SHORT leg after a hard break (hitch, sit)
// Either reads as "settle"; everything else keeps running. Wrong sometimes -
// that is what the coach's override is for.

export type EndBehavior = 'continue' | 'settle'

/** Turn-back this steep at the end is a settle (unit-vector y component). */
const SETTLE_BACK_Y = -0.35
/** A leg shorter than this after a hard break is a hook, not a route. */
const SETTLE_SHORT_LEG = 2

/**
 * Stable direction of the last `span` yards of a rendered path, as a unit
 * vector. Smoothing can leave a tiny odd final segment; this looks past it.
 */
export function endDirection(pts: Pt[], cum: number[], span = 2): Pt {
  const end = pts[pts.length - 1]
  const total = cum[cum.length - 1]
  const from = pointAtDistance(pts, cum, Math.max(0, total - span))
  const dx = end.x - from.x
  const dy = end.y - from.y
  const len = Math.hypot(dx, dy)
  return len === 0 ? { x: 0, y: 1 } : { x: dx / len, y: dy / len }
}

export function classifyEnd(pts: Pt[], cum: number[]): EndBehavior {
  const total = cum[cum.length - 1]
  if (pts.length < 2 || total < 1) return 'settle'
  const dir = endDirection(pts, cum)
  if (dir.y < SETTLE_BACK_Y) return 'settle'
  // Last hard break, walking back from the end.
  for (let i = pts.length - 2; i >= 1; i--) {
    if (turnAngle(pts[i - 1], pts[i], pts[i + 1]) >= SHARP_BREAK_DEG) {
      return total - cum[i] < SETTLE_SHORT_LEG ? 'settle' : 'continue'
    }
  }
  return 'continue'
}
