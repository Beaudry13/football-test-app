// Where a player's BODY is turned and where he is LOOKING - two different
// things, and both different from where he is GOING.
//
//   MOVEMENT  comes from the schedule (posAt). Not decided here.
//   BODY      how he is physically turned: square in a backpedal or shuffle,
//             opened up once he has committed to running.
//   LOOK      what he is attending to: the ball for a defender, the route
//             for a receiver until the ball is thrown to him. Constrained to
//             a head's range either side of the body.
//
// Both are derived from a few football rules, smoothed, and frozen into a
// per-player table so scrubbing to any instant gives the same answer as
// playing through it. Deliberately small and deterministic. A coach-authored
// override ("face here" / "look here") belongs at the top of `bodyTarget` /
// `lookTarget`: consult it first, fall through to the rules.

import type { Player } from './formation'
import type { Pt } from './geometry'
import type { BallFrame } from './ball'
import { posAt, type ScheduleMap } from './timeline'

/** Table resolution. Fine enough that interpolation is invisible. */
const STEP = 1 / 30
/** Body: how fast it comes round, and how eagerly (1/s). */
const BODY_TURN = (180 * Math.PI) / 180
const BODY_EASE = 5
/** Head: quicker than the body, but still a teaching camera, not a GoPro. */
const LOOK_TURN = (200 * Math.PI) / 180
const LOOK_EASE = 6
/** How far the head can turn either side of the body. */
export const HEAD_LIMIT = (80 * Math.PI) / 180
/** A look target held beyond the head limit this long makes the body turn. */
const BODY_FOLLOWS_AFTER = 0.3
/** Movement slower than this is standing still. */
const STILL = 0.5
/** Fast movers commit to running after this long going sideways / backward. */
const COMMIT_LATERAL = 0.7
const COMMIT_BACK = 0.5
const FAST = 7
/** How far a shuffling body opens toward where it is going. */
const PEEK = (25 * Math.PI) / 180

const angleOf = (v: Pt) => Math.atan2(v.y, v.x)
const unit = (a: number): Pt => ({ x: Math.cos(a), y: Math.sin(a) })
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const toward = (from: Pt, to: Pt, fallback: number) =>
  Math.hypot(to.x - from.x, to.y - from.y) < 0.5 ? fallback : Math.atan2(to.y - from.y, to.x - from.x)

/** The side of the field this player's football is on. */
export const forwardOf = (p: Player): Pt => (p.side === 'defense' ? { x: 0, y: -1 } : { x: 0, y: 1 })

/** Who this player is engaged with, from when, and (if someone releases) until when. */
export interface EngagedWith {
  partnerId: string
  time: number
  until?: number
}

interface Situation {
  p: Player
  at: Pt
  /** Direction to an engaged partner, once engaged; null otherwise. */
  partner: number | null
  /** Football forward: downfield for offense, toward the ball for defense. */
  fwd: number
  move: Pt
  speed: number
  movingFor: number
  preSnap: boolean
  ball: BallFrame
  targetIds: string[]
}

interface BodyDecision {
  angle: number
  /** The body is following movement; vision has to live with it. */
  running: boolean
}

function bodyTarget(s: Situation, prev: number): BodyDecision {
  const { fwd, speed, move, movingFor, preSnap, partner } = s
  if (preSnap) return { angle: fwd, running: false }
  if (partner !== null) return { angle: partner, running: false } // engaged: square up on him
  if (speed < STILL) return { angle: prev, running: false } // standing: stay as you were
  const m = angleOf(move)
  const dot = Math.cos(m - fwd)
  if (dot >= 0.3) return { angle: m, running: true } // going forward: body follows
  // Backing up or sliding sideways keeps the body square (a pedal, a
  // shuffle, a QB drop) until a fast mover has been at it long enough to
  // have opened up and run.
  const committed = speed >= FAST && movingFor > (dot <= -0.3 ? COMMIT_BACK : COMMIT_LATERAL)
  if (committed) return { angle: m, running: true }
  if (dot <= -0.3) return { angle: fwd, running: false }
  const side = Math.sign(wrap(m - fwd))
  return { angle: fwd + side * PEEK, running: false }
}

function lookTarget(s: Situation, body: number): number {
  const { p, at, fwd, ball, targetIds, move, speed, preSnap, partner } = s
  if (partner !== null) return partner // engaged: eyes on the man in front of you
  const ballDir = toward(at, ball.pos, fwd)
  if (p.side === 'defense') return ballDir // eyes on the football, always
  if (preSnap) return fwd
  if (ball.carrierId === p.id) return speed >= STILL ? angleOf(move) : fwd
  // A receiver the ball is thrown to finds it in the air. Nobody else on
  // offense has ball radar: they look where they are working.
  if ((ball.phase === 'flight' || ball.phase === 'pitch') && targetIds.includes(p.id)) return ballDir
  if (p.label === 'QB') return ball.phase === 'flight' || ball.phase === 'pitch' ? ballDir : fwd
  return speed >= STILL ? angleOf(move) : body
}

