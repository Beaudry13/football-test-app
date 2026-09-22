// Who does the two jobs the engine has to be able to find: throw it, snap it.
//
// THE LABEL IS WHAT THE COACH CALLS HIM; THE ROLE IS WHAT HE DOES. The engine
// keeps a fallback to the prototype's labels for plays written before roles
// existed (engine/formation.ts, `roleHolder`), and this file is how a play
// stops depending on it: the moment a play opens in the editor, the men who
// were doing those jobs BY LABEL are given the roles, in memory. Nothing is
// written until the coach's next edit saves the play anyway.
//
// After that the labels are his: QB can become Q, 12 or anything else, a
// second man called QB takes nothing over, and the ball still knows who
// throws it.

import { roleHolder, type Player, type PlayerRole } from '../engine/formation'

/** The man doing this job, or undefined. Roles first, prototype labels after. */
export const passerOf = (players: Player[]) => roleHolder(players, 'passer', 'QB')
export const snapperOf = (players: Player[]) => roleHolder(players, 'snapper', 'C')

export const passerIdOf = (players: Player[]) => passerOf(players)?.id ?? null
export const snapperIdOf = (players: Player[]) => snapperOf(players)?.id ?? null

/**
 * Write down who is already doing each job, so a rename cannot change it.
 *
 * Returns the same array when there is nothing to record - every play that
 * already carries a role, and a play with nobody to give one to - so opening
 * a play never looks like an edit.
 */
export function withRoles(players: Player[]): Player[] {
  if (players.some((p) => p.side === 'offense' && p.role)) return players
  const passer = passerOf(players)
  const snapper = snapperOf(players)
  if (!passer && !snapper) return players
  return players.map((p) =>
    p.id === passer?.id ? { ...p, role: 'passer' as PlayerRole } : p.id === snapper?.id ? { ...p, role: 'snapper' as PlayerRole } : p,
  )
}

/**
 * Give one man a role and take it off whoever held it.
 *
 * One passer and one snapper, always - the same rule the loader and the
 * server enforce. A man may hold both (a wildcat direct snap is somebody
 * else's problem, but nothing here stops it).
 */
export function assignRole(players: Player[], id: string, role: PlayerRole): Player[] {
  return players.map((p) => {
    if (p.id === id) return { ...p, role }
    if (p.role === role) {
      const { role: _was, ...rest } = p
      return rest
    }
    return p
  })
}
