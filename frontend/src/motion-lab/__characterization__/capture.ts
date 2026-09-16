// MOTION LAB CHARACTERIZATION - what a play DOES, recorded as numbers.
//
// P1 moves the validated prototype into PEIRA. The promise is that the
// football does not change: the same intent must produce the same schedule,
// the same ball, the same engagements and the same facing at every instant.
// This file turns one play into a plain, rounded record of exactly that, so
// "before integration" and "after integration" can be compared as data.
//
// The pipeline below is the prototype's own derivation order, copied from its
// App.tsx ("derived playback data" and the orientation memo) rather than
// paraphrased. If that order changes, the record changes - which is the point.
//
// Nothing here is a UI pixel. Nothing here is stored by the product.

import type * as TimelineModule from '../engine/timeline'
import type * as InteractionsModule from '../engine/interactions'
import type * as BallModule from '../engine/ball'
import type * as OrientationModule from '../engine/orientation'
import type * as PlayModule from '../engine/play'
import type { Play } from '../engine/play'
import type { Pt } from '../engine/geometry'

/**
 * The engine functions a capture needs. Passed in, never imported, so the
 * same capture can run against the preserved prototype's files and against
 * PEIRA's copy and the two records can be compared field for field.
 */
export interface EngineApi {
  buildSchedule: typeof TimelineModule.buildSchedule
  posAt: typeof TimelineModule.posAt
  resolveEnd: typeof TimelineModule.resolveEnd
  applyEngagements: typeof InteractionsModule.applyEngagements
  deriveBall: typeof BallModule.deriveBall
  ballTargetOf: typeof BallModule.ballTargetOf
  buildOrientation: typeof OrientationModule.buildOrientation
  orientationAt: typeof OrientationModule.orientationAt
  sanitizePlay: typeof PlayModule.sanitizePlay
}

/** The prototype's end-of-play tail (App.tsx `TAIL`). */
const TAIL = 0.4
/** Regular sampling interval, seconds. Event times are sampled as well. */
const STEP = 0.2

/** 1e-6 in yards, seconds and unit-vector components; -0 folded into 0. */
const r = (v: number): number => {
  const x = Math.round(v * 1e6) / 1e6
  return Object.is(x, -0) ? 0 : x
}
const rp = (p: Pt | null | undefined) => (p ? { x: r(p.x), y: r(p.y) } : null)

export interface PlayRecord {
  snapAt: number
  playersEnd: number
  duration: number
  schedule: Record<string, { start: number; end: number; length: number; drawnLength: number; speed: number; hold: { from: number; until: number } | null; pts: { x: number; y: number }[]; endBehavior: string }>
  drawnSchedule: Record<string, { start: number; end: number; length: number }>
  engagements: { id: string; a: string; b: string; valid: boolean; time: number | null; until: number | null; warning: string | null }[]
  ball: {
    end: number
    releasePoint: { x: number; y: number } | null
    catchPoint: { x: number; y: number } | null
    requestedCatch: { x: number; y: number } | null
    catchAdjusted: boolean
    qbHold: number
    qbEarly: number
    releaseIsManual: boolean
    passer: string
    chain: { carrierId: string; time: number } | null
    warning: string | null
  }
  samples: {
    t: number
    ball: { x: number; y: number; phase: string; carrierId: string | null; lift: number }
    players: Record<string, { x: number; y: number; body: [number, number]; look: [number, number] }>
  }[]
}

