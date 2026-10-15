// QUICK FORMATIONS: the alignments a coach reaches for first, one click away.
//
// Every play used to start from the one default look, so a coach who wanted
// Trips or an I had to drag eleven men first. These are the common offensive
// sets and defensive fronts, each placed relative to the football (the
// snapper's x, so the hash is kept) and the line of scrimmage, in field yards.
//
// FOOTBALL, NOT DECORATION. Every offense has exactly seven men on the line
// (y within ON_LINE of the snapper) and eleven in all; labels are ones Motion
// Lab already reads (authoring/stances.ts), so roles, stances and the 3D viewer
// treat these men exactly like the default's. A preset replaces ONE side: the
// other side, its assignments and (for a defense) the ball are left alone.

import { clampToField } from '../engine/field'
import { defaultSpeed, type Player, type Side } from '../engine/formation'

/** [label, yards from the football across, yards from the line downfield]. */
type Man = [string, number, number]

export interface FormationPreset {
  id: string
  name: string
  side: Side
  men: Man[]
}

const OL: Man[] = [
  ['LT', -3.6, -0.7],
  ['LG', -1.8, -0.7],
  ['C', 0, -0.6],
  ['RG', 1.8, -0.7],
  ['RT', 3.6, -0.7],
]

const mirror = (men: Man[]): Man[] => men.map(([label, dx, y]) => [label, -dx, y])

export const OFFENSE_PRESETS: FormationPreset[] = [
  { id: 'spread', name: 'Spread', side: 'offense', men: [...OL, ['QB', 0, -5], ['RB', 2, -5], ['X', -18.7, -0.8], ['H', -9.5, -1.6], ['SL', 9.5, -1.6], ['Z', 18.7, -0.8]] },
  { id: 'trips-rt', name: 'Trips Rt', side: 'offense', men: [...OL, ['QB', 0, -5], ['RB', -2, -5], ['X', -18.7, -0.8], ['Y', 5.6, -0.8], ['H', 10.5, -1.6], ['Z', 18.7, -1.6]] },
  { id: 'trips-lt', name: 'Trips Lt', side: 'offense', men: [...OL, ['QB', 0, -5], ['RB', 2, -5], ['Z', 18.7, -0.8], ...mirror([['Y', 5.6, -0.8], ['H', 10.5, -1.6], ['X', 18.7, -1.6]])] },
  { id: 'i-form', name: 'I-Form', side: 'offense', men: [...OL, ['QB', 0, -2.2], ['FB', 0, -4.2], ['RB', 0, -6.8], ['Y', 5.6, -0.8], ['X', -16, -0.8], ['Z', 16, -1.6]] },
  { id: 'ace', name: 'Ace', side: 'offense', men: [...OL, ['QB', 0, -2.2], ['RB', 0, -6.2], ['Y', 5.6, -0.8], ['U', -5.6, -0.8], ['X', -16, -1.6], ['Z', 16, -1.6]] },
  { id: 'pistol', name: 'Pistol', side: 'offense', men: [...OL, ['QB', 0, -3.6], ['RB', 0, -6.8], ['Y', 5.6, -0.8], ['X', -18.7, -0.8], ['H', -9.5, -1.6], ['Z', 18.7, -1.6]] },
  { id: 'empty', name: 'Empty', side: 'offense', men: [...OL, ['QB', 0, -5], ['X', -18.7, -0.8], ['H', -9.5, -1.6], ['RB', 6.5, -1.6], ['SL', 12.5, -1.6], ['Z', 18.7, -0.8]] },
]

const CORNERS: Man[] = [
  ['CB', -18.7, 6.5],
  ['CB', 18.7, 6.5],
]

export const DEFENSE_PRESETS: FormationPreset[] = [
  { id: '4-3', name: '4-3', side: 'defense', men: [['DE', -5.2, 1.2], ['DT', -1.2, 1.2], ['DT', 2.6, 1.2], ['DE', 5.6, 1.2], ['WILL', -4.5, 4.8], ['MIKE', 0, 5.2], ['SAM', 5, 4.8], ...CORNERS, ['FS', -6, 13], ['SS', 7, 10]] },
  { id: '3-4', name: '3-4', side: 'defense', men: [['OLB', -6.8, 1.2], ['DE', -3.4, 1.2], ['NT', 0, 1.2], ['DE', 3.4, 1.2], ['OLB', 6.8, 1.2], ['ILB', -2.4, 4.8], ['ILB', 2.4, 4.8], ...CORNERS, ['FS', -6, 13], ['SS', 7, 10]] },
  { id: 'nickel', name: 'Nickel', side: 'defense', men: [['DE', -5, 1.2], ['DT', -2.6, 1.2], ['NT', 0.9, 1.2], ['DE', 4.6, 1.2], ['LB', -2.5, 4.8], ['LB', 2, 4.8], ['NB', 11.8, 4.5], ...CORNERS, ['FS', -1, 13], ['SS', 9.3, 10]] },
  { id: 'dime', name: 'Dime', side: 'defense', men: [['DE', -5, 1.2], ['DT', -2.6, 1.2], ['NT', 0.9, 1.2], ['DE', 4.6, 1.2], ['MIKE', 0, 5.5], ['NB', 11.8, 4.5], ['DB', -11.8, 4.5], ...CORNERS, ['FS', -6, 13], ['SS', 6, 13]] },
]

/** Labels the default speed table does not know: a slot receiver and a sixth DB run like receivers and DBs. */
const SPEED: Record<string, Player['speed']> = { SL: 'fast', DB: 'fast' }

/**
 * The preset's men as players lined up on the football at `ballX`: fresh ids
 * (O0.. / D0..), no assignments, each position's usual speed.
 */
export function presetPlayers(preset: FormationPreset, ballX: number): Player[] {
  const prefix = preset.side === 'offense' ? 'O' : 'D'
  return preset.men.map(([label, dx, y], i) => {
    const at = clampToField({ x: ballX + dx, y })
    return {
      id: `${prefix}${i}`,
      side: preset.side,
      label,
      x: at.x,
      y: at.y,
      path: [],
      timing: 'on-snap' as const,
      delay: 0.5,
      speed: SPEED[label] ?? defaultSpeed(label),
    }
  })
}
