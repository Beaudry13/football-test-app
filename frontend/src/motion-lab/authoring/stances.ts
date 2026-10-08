// THE COACH'S WORDS FOR A PRE-SNAP STANCE (V6).
//
// The stance itself is a canonical id stored on the player (STANCE_IDS in
// engine/formation.ts). This file is only how a coach SEES and CHOOSES one:
// which family a man's position belongs to, the words for each stance, and
// what the 3D viewer will stand him in when he has none.
//
// THE CHOICE IS NARROWED BY POSITION, NEVER ENFORCED BY IT. A man's family
// comes from what the engine already knows about him - his role (who snaps
// it, who throws it) and then his label - and it decides which stances are
// OFFERED. It never removes or rewrites a stance he already has: relabel a
// tackle "X" and his 2-point stays until the coach picks something else.
// When the label says nothing we can trust (a coach's own name for him, or a
// letter that means two positions - N, S), every stance on his side is
// offered, grouped, rather than a guess.
//
// THE POSITION DEFAULT IS SHOWN, NEVER STORED. `defaultStanceFor` is the
// stance the 3D viewer falls back to for a man with no stance - the viewer
// runs this very function (vendored verbatim) on the play it is handed - so
// the editor can say "Position default: 3 Point - Left Hand Down" truthfully.
// Choosing "Position default" CLEARS the field; it never writes the default in.

import { STANCE_IDS, type Player, type StanceId } from '../engine/formation'
import { alignmentOf } from './alignment'
import { passerOf, snapperOf } from './roles'

export type StanceFamily = 'OL' | 'QB' | 'WR' | 'TE' | 'RB' | 'DL' | 'LB' | 'DB'

