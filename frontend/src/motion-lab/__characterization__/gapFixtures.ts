// THREE SMALL PLAYS FOR THE BEHAVIOURS THE PRESERVED DATA DOES NOT EXERCISE.
//
// P0 mapped every engine behaviour to the plays exported from the browser
// pane and found six with no coverage: pre-snap motion, pitch, engage ->
// release, an explicit Settle, Throw From Here and delayed timing. Each play
// below exercises two of them, on the prototype's own default 11 v 11, so a
// failure still points at one idea.
//
// These are COACH INTENT only - alignments, anchors, timing, ball action,
// engagements - exactly what the editor would save. They are written as code
// so a reviewer can read what each one asks for; the committed JSON under
// fixtures/ is what the tests load. Expected outputs are never written by
// hand: they come from running the preserved prototype engine.

import type { Play } from '../engine/play'
import type { Player } from '../engine/formation'

type Model = {
  newPlay: (name?: string, players?: Player[]) => Play
  initialPlayers: () => Player[]
}

// Fixed timestamps so the committed JSON is stable byte for byte.
const STAMP = Date.UTC(2026, 8, 16, 12, 0, 0)

function base(model: Model, id: string, name: string, edit: (players: Player[]) => void): Play {
  const players = model.initialPlayers()
  edit(players)
  const play = model.newPlay(name, players)
  // newPlay strips paths from the look it is given (a new play keeps the
  // alignment, never the assignments), so paths go back on afterwards.
  const byId = new Map(players.map((p) => [p.id, p]))
  play.players = play.players.map((p) => ({ ...p, ...byId.get(p.id)! }))
  return { ...play, id, createdAt: STAMP, updatedAt: STAMP }
}

const set = (players: Player[], id: string, patch: Partial<Player>) => {
  const i = players.findIndex((p) => p.id === id)
  players[i] = { ...players[i], ...patch }
}

// Default ids (formation.ts): O2 C, O5 Y, O6 QB (26.665, -2.4), O7 RB
// (24.665, -5.5), O8 X (8, -0.8), O10 Z (46, -1.6); D3 DE (31.265, 1.2).

export function buildGapFixtures(model: Model): Play[] {
  /** Jet motion by Z before the snap, then QB pitch to the RB running wide. */
  const motionPitch = base(model, 'fx_motion_pitch', 'Fixture — Z jet motion, toss to RB', (ps) => {
    set(ps, 'O10', { path: [{ x: 46, y: -1.6 }, { x: 38, y: -2.6 }, { x: 31, y: -3.2 }], timing: 'pre-snap', speed: 'fast' })
    set(ps, 'O7', { path: [{ x: 24.665, y: -5.5 }, { x: 30, y: -6.2 }, { x: 38, y: -5 }, { x: 44, y: 1 }], timing: 'on-snap', speed: 'normal' })
  })
  motionPitch.ball = { kind: 'pitch', targetId: 'O7' }

  /** Y chips the DE and releases into his route; the RB check-releases late on a handoff. */
  const engageDelayed = base(model, 'fx_engage_release_delayed', 'Fixture — Y chip & release, delayed RB handoff', (ps) => {
    set(ps, 'O5', { path: [{ x: 32.265, y: -0.8 }, { x: 32.4, y: 0.4 }, { x: 34.5, y: 5 }, { x: 40, y: 9 }], timing: 'on-snap', speed: 'normal' })
    set(ps, 'D3', { path: [{ x: 31.265, y: 1.2 }, { x: 31.8, y: 0.2 }, { x: 30.5, y: -3 }, { x: 28, y: -5 }], timing: 'on-snap', speed: 'normal' })
    set(ps, 'O7', { path: [{ x: 24.665, y: -5.5 }, { x: 25.8, y: -3 }, { x: 26.5, y: 2 }, { x: 27, y: 8 }], timing: 'delayed', delay: 0.8, speed: 'normal' })
  })
  engageDelayed.engagements = [{ id: 'fx_e1', kind: 'engage', a: 'O5', b: 'D3', point: { x: 32.1, y: 0.3 }, release: 'O5' }]
  engageDelayed.ball = { kind: 'handoff', carrierId: 'O7' }

  /** X runs a curl told to Settle; the QB throws from a spot the coach picked on his drop. */
  const settleThrow = base(model, 'fx_settle_throw_from_here', 'Fixture — X curl (Settle), Throw From Here', (ps) => {
    set(ps, 'O8', { path: [{ x: 8, y: -0.8 }, { x: 8, y: 11 }, { x: 9.5, y: 9 }], timing: 'on-snap', speed: 'fast', endBehavior: 'settle' })
    set(ps, 'O6', { path: [{ x: 26.665, y: -2.4 }, { x: 26.665, y: -7.4 }], timing: 'on-snap', speed: 'normal' })
  })
  settleThrow.ball = { kind: 'pass', targetId: 'O8', catchPoint: { x: 9.5, y: 9 }, releasePoint: { x: 26.665, y: -6 } }

  return [motionPitch, engageDelayed, settleThrow]
}
