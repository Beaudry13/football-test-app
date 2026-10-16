// WHAT A PLAYER TAPS IN THE PICTURE - shared by every football question
// (Quiz, Rep, Review Missed, Teach) and by the coach's check of it.
//
// One target per answer, as fractions of the picture: a man (a ring on him) or,
// with `zone`, a place on the field (a gap, a drop) shown labelled.

export interface TapTarget {
  x: number
  y: number
  zone?: boolean
}

/** A question's tap targets when they are usable: one per answer, and a picture to tap. */
export function usableTargets(
  targets: TapTarget[] | null | undefined,
  optionCount: number,
  hasPicture: boolean,
): TapTarget[] | null {
  return targets && targets.length === optionCount && optionCount >= 2 && hasPicture ? targets : null
}

/** How far upfield (a fraction of the picture) a row of close places sits above them. */
export const ROW_LIFT = 0.2

/**
 * Targets grouped for drawing. A man, or a place standing alone, is a row of
 * one; places on one line within a short reach of each other (a line's gaps,
 * a yard or two apart - a few pixels on a phone) share a row, ordered across
 * the field, so every label stays readable.
 */
export function placeRows(targets: TapTarget[]): number[][] {
  const rows: number[][] = []
  const places = targets
    .map((t, i) => ({ ...t, i }))
    .filter((t) => t.zone)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  for (const p of places) {
    const row = rows.find((r) => {
      const last = targets[r[r.length - 1]]
      return Math.abs(last.y - p.y) < 0.03 && Math.abs(p.x - last.x) < 0.12
    })
    if (row) row.push(p.i)
    else rows.push([p.i])
  }
  targets.forEach((t, i) => !t.zone && rows.push([i]))
  return rows
}

/** Whether every target is a man (rings) - the words a hint uses. */
export const tapsMen = (targets: TapTarget[]) => !targets.some((t) => t.zone)

/** Spots for answers that name no man or place: an even row across the
 *  field (picture fractions) for the coach to drag where he means each. */
export function spreadTargets(count: number): TapTarget[] {
  const left = 0.244
  const right = 0.756
  return Array.from({ length: count }, (_, i) => ({
    x: count === 1 ? 0.5 : left + ((right - left) * i) / (count - 1),
    y: 0.3,
    zone: true,
  }))
}
