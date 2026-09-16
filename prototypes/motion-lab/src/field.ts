// The field coordinate system.
//
//   x: yards across the field, 0 = left sideline, 53.33 = right sideline
//   y: yards along the field, 0 = line of scrimmage, positive = downfield
//      (toward the defense / top of the screen)
//
// Players and paths are stored in these units. The SVG viewBox is a scaled
// window onto them; `toView` / `fromView` are the only two places that know
// about the mapping.

export const FIELD_WIDTH = 53.33
export const HASH_LEFT = 20 // college hashes: 20 yards in from each sideline
export const HASH_RIGHT = FIELD_WIDTH - 20

// The visible coaching window: 13 yards behind the LOS, 17 yards past it.
export const Y_MIN = -13
export const Y_MAX = 17

// Out-of-bounds margin so sideline players aren't clipped.
export const MARGIN_X = 2

// viewBox units per yard. Keeping this >1 avoids fractional font sizes
// (browsers get fussy about sub-pixel SVG text).
export const U = 20

export const VIEWBOX = `${-MARGIN_X * U} 0 ${(FIELD_WIDTH + 2 * MARGIN_X) * U} ${(Y_MAX - Y_MIN) * U}`

export const toView = (p: { x: number; y: number }) => ({
  x: p.x * U,
  y: (Y_MAX - p.y) * U,
})

export const fromView = (vx: number, vy: number) => ({
  x: vx / U,
  y: Y_MAX - vy / U,
})

const PLAYER_R = 0.9
/** The playable box a marker's centre may occupy. */
export const BOUNDS = { minX: PLAYER_R, maxX: FIELD_WIDTH - PLAYER_R, minY: Y_MIN + PLAYER_R, maxY: Y_MAX - PLAYER_R }
export const clampToField = (p: { x: number; y: number }) => ({
  x: Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, p.x)),
  y: Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, p.y)),
})

/** How far a point can travel along a unit direction before leaving BOUNDS. */
export function distanceToBounds(from: { x: number; y: number }, dir: { x: number; y: number }): number {
  let best = Infinity
  if (dir.x > 0) best = Math.min(best, (BOUNDS.maxX - from.x) / dir.x)
  if (dir.x < 0) best = Math.min(best, (BOUNDS.minX - from.x) / dir.x)
  if (dir.y > 0) best = Math.min(best, (BOUNDS.maxY - from.y) / dir.y)
  if (dir.y < 0) best = Math.min(best, (BOUNDS.minY - from.y) / dir.y)
  return Math.max(0, best)
}

// Absolute yard numbering for the labels. `losYard` is where the ball sits,
// in yards from the offense's own goal line; field y is relative to it.
export function yardLabel(y: number, losYard: number): string | null {
  const abs = losYard + y
  if (abs <= 0 || abs >= 100 || abs % 10 !== 0) return null
  return String(abs > 50 ? 100 - abs : abs)
}
