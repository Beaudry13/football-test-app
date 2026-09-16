// THE PRESERVED PROTOTYPE'S ENGINE, imported from where P0 committed it
// (preserve/motion-lab-prototype @ 9282b92, prototypes/motion-lab/src).
//
// This is the reference. Golden records are only ever written from THIS
// engine, so re-generating them can never quietly bless a change made to
// PEIRA's copy. The files under prototypes/ are not part of the product and
// are never imported outside the characterization tests.

import { buildSchedule, posAt, resolveEnd } from '../../../../prototypes/motion-lab/src/timeline'
import { applyEngagements } from '../../../../prototypes/motion-lab/src/interactions'
import { deriveBall, ballTargetOf } from '../../../../prototypes/motion-lab/src/ball'
import { buildOrientation, orientationAt } from '../../../../prototypes/motion-lab/src/orientation'
import { sanitizePlay, sanitizeLook, newPlay } from '../../../../prototypes/motion-lab/src/play'
import { initialPlayers } from '../../../../prototypes/motion-lab/src/formation'
import type { EngineApi } from './capture'

export const prototypeEngine: EngineApi = {
  buildSchedule,
  posAt,
  resolveEnd,
  applyEngagements,
  deriveBall,
  ballTargetOf,
  buildOrientation,
  orientationAt,
  sanitizePlay,
}

export const prototypeModel = { sanitizePlay, sanitizeLook, newPlay, initialPlayers }
