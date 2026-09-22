import { clampToField } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'

/**
 * WHERE TWO MEN MEET, WHEN THE COACH HAS NOT SAID (SPEC §7.3).
 *
 * Telling PEIRA who blocks whom used to take two clicks: pick the defender,
 * then pick the spot. The spot was nearly always the same one - the end of
 * the blocker's path, because that is where he is going - so it is inferred
 * now and the coach only corrects it when he disagrees.
 *
 * Two cases, in this order:
 *   1. the blocker has a path -> its last anchor, which is where he ends up;
 *   2. he has none -> halfway between the two men, which is the honest guess
 *      when nobody has said where either of them is going.
 *
 * THE DEFENDER'S PATH IS NEVER CONSULTED. A block happens where the BLOCKER
 * goes; a defender who drops into coverage has not changed where the man
 * blocking him ends up, and moving the point when his route changes would
 * make a coach's block wander for reasons he did not cause.
 *
 * This lives in the authoring layer, not the engine: it is the editor's guess
 * on the coach's behalf, and the engine is told the answer like any other
 * point the coach could have clicked.
 */
export function inferMeetPoint(blocker: Player, partner: Player): Pt {
  const end = blocker.path.length >= 2 ? blocker.path[blocker.path.length - 1] : null
  const raw = end ?? { x: (blocker.x + partner.x) / 2, y: (blocker.y + partner.y) / 2 }
  return clampToField(raw)
}

/** Did the inference use his path, or fall back to halfway? Decides the toast. */
export const meetPointCameFromPath = (blocker: Player): boolean => blocker.path.length >= 2
