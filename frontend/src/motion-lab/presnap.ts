// THE PRE-SNAP MOMENT - "I am in the play", not "I am looking at a screenshot".
//
// A Rep decision made from a Motion Lab play with authored pre-snap motion
// carries that play's PRE-SNAP part: each man's alignment, label, side, speed
// and authored motion, and the situation. The player's screen runs it on
// Motion Lab's own timeline (engine/timeline: motion finishes AT the snap) and
// freezes at the snap - the decision moment - before asking the question.
//
// Nothing is invented: no timing, movement or stance that the coach did not
// author. And nothing that would answer the question travels: no post-snap
// route, no ball, no blocks.

import { SPEED_YPS, type Player, type SpeedTier, type Timing } from './engine/formation'
import type { Pt } from './engine/geometry'
import { newPlay, type Play, type Situation } from './engine/play'
import { buildSchedule, posAt, type ScheduleMap } from './engine/timeline'

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
}

const moves = (p: Pick<Player, 'motion' | 'path' | 'timing'>) =>
  (p.motion?.length ?? 0) >= 2 || (p.timing === 'pre-snap' && p.path.length >= 2)

/** Whether anyone in the play moves before the snap. */
export function hasPresnapMotion(play: Play): boolean {
  return play.players.some(moves)
}

/** The play's pre-snap moment, or null when nobody moves before the snap. */
export function presnapOf(play: Play, highlight: string | null): PresnapClip | null {
  if (!hasPresnapMotion(play)) return null
  return {
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
  /** The snap - the decision moment. */
  snapAt: number
}

export function presnapTimeline(clip: PresnapClip): PresnapTimeline {
  const players = clipPlayers(clip)
  const { schedule, snapAt } = buildSchedule(players)
  const firstMove = Math.min(snapAt, ...[...schedule.values()].map((s) => s.start))
  return { players, schedule, snapAt, from: Math.max(0, firstMove - 0.5) }
}

/** The play as drawn at playback time t: every man where the timeline puts him. */
export function presnapFrame(clip: PresnapClip, line: PresnapTimeline, t: number): Play {
  const base = newPlay('Pre-snap')
  return {
    ...base,
    situation: clip.situation,
    players: line.players.map((p) => {
      const at = posAt(line.schedule, p, Math.min(t, line.snapAt))
      return { ...p, x: at.x, y: at.y, path: [] }
    }),
  }
}

/** Where every man stands at the snap. */
export function snapSpots(clip: PresnapClip): Map<string, Pt> {
  const line = presnapTimeline(clip)
  return new Map(line.players.map((p) => [p.id, posAt(line.schedule, p, line.snapAt)]))
}
