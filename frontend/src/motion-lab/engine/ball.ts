// The football.
//
// The coach states an INTENT ("handoff to the back", "throw to X here") and
// everything else — snap, mesh moment, release time, flight — is derived
// from the players' movement schedule every time it is needed. Nothing here
// stores a timestamp or a pixel, so editing a route, moving a player or
// changing a speed simply re-derives the ball.
//
// Possession model: the ball is either sitting at the snap spot, being
// snapped, HELD by a player (position derived from that player), or in a
// short TRANSFER between two players (handoff, fake, pass flight).
//
// The QB's path is drawn like anyone else's, but the engine knows whose it
// is: WHERE he throws from is a point on that path (its end unless the coach
// picks another), and WHEN he throws is simply when he gets there.

import { roleHolder, type Player } from './formation'
import type { Pt } from './geometry'
import { extendUntil, posAt, posBeyond, resolveEnd, timeAtAlong, type ScheduleMap } from './timeline'

export type BallAction =
  | { kind: 'keep' }
  | { kind: 'handoff'; carrierId: string }
  /** The carrier tosses it through the air to a nearby teammate; both keep running. */
  | { kind: 'pitch'; targetId: string }
  | { kind: 'pass'; targetId: string; catchPoint: Pt; releasePoint?: Pt }
  | { kind: 'play-action'; fakeId: string; targetId: string; catchPoint: Pt; releasePoint?: Pt }

export type BallPhase = 'spot' | 'snap' | 'carry' | 'handoff' | 'fake' | 'flight' | 'pitch'

export interface BallFrame {
  pos: Pt
  phase: BallPhase
  carrierId: string | null
  /** 0..1 height cue during a pass; purely visual. */
  lift: number
}

export interface BallTimeline {
  at: (t: number) => BallFrame
  /**
   * The movement schedule the play actually runs on: the input schedule,
   * plus any continuation the football needed from its receiver. Both
   * renderers read THIS one, so a receiver and the ball cannot disagree.
   */
  schedule: ScheduleMap
  /** Playback time the ball is finally settled (for the play's duration). */
  end: number
  /** Where the QB actually releases (null unless a pass is configured). */
  releasePoint: Pt | null
  /** Effective catch point after any timing correction; null if no pass. */
  catchPoint: Pt | null
  /** The coach's requested catch spot, projected onto the route. */
  requestedCatch: Pt | null
  /** True when the ball arrives somewhere other than the requested spot. */
  catchAdjusted: boolean
  /** Seconds the QB held past the top of his drop so the ball lands on the coach's spot. */
  qbHold: number
  /** Seconds before the top of his drop the QB let it go, for the same reason. */
  qbEarly: number
  /** True when the coach fixed the throw point himself (Throw From Here). */
  releaseIsManual: boolean
  /** Who threw the pass (label), for feedback. */
  passer: string
  /** Who has the ball after the FIRST action completes, and from when; null if it never transferred. */
  chain: { carrierId: string; time: number } | null
  warning: string | null
}

// Tuning. Internal; deliberately not coach-facing.
const SNAP_UNDER_CENTER = 0.25
const SNAP_SHOTGUN = 0.45
const SHOTGUN_DEPTH = 3
const MESH_DIST = 1.5
/** The QB visibly has the ball before anything else can happen to it. */
const MIN_QB_HOLD = 0.15
const HANDOFF_DUR = 0.2
const FAKE_DUR = 0.4
/** A pitch reads as a pitch between these distances; beyond the tolerant limit it's a pass. */
const PITCH_MIN = 2.0
const PITCH_MAX = 7.0
const PITCH_TOLERANT = 9.0
/** A pitch this far forward reads like a pass; say so, still draw it. */
const PITCH_FORWARD_WARN = 3.0
/** A QB with no drawn movement throws quick game: set and throw from the spot. */
const QUICK_GAME_RELEASE = 0.6
const FLIGHT_MIN = 0.5
const FLIGHT_MAX = 1.1
/** Receiver within this of the ball's arrival: the throw is simply paced to hit the spot. */
const SYNC_TOLERANCE = 0.35
/** The QB will hold at the top of his drop this long for a receiver's timing, no longer. */
const MAX_HOLD = 2.0
/** A moved catch this close to the requested spot is the same spot (receiver got there and waited). */
const SAME_SPOT = 0.6
const SCAN_STEP = 1 / 60
/** The ball is carried tucked just beside the marker, not under it. */
const HOLD: Pt = { x: 0.7, y: 0 }
/** A receiver who catches on the run keeps running this long; then the play is over. */
const CARRY_AFTER_CATCH = 0.5