/** Ease an angle toward a target, capped so nothing ever whips round. */
function ease(current: number, target: number, rate: number, maxTurn: number): number {
  const diff = wrap(target - current)
  const step = Math.sign(diff) * Math.min(Math.abs(diff) * (1 - Math.exp(-rate * STEP)), maxTurn * STEP)
  return wrap(current + step)
}

export interface OrientationTable {
  body: Float32Array
  look: Float32Array
}

/** Simulate one player's body and look from t = 0 through `end`. */
function buildTable(
  p: Player,
  schedule: ScheduleMap,
  snapAt: number,
  end: number,
  ballAt: (t: number) => BallFrame,
  targetIds: string[],
  engaged: EngagedWith | undefined,
  byId: Map<string, Player>,
): OrientationTable {
  const n = Math.max(2, Math.ceil(end / STEP) + 2)
  const body = new Float32Array(n)
  const look = new Float32Array(n)
  let bodyA = angleOf(forwardOf(p))
  let lookA = bodyA
  let movingFor = 0
  let lastMove = 0
  let overLimitFor = 0
  for (let i = 0; i < n; i++) {
    const t = i * STEP
    const at = posAt(schedule, p, t)
    const next = posAt(schedule, p, t + STEP)
    const vx = (next.x - at.x) / STEP
    const vy = (next.y - at.y) / STEP
    const speed = Math.hypot(vx, vy)
    const move = speed > 0 ? { x: vx / speed, y: vy / speed } : { x: 0, y: 0 }
    if (speed >= STILL) {
      const m = angleOf(move)
      movingFor = i > 0 && Math.abs(wrap(m - lastMove)) < 0.6 ? movingFor + STEP : 0
      lastMove = m
    } else movingFor = 0
    const ball = ballAt(t)
    const fwd = p.side === 'defense' ? toward(at, ball.pos, angleOf(forwardOf(p))) : angleOf(forwardOf(p))
    let partner: number | null = null
    if (engaged && t >= engaged.time && (engaged.until === undefined || t < engaged.until)) {
      const other = byId.get(engaged.partnerId)
      if (other) partner = toward(at, posAt(schedule, other, t), fwd)
    }
    const s: Situation = { p, at, partner, fwd, move, speed, movingFor, preSnap: t < snapAt, ball, targetIds }

    // Body first. If he is not running and what he wants to see has been
    // outside his head's range for a moment, the body comes round to it.
    const want = lookTarget(s, bodyA)
    let target = bodyTarget(s, bodyA)
    overLimitFor = Math.abs(wrap(want - bodyA)) > HEAD_LIMIT ? overLimitFor + STEP : 0
    if (!target.running && overLimitFor > BODY_FOLLOWS_AFTER) target = { angle: want, running: false }
    bodyA = ease(bodyA, target.angle, BODY_EASE, BODY_TURN)

    // Then the head: eased toward what he wants, then held within range.
    lookA = ease(lookA, want, LOOK_EASE, LOOK_TURN)
    const rel = wrap(lookA - bodyA)
    if (Math.abs(rel) > HEAD_LIMIT) lookA = wrap(bodyA + Math.sign(rel) * HEAD_LIMIT)

    body[i] = bodyA
    look[i] = lookA
  }
  return { body, look }
}

export type OrientationMap = Map<string, OrientationTable>

export function buildOrientation(
  players: Player[],
  schedule: ScheduleMap,
  snapAt: number,
  end: number,
  ballAt: (t: number) => BallFrame,
  targetIds: string[],
  engagements: Map<string, EngagedWith> = new Map(),
): OrientationMap {
  const byId = new Map(players.map((p) => [p.id, p]))
  return new Map(players.map((p) => [p.id, buildTable(p, schedule, snapAt, end, ballAt, targetIds, engagements.get(p.id), byId)]))
}

function sample(arr: Float32Array, t: number): number {
  const f = Math.max(0, t / STEP)
  const i = Math.min(arr.length - 2, Math.floor(f))
  const u = Math.min(1, f - i)
  return arr[i] + wrap(arr[i + 1] - arr[i]) * u
}

export interface Orientation {
  body: Pt
  look: Pt
}

/** Unit body and look vectors for a player at playback time t. */
export function orientationAt(tables: OrientationMap, p: Player, t: number): Orientation {
  const tb = tables.get(p.id)
  if (!tb) {
    const f = forwardOf(p)
    return { body: f, look: f }
  }
  return { body: unit(sample(tb.body, t)), look: unit(sample(tb.look, t)) }
}
