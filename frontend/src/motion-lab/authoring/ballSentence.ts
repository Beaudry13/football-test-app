import type { BallAction } from '../engine/ball'
import type { Player } from '../engine/formation'

/**
 * WHAT HAPPENS WITH THE BALL, IN A SENTENCE (SPEC §6.2).
 *
 * The dock's ball control reads as something a coach would say out loud -
 * "Play action to RB, pass to Z, then throw to X" - not as a field of a data
 * structure. The old wording was `Ball: Play Action → RB → Z`: a label, a
 * colon and arrows, which is a summary of the stored object rather than a
 * description of the play.
 *
 * WHY THIS IS NOT `summarize` IN engine/ball.ts. The design says "`summarize`
 * rewritten; engine unchanged", and in PEIRA those two are in tension:
 * `summarize` lives in the engine, and engineIsVerbatim.test.ts pins all nine
 * engine files byte-for-byte against the preserved prototype. So the new
 * grammar lives here instead, in the authoring layer where it belongs -
 * nothing in the engine ever called `summarize`, it was only ever read by the
 * editor. The engine keeps its copy, untouched and unused by this editor.
 */

const labelOf = (players: Player[], id: string) => players.find((p) => p.id === id)?.label ?? '?'

/**
 * The first action, as a sentence. `null` is the invitation to set one.
 *
 * Never "Ball:" and never "→": the control is a sentence, not a summary.
 */
export function ballSentence(action: BallAction | null, players: Player[]): string {
  if (!action) return 'Set the ball'
  const who = (id: string) => labelOf(players, id)
  switch (action.kind) {
    case 'keep':
      return 'QB keeps it'
    case 'handoff':
      return `Handoff to ${who(action.carrierId)}`
    case 'pitch':
      return `Pitch to ${who(action.targetId)}`
    case 'pass':
      return `Pass to ${who(action.targetId)}`
    case 'play-action':
      return `Play action to ${who(action.fakeId)}, pass to ${who(action.targetId)}`
  }
}

/**
 * The second action, as the tail of the first one's sentence.
 *
 * Each kind gets its own verb - hand off, pitch, throw - because "then pass to
 * X" reads as a second pass by the same man, which is not what a chain is.
 */
export function thenClause(then: BallAction | null, players: Player[]): string | null {
  if (!then) return null
  const who = (id: string) => labelOf(players, id)
  switch (then.kind) {
    case 'handoff':
      return `then hand off to ${who(then.carrierId)}`
    case 'pitch':
      return `then pitch to ${who(then.targetId)}`
    case 'pass':
    case 'play-action':
      return `then throw to ${who(then.targetId)}`
    case 'keep':
      // Not reachable through the UI - THEN_KINDS offers handoff/pitch/pass -
      // but a hand-edited play must not put "undefined" on a coach's screen.
      return null
  }
}

/** The whole thing: the first action, and the second if there is one. */
export function fullBallSentence(action: BallAction | null, then: BallAction | null, players: Player[]): string {
  const first = ballSentence(action, players)
  if (!action) return first
  const tail = thenClause(then, players)
  return tail ? `${first}, ${tail}` : first
}

/**
 * How far downfield the ball is caught, for the menu's Now card.
 *
 * Derived at render from the catch point the play already stores; nothing new
 * is written. Behind the line of scrimmage is said as such rather than as a
 * negative number, and a catch at the line is neither.
 */
export function catchDepth(action: BallAction | null): string | null {
  if (!action || (action.kind !== 'pass' && action.kind !== 'play-action')) return null
  const y = action.catchPoint.y
  const yards = Math.round(Math.abs(y))
  if (yards === 0) return 'caught at the line'
  return y > 0 ? `caught ${yards} yds downfield` : `caught ${yards} yds behind the line`
}