const lerp = (a: Pt, b: Pt, u: number): Pt => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
// Roughly: a 10-yard throw ~0.6s, 20 ~0.85s, 30 ~1.1s. Readable, not ballistic.
const flightFor = (throwDist: number) => Math.max(FLIGHT_MIN, Math.min(FLIGHT_MAX, 0.35 + throwDist * 0.025))

/** Nearest point on a polyline to p, plus its arc distance. */
export function projectOntoPath(pts: Pt[], cum: number[], p: Pt): { pt: Pt; along: number; gap: number } {
  let best = { pt: pts[0], along: 0, gap: dist(p, pts[0]) }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let u = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    u = Math.max(0, Math.min(1, u))
    const q = { x: a.x + dx * u, y: a.y + dy * u }
    const gap = dist(p, q)
    if (gap < best.gap) best = { pt: q, along: cum[i] + Math.sqrt(len2) * u, gap }
  }
  return best
}

/**
 * The same projection, onto the POST-SNAP route only (P3.4).
 *
 * A player with pre-snap motion carries one stitched line: motion, then the
 * route. A catch, a throw or a block is a post-snap event, so it must never
 * land on where he was before the snap. With no motion this IS
 * projectOntoPath, exactly.
 */
export function projectOntoRoute(s: { pts: Pt[]; cum: number[]; preLength?: number }, p: Pt): { pt: Pt; along: number; gap: number } {
  if (!s.preLength) return projectOntoPath(s.pts, s.cum, p)
  let i = 0
  while (i < s.cum.length - 1 && s.cum[i] < s.preLength - 1e-9) i++
  const proj = projectOntoPath(s.pts.slice(i), s.cum.slice(i).map((c) => c - s.cum[i]), p)
  return { ...proj, along: proj.along + s.cum[i] }
}

interface Transfer {
  kind: 'handoff' | 'fake' | 'flight' | 'pitch'
  time: number
  dur: number
  fromId: string
  toId: string
  /** Pass only: fixed endpoints, because the thrower keeps moving after release. */
  from?: Pt
  to?: Pt
}

export function summarize(action: BallAction | null, players: Player[]): string {
  if (!action) return 'Ball'
  const name = (id: string) => players.find((p) => p.id === id)?.label ?? '?'
  switch (action.kind) {
    case 'keep':
      return 'Ball: QB Keep'
    case 'handoff':
      return `Ball: Handoff → ${name(action.carrierId)}`
    case 'pitch':
      return `Ball: Pitch → ${name(action.targetId)}`
    case 'pass':
      return `Ball: Pass → ${name(action.targetId)}`
    case 'play-action':
      return `Ball: Play Action → ${name(action.fakeId)} → ${name(action.targetId)}`
  }
}

export const isPass = (a: BallAction | null): a is Extract<BallAction, { kind: 'pass' | 'play-action' }> =>
  a?.kind === 'pass' || a?.kind === 'play-action'

/** The player the ball is going TO through the air, if any (pass or pitch). */
export const ballTargetOf = (a: BallAction | null): string | null => (a && 'targetId' in a ? a.targetId : null)