/** Derive a play exactly the way the prototype editor does. */
export function derive(api: EngineApi, play: Play) {
  const { players, engagements, ball, ballThen } = play
  const built = api.buildSchedule(players)
  const eng = api.applyEngagements(built.schedule, players, engagements, built.snapAt)
  const drawnSchedule = eng.schedule
  const ballTimeline = api.deriveBall(players, drawnSchedule, built.snapAt, ball, ballThen)
  const schedule = ballTimeline.schedule
  let playersEnd = built.snapAt
  for (const s of drawnSchedule.values()) playersEnd = Math.max(playersEnd, s.end)
  for (const d of eng.derived) if (d.time !== null) playersEnd = Math.max(playersEnd, d.time + 0.6)
  const hasAnything = schedule.size > 0 || ball !== null
  const duration = hasAnything ? Math.max(playersEnd, ballTimeline.end) + TAIL : 0

  const pairs = new Map<string, { partnerId: string; time: number; until?: number }>()
  for (const d of eng.derived) {
    if (!d.valid || d.time === null) continue
    pairs.set(d.a, { partnerId: d.b, time: d.time, until: d.until ?? undefined })
    pairs.set(d.b, { partnerId: d.a, time: d.time, until: d.until ?? undefined })
  }
  const orientation = api.buildOrientation(
    players,
    schedule,
    built.snapAt,
    duration + 1,
    ballTimeline.at,
    [api.ballTargetOf(ball), api.ballTargetOf(ballThen)].filter((x): x is string => !!x),
    pairs,
  )
  return { built, eng, drawnSchedule, ballTimeline, schedule, playersEnd, duration, orientation }
}

/** Every time worth looking at: a regular grid plus each derived event. */
function sampleTimes(d: ReturnType<typeof derive>): number[] {
  const times = new Set<number>([0, r(d.built.snapAt), r(d.duration)])
  for (let t = 0; t < d.duration; t += STEP) times.add(r(t))
  if (d.ballTimeline.chain) times.add(r(d.ballTimeline.chain.time))
  times.add(r(d.ballTimeline.end))
  for (const e of d.eng.derived) {
    if (e.time !== null) times.add(r(e.time))
    if (e.until !== null) times.add(r(e.until))
  }
  return [...times].filter((t) => t >= 0).sort((a, b) => a - b)
}

export function capturePlay(api: EngineApi, play: Play): PlayRecord {
  const d = derive(api, play)
  const byId = new Map(play.players.map((p) => [p.id, p]))
  const schedule: PlayRecord['schedule'] = {}
  for (const [id, s] of d.schedule) {
    schedule[id] = {
      start: r(s.start),
      end: r(s.end),
      length: r(s.length),
      drawnLength: r(s.drawnLength),
      speed: r(s.speed),
      hold: s.hold ? { from: r(s.hold.from), until: r(s.hold.until) } : null,
      pts: s.pts.map((p) => rp(p)!),
      endBehavior: api.resolveEnd(byId.get(id)!, s),
    }
  }
  const drawnSchedule: PlayRecord['drawnSchedule'] = {}
  for (const [id, s] of d.drawnSchedule) drawnSchedule[id] = { start: r(s.start), end: r(s.end), length: r(s.length) }

  const b = d.ballTimeline
  return {
    snapAt: r(d.built.snapAt),
    playersEnd: r(d.playersEnd),
    duration: r(d.duration),
    schedule,
    drawnSchedule,
    engagements: d.eng.derived.map((e) => ({
      id: e.id,
      a: e.a,
      b: e.b,
      valid: e.valid,
      time: e.time === null ? null : r(e.time),
      until: e.until === null ? null : r(e.until),
      warning: e.warning,
    })),
    ball: {
      end: r(b.end),
      releasePoint: rp(b.releasePoint),
      catchPoint: rp(b.catchPoint),
      requestedCatch: rp(b.requestedCatch),
      catchAdjusted: b.catchAdjusted,
      qbHold: r(b.qbHold),
      qbEarly: r(b.qbEarly),
      releaseIsManual: b.releaseIsManual,
      passer: b.passer,
      chain: b.chain ? { carrierId: b.chain.carrierId, time: r(b.chain.time) } : null,
      warning: b.warning,
    },
    samples: sampleTimes(d).map((t) => {
      const frame = b.at(t)
      const players: PlayRecord['samples'][number]['players'] = {}
      for (const p of play.players) {
        const pos = api.posAt(d.schedule, p, t)
        const o = api.orientationAt(d.orientation, p, t)
        players[p.id] = { x: r(pos.x), y: r(pos.y), body: [r(o.body.x), r(o.body.y)], look: [r(o.look.x), r(o.look.y)] }
      }
      return { t, ball: { x: r(frame.pos.x), y: r(frame.pos.y), phase: frame.phase, carrierId: frame.carrierId, lift: r(frame.lift) }, players }
    }),
  }
}
