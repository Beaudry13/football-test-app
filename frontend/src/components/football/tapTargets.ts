// WHAT A PLAYER TAPS IN THE PICTURE - shared by every football question
// (Quiz, Rep, Review Missed, Teach) and by the coach's check of it.
//
// One target per answer, as fractions of the picture: a man (a ring on him) or,
// with `zone`, a place on the field (a gap, a drop) shown labelled.

/** The coach's "you are this player" ring on a photo: picture fractions, r of its width. */
export interface Marker {
  x: number
  y: number
  r: number
}

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

/** How close two targets may be before their buttons would overlap: places
 *  on one line within a few yards; men within a ring's width on a phone. */
const reach = (t: TapTarget) => (t.zone ? { x: 0.12, y: 0.03 } : { x: 0.12, y: 0.08 })

/**
 * Targets grouped for drawing. A man standing clear gets a ring on him; a
 * place standing clear, a labelled spot. Targets too close to tell apart (a
 * line's gaps a yard or two apart; a slot and a tight end side by side - a
 * few pixels on a phone) share one row of labelled buttons in field order,
 * with a dot on each true spot, so every answer stays readable and tappable.
 */
export function placeRows(targets: TapTarget[]): number[][] {
  const rows: number[][] = []
  const order = targets.map((t, i) => ({ ...t, i })).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const p of order) {
    const r = reach(p)
    const row = rows.find((members) =>
      members.some((m) => {
        const q = targets[m]
        return !!q.zone === !!p.zone && Math.abs(q.x - p.x) < r.x && Math.abs(q.y - p.y) < r.y
      }),
    )
    if (row) row.push(p.i)
    else rows.push([p.i])
  }
  return rows.map((row) => [...row].sort((a, b) => targets[a].x - targets[b].x))
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