/** Which second actions the planners can safely run from a non-QB carrier. */
export const THEN_KINDS = ['handoff', 'pitch', 'pass'] as const

export function deriveBall(players: Player[], schedule: ScheduleMap, snapAt: number, action: BallAction | null, then: BallAction | null = null): BallTimeline {
  const byId = new Map(players.map((p) => [p.id, p]))
  // Who snaps it and who throws it, by ROLE - falling back to the labels this
  // engine has always used when the play carries no roles (roleHolder).
  const center = roleHolder(players, 'snapper', 'C')
  const qb = roleHolder(players, 'passer', 'QB')

  // The snap spot is the center's feet, on the line, whatever the formation.
  const spot: Pt = center ? { x: center.x, y: center.y + 1.0 } : { x: 53.33 / 2, y: 0.4 }
  // `sched` is swapped for the extended schedule once the pass is planned,
  // so `at()` and the renderers follow the same continuation.
  let sched = schedule
  const held = (id: string, t: number): Pt => add(posAt(sched, byId.get(id)!, t), HOLD)

  const empty: BallTimeline = {
    at: () => ({ pos: spot, phase: 'spot', carrierId: null, lift: 0 }),
    schedule,
    end: snapAt,
    releasePoint: null,
    catchPoint: null,
    requestedCatch: null,
    catchAdjusted: false,
    qbHold: 0,
    qbEarly: 0,
    releaseIsManual: false,
    passer: 'QB',
    chain: null,
    warning: null,
  }
  if (!qb) return { ...empty, warning: 'No QB on the field.' }

  const snapDur = spot.y - qb.y > SHOTGUN_DEPTH ? SNAP_SHOTGUN : SNAP_UNDER_CENTER
  const snapArrive = snapAt + snapDur

  const transfers: Transfer[] = []
  let warning: string | null = null
  let catchPoint: Pt | null = null
  let requestedCatch: Pt | null = null
  let releasePoint: Pt | null = null
  let catchAdjusted = false
  let qbHold = 0
  let qbEarly = 0
  let releaseIsManual = false
  let passer = qb.label
  let chain: { carrierId: string; time: number } | null = null
  const warn = (msg: string) => {
    warning = warning ? `${warning} ${msg}` : msg
  }

  // Earliest moment (from `from`) the carrier and a back are within mesh
  // distance; failing that, the moment they are closest. Never fails.
  const findMesh = (carrierId: string, backId: string, from: number): { time: number; gap: number } => {
    const carrier = byId.get(carrierId)!
    const back = byId.get(backId)!
    const horizon = Math.max(schedule.get(carrierId)?.end ?? 0, schedule.get(backId)?.end ?? 0, from + 0.5)
    let best = { time: from, gap: Infinity }
    for (let t = from; t <= horizon; t += SCAN_STEP) {
      const gap = dist(posAt(schedule, carrier, t), posAt(schedule, back, t))
      if (gap <= MESH_DIST) return { time: t, gap }
      if (gap < best.gap) best = { time: t, gap }
    }
    return best
  }

  // The QB throws from a point on his own path — its end by default, or the
  // spot the coach picked — and he throws when he gets there. With no path he
  // sets and throws quick game from where he stands. Nothing here can happen
  // before `earliest` (the snap arriving, or a fake finishing).
  const releaseTimeFor = (passerId: string, override: Pt | undefined, earliest: number): number => {
    const sq = schedule.get(passerId)
    if (!sq) return Math.max(earliest, earliest + QUICK_GAME_RELEASE - 0.1)
    const along = override ? projectOntoRoute(sq, override).along : sq.length
    return Math.max(earliest, timeAtAlong(sq, along))
  }

  // The QB's release is the football constraint. The receiver either gets
  // to the requested spot as the ball arrives (then the throw is paced to
  // land exactly there) or he doesn't, and the catch moves to where he
  // actually is when the ball can get there.
  const planPass = (passerId: string, targetId: string, requested: Pt, override: Pt | undefined, earliest: number) => {
    const thrower = byId.get(passerId)!
    passer = thrower.label
    const target = byId.get(targetId)!
    const s = schedule.get(targetId)
    // A CONTINUE receiver keeps running past his drawn route; a SETTLE
    // receiver waits at its end. Where he is at time t depends on which.
    const behavior = s ? resolveEnd(target, s) : 'settle'
    const posExt = (t: number): Pt => (s && behavior === 'continue' ? posBeyond(s, target, t) : posAt(schedule, target, t))

    let catchAt: Pt
    let requestedTime: number | null = null
    if (s) {
      const proj = projectOntoRoute(s, requested)
      catchAt = proj.pt
      requestedCatch = proj.pt
      // His ACTUAL schedule - including any engagement, wait or release on the way.
      requestedTime = timeAtAlong(s, proj.along)
    } else {
      catchAt = { x: target.x, y: target.y }
    }

    // The QB's default throw: the top of his drop, quick game from the
    // spot, or the coach's Throw From Here. Unless the coach fixed the
    // point himself, the drawn path is his AVAILABLE movement, not a
    // mandate to finish it: walk his schedule from the earliest legal throw
    // to the top of the drop plus a hold, and let go at the first instant
    // the ball can leave and still land on the coach's spot as the
    // receiver arrives. Earlier than the top of the drop is an early
    // release on the move; later is a hold at the top. One scan, three
    // outcomes. His path is untouched either way.
    const natural = releaseTimeFor(passerId, override, earliest)
    let release = natural
    releaseIsManual = !!override
    if (!override && requestedTime !== null) {
      // A passer with no path throws quick game from the spot; keep that beat.
      const lo = schedule.has(passerId) ? earliest : natural
      const hi = natural + MAX_HOLD
      const arrivalIf = (T: number) => T + flightFor(dist(posAt(schedule, thrower, T), catchAt))
      let found: number | null = null
      for (let T = lo; T <= hi + 1e-9; T += SCAN_STEP) {
        if (arrivalIf(T) >= requestedTime) {
          found = T
          break
        }
      }
      release = found ?? hi
      qbEarly = Math.max(0, natural - release)
      qbHold = Math.max(0, release - natural)
    }
    const from = posAt(schedule, thrower, release)
    releasePoint = from

    let flight = flightFor(dist(from, catchAt))
    if (requestedTime !== null) {
      const diff = requestedTime - (release + flight)
      if (Math.abs(diff) <= SYNC_TOLERANCE) {
        // Close enough: a touch more or less on the throw lands it on the spot.
        flight = Math.max(0.3, Math.min(1.4, requestedTime - release))
      } else {
        // Catch the receiver where he is when the ball can arrive. Two passes
        // because moving the catch changes the throw distance and so the
        // flight; the last line re-reads his position for the FINAL flight so
        // ball and receiver land on the same point at the same instant.
        for (let i = 0; i < 2; i++) {
          catchAt = posExt(release + flight)
          flight = flightFor(dist(from, catchAt))
        }
        catchAt = posExt(release + flight)
        // A receiver who gets to the spot early and waits there is not an
        // adjustment - the ball still lands where the coach asked.
        catchAdjusted = dist(catchAt, requestedCatch!) > SAME_SPOT
        if (catchAdjusted) {
          const beyondRoute = s && behavior === 'continue' && release + flight > s.end
          warning = beyondRoute
            ? `${target.label} runs out of drawn route before the ball arrives — he keeps going and the catch moved to meet him.`
            : diff > 0
              ? `${target.label} reaches that spot ${diff.toFixed(1)}s after the ball can get there — catch moved earlier on the route.`
              : release <= earliest + 1e-6
                ? `${target.label} is at that spot ${(-diff).toFixed(1)}s before ${thrower.label} can legally let it go — catch adjusted. Move the catch deeper or shorten ${thrower.label}'s path.`
                : `${target.label} is past that spot before ${thrower.label} can throw — catch moved later on the route.`
        }
      }
    }
    catchPoint = catchAt
    const catchTime = release + flight
    transfers.push({ kind: 'flight', time: release, dur: flight, fromId: passerId, toId: targetId, from: add(from, HOLD), to: add(catchAt, HOLD) })
    // Only as much continuation as the football needed: through the catch
    // and a short carry, never a fixed bolt-on of yards.
    if (s && behavior === 'continue' && catchTime + CARRY_AFTER_CATCH > s.end) {
      sched = extendUntil(schedule, target, catchTime + CARRY_AFTER_CATCH)
    }
  }

  // A pitch: the carrier (the QB, after the snap) tosses it to a nearby
  // teammate at the earliest moment the two are in a pitch relationship -
  // close, but not on top of each other - and both keep running. The ball
  // is led to where the target will be when it lands. No window at all
  // means no pitch: the QB keeps it and the coach is told why.
  const planPitch = (carrierId: string, targetId: string, from: number) => {
    const carrier = byId.get(carrierId)!
    const target = byId.get(targetId)!
    const horizon = Math.max(schedule.get(carrierId)?.end ?? 0, schedule.get(targetId)?.end ?? 0, from + 1.0)
    let best = { time: from, gap: Infinity }
    let found: number | null = null
    for (let t = from; t <= horizon; t += SCAN_STEP) {
      const gap = dist(posAt(schedule, carrier, t), posAt(schedule, target, t))
      if (gap >= PITCH_MIN && gap <= PITCH_MAX) {
        found = t
        break
      }
      if (gap < best.gap) best = { time: t, gap }
    }
    let time = found
    if (time === null) {
      if (best.gap <= PITCH_TOLERANT) {
        time = best.time
        warn(`${carrier.label} and ${target.label} never get within a clean pitch — tossing it at their closest (${best.gap.toFixed(1)} yd).`)
      } else {
        warn(`No natural pitch window between ${carrier.label} and ${target.label} (never closer than ${best.gap.toFixed(1)} yd). ${carrier.label} keeps it.`)
        return
      }
    }
    const start = posAt(schedule, carrier, time)
    const gap0 = dist(start, posAt(schedule, target, time))
    // Short, readable arc: a 3-yard toss ~0.4s, a 7-yard pitch ~0.65s.
    const dur = Math.max(0.3, Math.min(0.7, 0.25 + gap0 * 0.06))
    const landAt = posAt(schedule, target, time + dur)
    const forward = target.side === 'offense' ? landAt.y - start.y : start.y - landAt.y
    if (!warning && forward > PITCH_FORWARD_WARN) warn(`That pitch travels ${forward.toFixed(1)} yd forward — it reads more like a pass.`)
    transfers.push({ kind: 'pitch', time, dur, fromId: carrierId, toId: targetId, from: add(start, HOLD), to: add(landAt, HOLD) })
  }

  // Run one football action from whoever has the ball at `has`. Returns
  // who has it afterwards and from when - null if it never transferred.
  // Possession is the only thing the second action needs to know.
  const run = (a: BallAction, carrierId: string, has: number): { carrierId: string; time: number } | null => {
    const carrier = byId.get(carrierId)!
    if (a.kind === 'keep') return { carrierId, time: has }
    if (a.kind === 'handoff' && byId.has(a.carrierId) && a.carrierId !== carrierId) {
      const mesh = findMesh(carrierId, a.carrierId, has + MIN_QB_HOLD)
      if (mesh.gap > 3) warn(`${carrier.label} and ${byId.get(a.carrierId)!.label} never meet — handing off at their closest point.`)
      transfers.push({ kind: 'handoff', time: mesh.time, dur: HANDOFF_DUR, fromId: carrierId, toId: a.carrierId })
      return { carrierId: a.carrierId, time: mesh.time + HANDOFF_DUR }
    }
    if (a.kind === 'pitch' && byId.has(a.targetId) && a.targetId !== carrierId) {
      const before = transfers.length
      planPitch(carrierId, a.targetId, has + MIN_QB_HOLD)
      const tr = transfers[transfers.length - 1]
      return transfers.length > before ? { carrierId: a.targetId, time: tr.time + tr.dur } : null
    }
    if (a.kind === 'pass' && byId.has(a.targetId) && a.targetId !== carrierId) {
      // Throw From Here is a QB-path intent; it only applies when the QB is the passer.
      planPass(carrierId, a.targetId, a.catchPoint, carrierId === qb.id ? a.releasePoint : undefined, has + 0.1)
      const tr = transfers[transfers.length - 1]
      return { carrierId: a.targetId, time: tr.time + tr.dur }
    }
    if (a.kind === 'play-action' && byId.has(a.fakeId) && byId.has(a.targetId)) {
      const mesh = findMesh(carrierId, a.fakeId, has + MIN_QB_HOLD)
      transfers.push({ kind: 'fake', time: mesh.time, dur: FAKE_DUR, fromId: carrierId, toId: a.fakeId })
      // The fake must finish before the throw, wherever the throw point is.
      planPass(carrierId, a.targetId, a.catchPoint, carrierId === qb.id ? a.releasePoint : undefined, mesh.time + FAKE_DUR + 0.05)
      const tr = transfers[transfers.length - 1]
      return { carrierId: a.targetId, time: tr.time + tr.dur }
    }
    return null
  }

  if (action) {
    // The QB has it from the moment the snap arrives.
    const after = run(action, qb.id, snapArrive)
    chain = after
    if (then) {
      if (!after) warn(`Second action skipped — the first exchange never happened.`)
      else if (after.carrierId === (then.kind === 'handoff' ? then.carrierId : 'targetId' in then ? then.targetId : '')) warn(`Second action skipped — ${byId.get(after.carrierId)!.label} already has it.`)
      else run(then, after.carrierId, after.time)
    }
  }

  const last = transfers[transfers.length - 1]
  let end = last ? last.time + last.dur : snapArrive
  for (const s of sched.values()) end = Math.max(end, s.end)

  const at = (t: number): BallFrame => {
    if (t < snapAt) return { pos: spot, phase: 'spot', carrierId: null, lift: 0 }
    if (t < snapArrive) return { pos: lerp(spot, held(qb.id, t), (t - snapAt) / snapDur), phase: 'snap', carrierId: null, lift: 0 }
    let carrier = qb.id
    for (const tr of transfers) {
      if (t < tr.time) break
      if (t < tr.time + tr.dur) {
        const u = (t - tr.time) / tr.dur
        if (tr.kind === 'flight') return { pos: lerp(tr.from!, tr.to!, u), phase: 'flight', carrierId: null, lift: Math.sin(Math.PI * u) }
        if (tr.kind === 'pitch') return { pos: lerp(tr.from!, tr.to!, u), phase: 'pitch', carrierId: null, lift: 0.35 * Math.sin(Math.PI * u) }
        if (tr.kind === 'fake') {
          // Ball reaches toward the back and comes back: reads as a fake.
          return { pos: lerp(held(tr.fromId, t), held(tr.toId, t), 0.7 * Math.sin(Math.PI * u)), phase: 'fake', carrierId: tr.fromId, lift: 0 }
        }
        return { pos: lerp(held(tr.fromId, t), held(tr.toId, t), u), phase: 'handoff', carrierId: null, lift: 0 }
      }
      if (tr.kind !== 'fake') carrier = tr.toId
    }
    return { pos: held(carrier, t), phase: 'carry', carrierId: carrier, lift: 0 }
  }

  return { at, schedule: sched, end, releasePoint, catchPoint, requestedCatch, catchAdjusted, qbHold, qbEarly, releaseIsManual, passer, chain, warning }
}
