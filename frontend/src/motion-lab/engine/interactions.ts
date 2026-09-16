// Player-to-player interactions. V1: ENGAGE - two players the coach says
// meet at a point he picks.
//
// Not physics. The coach stores an INTENT (who, who, where); everything
// else - where each path is cut, when each man arrives, who eases up to
// arrive together, whether the point is even reachable - is derived from
// the movement schedule every time it is needed, the same way the ball is.
// Nothing here stores a timestamp.
//
// Works between ANY two players; the football meaning ("pull and fit",
// "pass set vs rush", "climb to the second level") is the coach's choice.

import type { Player } from './formation'
import { cumulativeLength, pointAtDistance, type Pt } from './geometry'
import { projectOntoPath } from './ball'
import type { Schedule, ScheduleMap } from './timeline'

export interface Engagement {
  id: string
  kind: 'engage'
  a: string
  b: string
  /** Where they meet, field yards. */
  point: Pt
  /**
   * The player who comes off the block after a moment and carries on with
   * the path the coach already drew. Absent = both hold for the play.
   * (A later "release earlier / later / at" would sit beside this; the
   * derivation below is the only place that would need to know.)
   */
  release?: string
}

export interface DerivedEngagement {
  id: string
  a: string
  b: string
  point: Pt
  /** True when both can actually get there; otherwise nothing is changed. */
  valid: boolean
  /** Playback time they are engaged from; null when invalid. */
  time: number | null
  /** Playback time the engagement ends, when someone releases; null = held for the play. */
  until: number | null
  warning: string | null
}

// Tuning. Internal.
/** A player's path must pass within this of the point, or he cannot be asked to be there. */
const REACH = 2.5
/** Markers stop this short of the point, on their own side, so they touch rather than overlap. */
const TOUCH = 0.45
/** An early arriver eases up to arrive on time, but never below this fraction of his speed. */
const MIN_PACE = 0.6
/** A wait longer than this is worth telling the coach about. */
const LONG_WAIT = 0.8
/** How long a chip / brief engagement lasts before the releasing man carries on. */
const RELEASE_AFTER = 0.5

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

interface Approach {
  gap: number
  /** Arc distance along the rendered path to the closest point. */
  along: number
  /** Playback time he gets there at his own pace. */
  arrival: number
  /** Unit direction he comes in on. */
  dir: Pt
}

function approach(p: Player, s: Schedule | undefined, point: Pt, snapAt: number): Approach {
  if (!s) {
    // No path: he is standing there (or he isn't, and it's invalid).
    const gap = dist({ x: p.x, y: p.y }, point)
    const dir = gap > 0.1 ? { x: (point.x - p.x) / gap, y: (point.y - p.y) / gap } : { x: 0, y: p.side === 'defense' ? -1 : 1 }
    return { gap, along: 0, arrival: snapAt, dir }
  }
  const proj = projectOntoPath(s.pts, s.cum, point)
  const back = pointAtDistance(s.pts, s.cum, Math.max(0, proj.along - 1))
  const len = dist(back, point)
  const dir = len > 0.1 ? { x: (point.x - back.x) / len, y: (point.y - back.y) / len } : { x: 0, y: p.side === 'defense' ? -1 : 1 }
  return { gap: proj.gap, along: proj.along, arrival: s.start + proj.along / s.speed, dir }
}

/**
 * The releasing man: same drawn path, with a stop at the contact point, a
 * hold through the engagement, then the rest of the route at his own pace.
 * He is not slowed on the way in - if he is early he waits at the point.
 */
function throughTo(s: Schedule, along: number, stop: Pt, meet: number, until: number): Schedule {
  const before: Pt[] = []
  const after: Pt[] = []
  for (let i = 0; i < s.pts.length; i++) (s.cum[i] < along ? before : after).push(s.pts[i])
  if (before.length === 0) before.push(s.pts[0])
  const pts = [...before, stop, ...after]
  const cum = cumulativeLength(pts)
  const length = cum[cum.length - 1]
  const reach = s.start + cum[before.length] / s.speed
  const from = Math.min(reach, meet)
  return { ...s, pts, cum, length, drawnLength: length, hold: { from, until }, end: s.start + length / s.speed + (until - from) }
}

/** Cut a path at `along` and finish it at `stop`; pace it to arrive at `at` (never slower than MIN_PACE). */
function cutTo(s: Schedule, along: number, stop: Pt, at: number): Schedule {
  const pts: Pt[] = []
  for (let i = 0; i < s.pts.length && s.cum[i] < along; i++) pts.push(s.pts[i])
  if (pts.length === 0) pts.push(s.pts[0])
  pts.push(stop)
  const cum = cumulativeLength(pts)
  const length = cum[cum.length - 1]
  const natural = length / s.speed
  const wanted = at - s.start
  const speed = wanted > natural ? Math.max(MIN_PACE * s.speed, length / wanted) : s.speed
  return { ...s, pts, cum, length, drawnLength: length, speed, end: s.start + length / speed }
}

