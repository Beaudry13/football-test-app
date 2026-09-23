// WHICH ENGINE THE CHARACTERIZATION TESTS CHECK: PEIRA's copy.
//
// Step 1 of P1 pointed this at the preserved prototype, proving the goldens
// describe the validated behaviour before anything moved. It now points at
// frontend/src/motion-lab/engine - and the same goldens must still pass. That
// one-line switch is the whole claim of the integration.
import { buildSchedule, posAt, resolveEnd } from '../engine/timeline'
import { applyEngagements } from '../engine/interactions'
import { deriveBall, ballTargetOf } from '../engine/ball'
import { buildOrientation, orientationAt } from '../engine/orientation'
import { sanitizePlay, sanitizeLook, newPlay, SCHEMA_VERSION } from '../engine/play'
import { initialPlayers } from '../engine/formation'
import type { EngineApi } from './capture'

export const engineUnderTest: EngineApi = {
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

export const modelUnderTest = { sanitizePlay, sanitizeLook, newPlay, initialPlayers, SCHEMA_VERSION }
