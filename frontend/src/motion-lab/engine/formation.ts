import type { EndBehavior, Pt } from './geometry'

export type Side = 'offense' | 'defense'

/** When a player's assignment begins, in football terms. */
export type Timing = 'pre-snap' | 'on-snap' | 'delayed'

/**
 * A job the engine itself has to be able to find: who throws it, who snaps it.
 *
 * THE LABEL IS WHAT THE COACH CALLS HIM; THE ROLE IS WHAT HE DOES. The
 * prototype had no roles and found both men by label - the offensive player
 * called QB, the one called C - so renaming the quarterback to "Q" or "12"
 * left the ball with nobody to throw it and the snap at midfield. A role is
 * carried by the man, so it survives a rename, a move, a saved formation and
 * an undo. At most one of each, on offense.
 */
export type PlayerRole = 'passer' | 'snapper'

/**
 * The man doing a job, by role, falling back to the label the prototype used.
 *
 * The fallback is what keeps every play written before roles existed - and
 * every characterization golden - behaving exactly as it did: when nobody
 * carries the role, this is the prototype's own lookup, line for line. Once
 * any man carries it, the label stops deciding anything, so a coach can call
 * his quarterback whatever he likes and a second "QB" on the field takes
 * nothing over.
 */
export function roleHolder(players: Player[], role: PlayerRole, legacyLabel: string): Player | undefined {
  const byRole = players.find((p) => p.side === 'offense' && p.role === role)
  if (byRole) return byRole
  if (players.some((p) => p.side === 'offense' && p.role)) {
    // This document knows about roles; it simply has nobody in this one.
    return undefined
  }
  return players.find((p) => p.side === 'offense' && p.label === legacyLabel)
}

/** How the player moves. Tiers, not yards-per-second; a coach picks a word. */
export type SpeedTier = 'controlled' | 'normal' | 'fast'
export const SPEED_YPS: Record<SpeedTier, number> = {
  controlled: 4.5, // OL pulling, QB drop, a stunting DT
  normal: 6.5, // backs, TEs, linebackers
  fast: 8.5, // receivers and DBs
}

// Loose defaults by position so a WR go and an OL pull never look alike
// out of the box. The coach can override per player.
const DEFAULT_SPEED: Record<string, SpeedTier> = {
  X: 'fast', Z: 'fast', H: 'fast', CB: 'fast', FS: 'fast', SS: 'fast', NB: 'fast',
  QB: 'normal', RB: 'normal', Y: 'normal', LB: 'normal', DE: 'normal',
  LT: 'controlled', LG: 'controlled', C: 'controlled', RG: 'controlled', RT: 'controlled',
  DT: 'controlled', NT: 'controlled',
}
export const defaultSpeed = (label: string): SpeedTier => DEFAULT_SPEED[label] ?? 'normal'

export interface Player {
  id: string
  side: Side
  label: string
  /** Pre-snap alignment in field yards. */
  x: number
  y: number
  /**
   * Movement ANCHORS in field yards: start (= x,y), each direction change,
   * end. Empty = stands still. The drawn/animated polyline is derived from
   * these by `renderPath`; see geometry.ts.
   */
  path: Pt[]
  timing: Timing
  /** Seconds after the snap; only meaningful when timing === 'delayed'. */
  delay: number
  speed: SpeedTier
  /**
   * What happens when the drawn route runs out before the ball arrives.
   * Absent = auto (decided from the route's geometry, see classifyEnd).
   */
  endBehavior?: EndBehavior
  /**
   * What he does for the engine, independent of his label (see PlayerRole).
   * Optional, and absent means this document predates roles - the engine
   * then reads labels exactly as the prototype did.
   */
  role?: PlayerRole
  /**
   * PRE-SNAP MOTION, in field yards: from his alignment to where he is at the
   * snap. `path` is then the POST-SNAP route, and it starts where this ends.
   * Optional, and absent means this player has no motion - he runs exactly
   * as the prototype ran him, including a legacy `timing: 'pre-snap'` path.
   */
  motion?: Pt[]
}

const MID = 53.33 / 2

// A plausible 11 personnel look vs. a 4-2-5. Alignment is approximate on
// purpose — the coach drags players where they want them.
const OFFENSE: [string, number, number][] = [
  ['LT', MID - 3.6, -0.7],
  ['LG', MID - 1.8, -0.7],
  ['C', MID, -0.6],
  ['RG', MID + 1.8, -0.7],
  ['RT', MID + 3.6, -0.7],
  ['Y', MID + 5.6, -0.8],
  ['QB', MID, -2.4],
  ['RB', MID - 2.0, -5.5],
  ['X', 8, -0.8],
  ['H', 38, -1.6],
  ['Z', 46, -1.6],
]

const DEFENSE: [string, number, number][] = [
  ['DE', MID - 5.0, 1.2],
  ['DT', MID - 2.6, 1.2],
  ['NT', MID + 0.9, 1.2],
  ['DE', MID + 4.6, 1.2],
  ['LB', MID - 2.5, 4.8],
  ['LB', MID + 2.0, 4.8],
  ['NB', 38.5, 4.5],
  ['CB', 8, 6.5],
  ['CB', 46, 6.5],
  ['FS', MID - 1.0, 13.0],
  ['SS', 36, 10.0],
]

export function initialPlayers(): Player[] {
  const off = OFFENSE.map(([label, x, y], i) => ({
    id: `O${i}`,
    side: 'offense' as const,
    label,
    x,
    y,
    path: [],
    timing: 'on-snap' as const,
    delay: 0.5,
    speed: defaultSpeed(label),
  }))
  const def = DEFENSE.map(([label, x, y], i) => ({
    id: `D${i}`,
    side: 'defense' as const,
    label,
    x,
    y,
    path: [],
    timing: 'on-snap' as const,
    delay: 0.5,
    speed: defaultSpeed(label),
  }))
  return [...off, ...def]
}

/** The ball sits at the center's feet on the LOS. */
export const BALL: Pt = { x: MID, y: -0.05 }