export function applyEngagements(
  schedule: ScheduleMap,
  players: Player[],
  engagements: Engagement[],
  snapAt: number,
): { schedule: ScheduleMap; derived: DerivedEngagement[] } {
  const byId = new Map(players.map((p) => [p.id, p]))
  const out: ScheduleMap = new Map(schedule)
  const derived: DerivedEngagement[] = []
  const busy = new Set<string>()

  for (const e of engagements) {
    const A = byId.get(e.a)
    const B = byId.get(e.b)
    const base = { id: e.id, a: e.a, b: e.b, point: e.point }
    if (!A || !B) continue
    // One man, one engagement. A second one is ambiguous, so it is refused.
    if (busy.has(e.a) || busy.has(e.b)) {
      const who = busy.has(e.a) ? A : B
      derived.push({ ...base, valid: false, time: null, until: null, warning: `${who.label} is already engaged with someone else.` })
      continue
    }
    const apA = approach(A, out.get(e.a), e.point, snapAt)
    const apB = approach(B, out.get(e.b), e.point, snapAt)
    const far = apA.gap > REACH ? A : apB.gap > REACH ? B : null
    if (far) {
      const gap = far === A ? apA.gap : apB.gap
      derived.push({
        ...base,
        valid: false,
        time: null,
        until: null,
        warning: `${far.label} never gets near that spot (${gap.toFixed(1)} yd off his path). Move the point or his path.`,
      })
      continue
    }
    // They meet when the later of the two gets there. The earlier one eases
    // up on the way rather than standing around, within reason.
    const time = Math.max(apA.arrival, apB.arrival, snapAt + 0.05)
    // Where each man actually stops. Coming from opposite sides they each
    // pull up short on their own side and touch. Coming from the SAME side
    // (a pass set and a rush both heading for the QB) the man whose path
    // ENDS at the point holds it - that is where he was going - and the man
    // passing through is stopped just behind him. If both end there (or
    // neither), the one further along the line holds it.
    const sameSide = apA.dir.x * apB.dir.x + apA.dir.y * apB.dir.y > 0.5
    const stops = new Map<string, Pt>()
    if (sameSide) {
      const dir = apA.dir
      const endsThere = (p: Player, ap: Approach) => {
        const s = out.get(p.id)
        return !s || s.length - ap.along < 1.0
      }
      const depth = (p: Player) => {
        const s = out.get(p.id)
        const from = s ? pointAtDistance(s.pts, s.cum, Math.max(0, projectOntoPath(s.pts, s.cum, e.point).along - 1)) : { x: p.x, y: p.y }
        return from.x * dir.x + from.y * dir.y
      }
      const endA = endsThere(A, apA)
      const endB = endsThere(B, apB)
      const aLeads = endA !== endB ? endA : depth(A) >= depth(B)
      const [lead, trail] = aLeads ? [A, B] : [B, A]
      stops.set(lead.id, { x: e.point.x - dir.x * 0.1, y: e.point.y - dir.y * 0.1 })
      stops.set(trail.id, { x: e.point.x - dir.x * TOUCH * 2.2, y: e.point.y - dir.y * TOUCH * 2.2 })
    } else {
      stops.set(A.id, { x: e.point.x - apA.dir.x * TOUCH, y: e.point.y - apA.dir.y * TOUCH })
      stops.set(B.id, { x: e.point.x - apB.dir.x * TOUCH, y: e.point.y - apB.dir.y * TOUCH })
    }
    // Release: a moment after contact the named man carries on with the rest
    // of his drawn path. Derived, never stored.
    const releaser = e.release && (e.release === e.a || e.release === e.b) ? e.release : null
    const until = releaser ? time + RELEASE_AFTER : null
    let warning: string | null = null
    for (const [p, ap] of [
      [A, apA],
      [B, apB],
    ] as const) {
      const s = out.get(p.id)
      if (!s) continue
      if (p.id === releaser && until !== null) {
        if (s.length - ap.along < 0.5) {
          warning = `${p.label}'s path ends at the engage point - there is nothing to release into.`
          out.set(p.id, cutTo(s, ap.along, stops.get(p.id)!, time))
        } else {
          out.set(p.id, throughTo(s, ap.along, stops.get(p.id)!, time, until))
        }
        continue
      }
      const cut = cutTo(s, ap.along, stops.get(p.id)!, time)
      out.set(p.id, cut)
      const wait = time - cut.end
      if (wait > LONG_WAIT && !warning) warning = `${p.label} gets there ${wait.toFixed(1)}s early and has to wait.`
    }
    busy.add(e.a)
    busy.add(e.b)
    derived.push({ ...base, valid: true, time, until, warning })
  }
  return { schedule: out, derived }
}