/** Families in the order a coach reads a formation: offense, then defense. */
export const FAMILIES: StanceFamily[] = ['OL', 'QB', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB']
const OFFENSE_FAMILIES: StanceFamily[] = ['OL', 'QB', 'WR', 'TE', 'RB']
const DEFENSE_FAMILIES: StanceFamily[] = ['DL', 'LB', 'DB']

export const FAMILY_NAME: Record<StanceFamily, string> = {
  OL: 'Offensive line',
  QB: 'Quarterback',
  WR: 'Receiver',
  TE: 'Tight end',
  RB: 'Running back',
  DL: 'Defensive line',
  LB: 'Linebacker',
  DB: 'Defensive back',
}

/** Each stance's family, and the words a coach sees for it inside that family. */
export const STANCE: Record<StanceId, { family: StanceFamily; label: string }> = {
  OL_2_POINT: { family: 'OL', label: '2 Point' },
  OL_3_POINT_LEFT: { family: 'OL', label: '3 Point — Left Hand Down' },
  OL_3_POINT_RIGHT: { family: 'OL', label: '3 Point — Right Hand Down' },
  CENTER_STANCE: { family: 'OL', label: 'Center' },
  OL_4_POINT: { family: 'OL', label: '4 Point' },
  DL_2_POINT: { family: 'DL', label: '2 Point' },
  DL_3_POINT_LEFT: { family: 'DL', label: '3 Point — Left Hand Down' },
  DL_3_POINT_RIGHT: { family: 'DL', label: '3 Point — Right Hand Down' },
  DL_4_POINT: { family: 'DL', label: '4 Point' },
  QB_UNDER_CENTER: { family: 'QB', label: 'Under Center' },
  QB_PISTOL: { family: 'QB', label: 'Pistol' },
  QB_SHOTGUN: { family: 'QB', label: 'Shotgun' },
  WR_STANDARD: { family: 'WR', label: 'Standard' },
  WR_STAGGERED: { family: 'WR', label: 'Staggered' },
  TE_2_POINT: { family: 'TE', label: '2 Point' },
  TE_3_POINT: { family: 'TE', label: '3 Point' },
  TE_DETACHED: { family: 'TE', label: 'Detached — WR Stance' },
  RB_BALANCED: { family: 'RB', label: 'Balanced' },
  RB_STAGGERED: { family: 'RB', label: 'Staggered' },
  RB_PISTOL: { family: 'RB', label: 'Pistol' },
  RB_DEEP: { family: 'RB', label: 'Deep' },
  LB_STACK: { family: 'LB', label: 'Stack' },
  LB_WALKED_UP: { family: 'LB', label: 'Walked Up' },
  LB_EDGE: { family: 'LB', label: 'Edge' },
  DB_PRESS: { family: 'DB', label: 'Press' },
  DB_OFF: { family: 'DB', label: 'Off' },
  DB_SAFETY: { family: 'DB', label: 'Safety' },
}

/** A stance in the words of its own family: "2 Point", "Shotgun". */
export const stanceLabel = (id: StanceId) => STANCE[id].label
/** A stance named with its family, for when it sits outside the man's own: "Defensive back · Press". */
export const stanceFullLabel = (id: StanceId) => `${FAMILY_NAME[STANCE[id].family]} · ${STANCE[id].label}`

const stancesOf = (family: StanceFamily) => STANCE_IDS.filter((id) => STANCE[id].family === family)

// Labels are the coach's (at most four characters, upper case). Only labels
// that mean ONE position here are listed; anything else - "N" (nose or
// nickel), "S" (Sam or safety), a coach's own name for a man - is left
// unknown on purpose, and he is offered his whole side.
const OFFENSE_LABELS: Record<string, StanceFamily> = {
  LT: 'OL', LG: 'OL', RG: 'OL', RT: 'OL', OL: 'OL', T: 'OL', G: 'OL', C: 'OL',
  QB: 'QB', Q: 'QB',
  X: 'WR', Z: 'WR', H: 'WR', WR: 'WR', W: 'WR', SL: 'WR', SE: 'WR', FL: 'WR', SLOT: 'WR',
  Y: 'TE', TE: 'TE', U: 'TE',
  RB: 'RB', HB: 'RB', TB: 'RB', FB: 'RB', B: 'RB', R: 'RB',
}
const DEFENSE_LABELS: Record<string, StanceFamily> = {
  DE: 'DL', DT: 'DL', NT: 'DL', NG: 'DL', DL: 'DL', E: 'DL', T: 'DL', '1T': 'DL', '3T': 'DL', '5T': 'DL',
  LB: 'LB', MLB: 'LB', OLB: 'LB', ILB: 'LB', M: 'LB', W: 'LB', MIKE: 'LB', WILL: 'LB', SAM: 'LB', SLB: 'LB', WLB: 'LB', JACK: 'LB', EDGE: 'LB',
  CB: 'DB', NB: 'DB', FS: 'DB', SS: 'DB', DB: 'DB', C: 'DB', LC: 'DB', RC: 'DB', NICK: 'DB', STAR: 'DB', F: 'DB', $: 'DB', SAF: 'DB',
}
/** Defensive backs who line up deep: their default is the safety stance. */
const SAFETY_LABELS = new Set(['FS', 'SS', 'F', '$', 'SAF'])

/** The man who snaps it, by role and then by the prototype's label - the engine's own answer. */
export const isCenter = (p: Player, players: Player[]) => p.side === 'offense' && snapperOf(players)?.id === p.id
const isPasser = (p: Player, players: Player[]) => p.side === 'offense' && passerOf(players)?.id === p.id

/**
 * The family a man's position puts him in, or null when nothing about him says.
 * What the ENGINE knows wins over the label: the snapper is a lineman and the
 * passer a quarterback, whatever the coach calls them.
 */
export function stanceFamilyOf(p: Player, players: Player[]): StanceFamily | null {
  if (isCenter(p, players)) return 'OL'
  if (isPasser(p, players)) return 'QB'
  const label = p.label.trim().toUpperCase()
  return (p.side === 'offense' ? OFFENSE_LABELS : DEFENSE_LABELS)[label] ?? null
}

export interface StanceGroup {
  family: StanceFamily
  ids: StanceId[]
}

/**
 * What the coach is offered for this man: his family's stances, or every
 * stance on his side grouped by family when his position does not say.
 * The center gets his own stance first; any other lineman may still choose
 * it, last, because a label alone cannot prove he never snaps.
 */
export function stanceChoices(p: Player, players: Player[]): StanceGroup[] {
  const family = stanceFamilyOf(p, players)
  if (family === 'OL') {
    const line = stancesOf('OL').filter((id) => id !== 'CENTER_STANCE')
    return [{ family, ids: isCenter(p, players) ? ['CENTER_STANCE', ...line] : [...line, 'CENTER_STANCE'] }]
  }
  if (family) return [{ family, ids: stancesOf(family) }]
  return (p.side === 'offense' ? OFFENSE_FAMILIES : DEFENSE_FAMILIES).map((f) => ({ family: f, ids: stancesOf(f) }))
}

/** True when his chosen stance is not among what his position is offered (e.g. after a relabel). */
export function stanceOutOfPosition(p: Player, players: Player[]): boolean {
  if (!p.presnapStance) return false
  return !stanceChoices(p, players).some((g) => g.ids.includes(p.presnapStance!))
}

/** The x of the football at the snap: the center's feet, as the engine places it. */
export function snapX(players: Player[]): number {
  return snapperOf(players)?.x ?? 53.33 / 2
}

/** The engine's shotgun rule (ball.ts): deeper than 3 yards behind the snap spot. */
const SHOTGUN_DEPTH = 3

/**
 * The stance the 3D viewer stands him in when the coach has not chosen one.
 *
 * Linemen put the OUTSIDE hand down (a man on the ball's right is a right-
 * hand-down player), the center takes his snapping stance, the quarterback
 * is in the gun when he is deeper than the engine's shotgun depth, a tight
 * end stands the way his ALIGNMENT asks (below), safeties are in the safety
 * stance, and everyone else in his family's first stance. A man whose label
 * does not say is treated as a receiver on offense and a linebacker on
 * defense - exactly what the viewer does with him.
 *
 * A tight end, from where he lines up (alignment.ts): attached to the line -
 * the 3-point; off it, close in (a wing) - the square 2-point; split out
 * where a receiver stands - Detached, the receiver's stance. With no line to
 * read (nobody snaps it yet) he keeps the 3-point. Move him and the default
 * follows; a stance the coach chose is never touched.
 */
export function defaultStanceFor(p: Player, players: Player[]): StanceId {
  const family = stanceFamilyOf(p, players)
  const offense = p.side === 'offense'
  const onRight = (p.x - snapX(players)) * (offense ? 1 : -1) >= 0
  switch (family) {
    case 'OL':
      return isCenter(p, players) ? 'CENTER_STANCE' : onRight ? 'OL_3_POINT_RIGHT' : 'OL_3_POINT_LEFT'
    case 'DL':
      return onRight ? 'DL_3_POINT_RIGHT' : 'DL_3_POINT_LEFT'
    case 'QB': {
      const snapper = snapperOf(players)
      const spotY = snapper ? snapper.y + 1.0 : 0.4
      return spotY - p.y > SHOTGUN_DEPTH ? 'QB_SHOTGUN' : 'QB_UNDER_CENTER'
    }
    case 'TE': {
      const at = alignmentOf(p, players)
      return at === 'wing' ? 'TE_2_POINT' : at === 'split' ? 'TE_DETACHED' : 'TE_3_POINT'
    }
    case 'RB':
      return 'RB_BALANCED'
    case 'LB':
      return 'LB_STACK'
    case 'DB':
      return SAFETY_LABELS.has(p.label.trim().toUpperCase()) ? 'DB_SAFETY' : 'DB_OFF'
    case 'WR':
      return 'WR_STAGGERED'
    default:
      return offense ? 'WR_STAGGERED' : 'LB_STACK'
  }
}

/** Set or clear a man's stance. Clearing REMOVES the key: absent is the only way to say "position default". */
export function withStance(p: Player, stance: StanceId | undefined): Player {
  if (stance) return { ...p, presnapStance: stance }
  const { presnapStance: _cleared, ...rest } = p
  return rest
}
