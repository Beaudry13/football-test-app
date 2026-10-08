import { describe, expect, it } from 'vitest'
import type { Player } from '../engine/formation'
import { alignmentOf, lineIds, MAX_SPLIT } from './alignment'
import { defaultStanceFor } from './stances'

/**
 * WHERE A MAN IS LINED UP, AND THE TIGHT END'S DEFAULT STANCE THAT FOLLOWS.
 *
 * Read from the formation - the men on the line, found from the snapper
 * outward - never from a label: a tight end attached to the line defaults to
 * the 3-point, one off it close in (a wing) to the square 2-point, and one
 * split out where a receiver stands to Detached. The 3D viewer runs these same
 * functions, so its fallback is the editor's "Position default" by
 * construction.
 */

const man = (id: string, x: number, y: number, label = id, side: Player['side'] = 'offense'): Player => ({
  id, side, label, x, y, path: [], timing: 'on-snap', delay: 0.5, speed: 'controlled',
})
/** A normal five with the center snapping, plus whoever else is given. */
const line = (...others: Player[]): Player[] => [
  man('LT', 23.1, -0.7), man('LG', 24.9, -0.7), { ...man('C', 26.7, -0.6), role: 'snapper' as const }, man('RG', 28.5, -0.7), man('RT', 30.3, -0.7),
  ...others,
]
const at = (p: Player, players: Player[]) => alignmentOf(p, players)

describe('alignmentOf', () => {
  it('attached: a tight end 2.0 yd outside the tackle, on the line, is one of the men on it', () => {
    const y = man('Y', 32.3, -0.8)
    const men = line(y)
    expect(lineIds(men).ids.has('Y')).toBe(true)
    expect(at(y, men)).toBe('attached')
  })

  it('attached on the LEFT too: the line is walked both ways from the snapper', () => {
    const y = man('Y', 21.1, -0.8)
    expect(at(y, line(y))).toBe('attached')
  })

  it('wing: off the line, a yard outside and back from the end man', () => {
    const wing = man('TE', 31.3, -1.9)
    expect(at(wing, line(wing))).toBe('wing')
  })

  it('wing: an H-back or a man in the backfield, inside the line - off it, not split', () => {
    const hBack = man('TE', 29.4, -3.0)
    expect(at(hBack, line(hBack))).toBe('wing')
  })

  it('split: on the ball but a real split outside the end of the line (a split end)', () => {
    const split = man('TE', 36.0, -0.8)
    expect(at(split, line(split))).toBe('split')
  })

  it('split: off the ball and out wide (a slot or a flanker)', () => {
    const slot = man('TE', 38.0, -1.6)
    expect(at(slot, line(slot))).toBe('split')
  })

  it('measures from the END of the line, so an attached tight end moves it out', () => {
    // With Y attached at 32.3, a man nearly 5 yd outside the tackle is still
    // within a split of Y - so a wing; a little further and he is split out.
    const y = man('Y', 32.3, -0.8)
    const wing = man('U', 32.3 + MAX_SPLIT - 0.1, -1.9)
    expect(at(wing, line(y, wing))).toBe('wing')
    const wider = { ...wing, x: 32.3 + MAX_SPLIT + 0.2 }
    expect(at(wider, line(y, wider))).toBe('split')
  })

  it('reads nothing when there is no line: nobody snaps it, or the snapper stands alone', () => {
    const y = man('Y', 32.3, -0.8)
    const noSnapper = [man('LT', 23.1, -0.7), man('LG', 24.9, -0.7), man('PIV', 26.7, -0.6), man('RG', 28.5, -0.7), y]
    expect(at(y, noSnapper)).toBeNull()
    const alone = [{ ...man('C', 26.7, -0.6), role: 'snapper' as const }, y]
    expect(at(y, alone)).toBeNull()
  })

  it('is for the offense only', () => {
    const de = man('DE', 32.3, 1.2, 'DE', 'defense')
    expect(at(de, line(de))).toBeNull()
  })
})

describe("a tight end's position default follows his alignment", () => {
  it('attached -> 3 Point, wing -> 2 Point, split -> Detached', () => {
    const y = man('Y', 32.3, -0.8)
    const wing = man('TE', 21.1, -1.9)
    const split = man('U', 46.0, -1.6)
    const men = line(y, wing, split)
    expect(defaultStanceFor(y, men)).toBe('TE_3_POINT')
    expect(defaultStanceFor(wing, men)).toBe('TE_2_POINT')
    expect(defaultStanceFor(split, men)).toBe('TE_DETACHED')
  })

  it('keeps the 3-point when there is no line to read', () => {
    const y = man('Y', 32.3, -0.8)
    expect(defaultStanceFor(y, [man('PIV', 26.7, -0.6), y])).toBe('TE_3_POINT')
  })

  it('follows him when he moves, and never touches a stance the coach chose', () => {
    const y = man('Y', 32.3, -0.8)
    expect(defaultStanceFor(y, line(y))).toBe('TE_3_POINT')
    const flexed = { ...y, x: 40.0 }
    expect(defaultStanceFor(flexed, line(flexed))).toBe('TE_DETACHED')
    // The default is only ever the fallback: his own stance is the player's
    // field, which none of this reads or writes.
    const chosen = { ...flexed, presnapStance: 'TE_3_POINT' as const }
    defaultStanceFor(chosen, line(chosen))
    expect(chosen.presnapStance).toBe('TE_3_POINT')
  })

  it('only the tight end: a receiver or a lineman at the same spot keeps his own default', () => {
    const x = man('X', 21.1, -1.9)
    expect(defaultStanceFor(x, line(x))).toBe('WR_STAGGERED')
    const sixth = man('T', 32.3, -0.8)
    expect(defaultStanceFor(sixth, line(sixth))).toBe('OL_3_POINT_RIGHT')
  })
})
