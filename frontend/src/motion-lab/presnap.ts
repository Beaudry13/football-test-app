// THE PRE-SNAP MOMENT - "I am in the play", not "I am looking at a screenshot".
//
// A Rep decision (or a quiz question) made from a Motion Lab play with authored
// pre-snap motion carries that play's PRE-SNAP part: each man's alignment,
// label, side, speed and authored motion, and the situation. The player's
// screen runs it on Motion Lab's own timeline (engine/timeline: motion
// finishes AT the snap) and freezes at the DECISION MOMENT the coach chose:
//
//   before   the alignment, before anyone moves
//   mid      halfway through the authored motion
//   snap     the snap (the default)
//   after    a beat after the snap - for which the play's own engine positions
//            for just that beat travel with it, nothing past it
//
// Nothing is invented: no timing, movement or stance the coach did not author.
// And nothing that would answer the question travels: no post-snap route (only
// the beat after the snap, when chosen), no ball, no blocks.

import { SPEED_YPS, type Player, type SpeedTier, type Timing } from './engine/formation'
import type { Pt } from './engine/geometry'
import { newPlay, type Play, type Situation } from './engine/play'
import { buildSchedule, posAt, type ScheduleMap } from './engine/timeline'

export type DecisionMoment = 'before' | 'mid' | 'snap' | 'after'

export const MOMENT_LABEL: Record<DecisionMoment, string> = {
  before: 'Before motion',
  mid: 'Mid-motion',
  snap: 'Snap',
  after: 'After the snap',
}

/** How long "a beat after the snap" is, in playback seconds. */
export const AFTER_SNAP_BEAT = 0.8
const AFTER_STEP = 0.1

export interface PresnapMan {
  id: string
  side: 'offense' | 'defense'
  label: string
  x: number
  y: number
  speed: SpeedTier
  timing: Timing
  /** Authored pre-snap motion. */
  motion?: Pt[]
  /** A legacy pre-snap path (timing 'pre-snap') - motion by another name. */
  path?: Pt[]
}

export interface PresnapClip {
  v: 1
  situation: Situation
  players: PresnapMan[]
  /** The man the decision is about, ringed - he moves with his ring. */
  highlight: string | null
  /** When the player decides. Absent = the snap. */
  freeze?: DecisionMoment
  /** For 'after': where each man who moves after the snap is, every 0.1 s
   *  through the beat - Motion Lab's own engine positions, cut at the beat. */
  after?: { step: number; duration: number; samples: { id: string; pts: Pt[] }[] }
}

const moves = (p: Pick<Player, 'motion' | 'path' | 'timing'>) =>
  (p.motion?.length ?? 0) >= 2 || (p.timing === 'pre-snap' && p.path.length >= 2)

/** Whether anyone in the play moves before the snap. */
export function hasPresnapMotion(play: Play): boolean {
  return play.players.some(moves)
}

/** Whether anyone moves right after the snap (so "After the snap" means something). */
export function hasPostSnapMovement(play: Play): boolean {
  return play.players.some((p) => p.timing !== 'pre-snap' && p.path.length >= 2)
}

/** The decision moments this play can offer, snap first among the defaults. */
export function momentsFor(play: Play): DecisionMoment[] {
  if (!hasPresnapMotion(play)) return []
  return hasPostSnapMovement(play) ? ['before', 'mid', 'snap', 'after'] : ['before', 'mid', 'snap']
}

/** The play's pre-snap moment, or null when nobody moves before the snap. */
export function presnapOf(play: Play, highlight: string | null, freeze: DecisionMoment = 'snap'): PresnapClip | null {
  if (!hasPresnapMotion(play)) return null
  const clip: PresnapClip = {
    v: 1,
    situation: play.situation,
    highlight,
    players: play.players.map((p) => ({
      id: p.id,
      side: p.side,
      label: p.label,
      x: p.x,
      y: p.y,
      speed: p.speed,
      timing: p.timing,
      ...((p.motion?.length ?? 0) >= 2 ? { motion: p.motion } : {}),
      ...(p.timing === 'pre-snap' && p.path.length >= 2 ? { path: p.path } : {}),
    })),
  }
  if (freeze !== 'snap') clip.freeze = freeze
  if (freeze === 'after') clip.after = afterBeat(play)
  return clip
}

