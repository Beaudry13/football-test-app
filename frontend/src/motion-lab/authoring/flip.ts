// FLIP THE PLAY - the oldest shortcut in a playbook: Trips Right becomes Trips
// Left, every route and motion with it.
//
// Everything is mirrored across the middle of the field: the men, their
// routes and motion, where the ball is caught or released, where blocks meet,
// and the hash - a play on the left hash flips to the right hash, so what was
// into the boundary is still into the boundary. Two things are deliberately NOT
// mirrored, because a coach flipping a play does not mean them:
//   - the offensive line keeps its names on its sides: whoever lands on the
//     left tackle's spot IS the left tackle (LT <-> RT, LG <-> RG swap labels);
//   - a three-point stance changes hands with the side it is on
//     (..._3_POINT_LEFT <-> ..._3_POINT_RIGHT).

import type { BallAction } from '../engine/ball'
import { clampToField, FIELD_WIDTH } from '../engine/field'
import type { Player, StanceId } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import type { Engagement } from '../engine/interactions'
import type { Situation } from '../engine/play'

export interface Flippable {
  players: Player[]
  ball: BallAction | null
  ballThen: BallAction | null
  engagements: Engagement[]
  situation: Situation
}

const LINE_SWAP: Record<string, string> = { LT: 'RT', RT: 'LT', LG: 'RG', RG: 'LG' }
const STANCE_SWAP: Partial<Record<StanceId, StanceId>> = {
  OL_3_POINT_LEFT: 'OL_3_POINT_RIGHT',
  OL_3_POINT_RIGHT: 'OL_3_POINT_LEFT',
  DL_3_POINT_LEFT: 'DL_3_POINT_RIGHT',
  DL_3_POINT_RIGHT: 'DL_3_POINT_LEFT',
}

export function flipPlay(play: Flippable): Flippable {
  const m = (p: Pt): Pt => clampToField({ x: FIELD_WIDTH - p.x, y: p.y })
  const ball = (b: BallAction | null): BallAction | null => {
    if (!b || (b.kind !== 'pass' && b.kind !== 'play-action')) return b
    return { ...b, catchPoint: m(b.catchPoint), ...(b.releasePoint ? { releasePoint: m(b.releasePoint) } : {}) }
  }
  return {
    players: play.players.map((p) => {
      const at = m(p)
      return {
        ...p,
        x: at.x,
        y: at.y,
        label: p.side === 'offense' ? (LINE_SWAP[p.label.toUpperCase()] ?? p.label) : p.label,
        path: p.path.map(m),
        ...(p.motion ? { motion: p.motion.map(m) } : {}),
        ...(p.presnapStance ? { presnapStance: STANCE_SWAP[p.presnapStance] ?? p.presnapStance } : {}),
      }
    }),
    ball: ball(play.ball),
    ballThen: ball(play.ballThen),
    engagements: play.engagements.map((e) => ({ ...e, point: m(e.point) })),
    situation: {
      ...play.situation,
      hash: play.situation.hash === 'left' ? 'right' : play.situation.hash === 'right' ? 'left' : play.situation.hash,
    },
  }
}