/** The beat after the snap, sampled from the FULL play's own schedule - and cut there. */
function afterBeat(play: Play): NonNullable<PresnapClip['after']> {
  const { schedule, snapAt } = buildSchedule(play.players)
  const samples: { id: string; pts: Pt[] }[] = []
  for (const p of play.players) {
    const pts: Pt[] = []
    for (let t = 0; t <= AFTER_SNAP_BEAT + 1e-6; t += AFTER_STEP) {
      const at = posAt(schedule, p, snapAt + t)
      pts.push({ x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 })
    }
    if (pts.some((q) => Math.hypot(q.x - pts[0].x, q.y - pts[0].y) > 0.05)) samples.push({ id: p.id, pts })
  }
  return { step: AFTER_STEP, duration: AFTER_SNAP_BEAT, samples }
}

/** The clip's men as engine players: pre-snap motion only, nothing after the snap. */
function clipPlayers(clip: PresnapClip): Player[] {
  return clip.players.map((m) => ({
    id: m.id,
    side: m.side,
    label: m.label,
    x: m.x,
    y: m.y,
    path: m.timing === 'pre-snap' && m.path ? m.path : [],
    timing: m.timing === 'pre-snap' ? 'pre-snap' : 'on-snap',
    delay: 0,
    speed: m.speed in SPEED_YPS ? m.speed : 'normal',
    ...(m.motion ? { motion: m.motion } : {}),
  }))
}

export interface PresnapTimeline {
  players: Player[]
  schedule: ScheduleMap
  /** Playback time to start from: just before the first man moves. */
  from: number
  /** The first man's first step. */
  firstMove: number
  /** The snap. */
  snapAt: number
  /** The decision moment: where the picture freezes. */
  freezeAt: number
  moment: DecisionMoment
}

export function presnapTimeline(clip: PresnapClip): PresnapTimeline {
  const players = clipPlayers(clip)
  const { schedule, snapAt } = buildSchedule(players)
  const firstMove = Math.min(snapAt, ...[...schedule.values()].map((s) => s.start))
  const moment = clip.freeze ?? 'snap'
  const freezeAt =
    moment === 'before'
      ? firstMove
      : moment === 'mid'
        ? (firstMove + snapAt) / 2
        : moment === 'after' && clip.after
          ? snapAt + clip.after.duration
          : snapAt
  return { players, schedule, snapAt, firstMove, freezeAt, moment, from: Math.max(0, firstMove - 0.5) }
}

/** Where one man is in the beat after the snap (linear between the engine's samples). */
function afterSpot(clip: PresnapClip, id: string, dt: number): Pt | null {
  const sample = clip.after?.samples.find((s) => s.id === id)
  if (!sample || sample.pts.length === 0) return null
  const f = Math.max(0, dt) / clip.after!.step
  const i = Math.min(sample.pts.length - 1, Math.floor(f))
  const j = Math.min(sample.pts.length - 1, i + 1)
  const u = Math.min(1, f - i)
  return { x: sample.pts[i].x + (sample.pts[j].x - sample.pts[i].x) * u, y: sample.pts[i].y + (sample.pts[j].y - sample.pts[i].y) * u }
}

/** Where a man is at playback time t: Motion Lab's timeline up to the snap, the engine's own beat after it. */
function spotAt(clip: PresnapClip, line: PresnapTimeline, p: Player, t: number): Pt {
  if (t > line.snapAt) {
    const beat = afterSpot(clip, p.id, t - line.snapAt)
    if (beat) return beat
  }
  return posAt(line.schedule, p, Math.min(t, line.snapAt))
}

/** The play as drawn at playback time t: every man where the timeline puts him. */
export function presnapFrame(clip: PresnapClip, line: PresnapTimeline, t: number): Play {
  const base = newPlay('Pre-snap')
  return {
    ...base,
    situation: clip.situation,
    players: line.players.map((p) => {
      const at = spotAt(clip, line, p, Math.min(t, line.freezeAt))
      // Before motion, the picture is the alignment alone - no trail giving it away.
      return { ...p, x: at.x, y: at.y, path: [], ...(line.moment === 'before' ? { motion: undefined } : {}) }
    }),
  }
}

/** Where every man stands at the decision moment. */
export function freezeSpots(clip: PresnapClip): Map<string, Pt> {
  const line = presnapTimeline(clip)
  return new Map(line.players.map((p) => [p.id, spotAt(clip, line, p, line.freezeAt)]))
}

/** Where every man stands at the snap. */
export function snapSpots(clip: PresnapClip): Map<string, Pt> {
  return freezeSpots({ ...clip, freeze: 'snap', after: undefined })
}
