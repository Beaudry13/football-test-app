// WHERE THINGS SIT IN A PLAY PICTURE (playImage.ts) - shared with the panels
// that let a coach tap a man in the picture ("Make question": whose job?).

import { FIELD_WIDTH, Y_MAX, Y_MIN } from './engine/field'
import type { Pt } from './engine/geometry'
import type { Play } from './engine/play'

/** Pixels per yard. 24 gives a 1376 x 720 picture: sharp, and well inside the upload limit. */
export const U = 24
export const MARGIN = 2
export const IMAGE_WIDTH = Math.round((FIELD_WIDTH + 2 * MARGIN) * U)
export const IMAGE_HEIGHT = Math.round((Y_MAX - Y_MIN) * U)

/** A field point (yards) as a point in the picture (pixels). */
export const px = (p: Pt) => ({ x: (p.x + MARGIN) * U, y: (Y_MAX - p.y) * U })

/** The man drawn at a point in the picture (pixels) - the nearest one within reach - or null. */
export function playerAt(play: Play, at: { x: number; y: number }, reach = 1.4 * U): string | null {
  let best: string | null = null
  let bestD = reach
  for (const p of play.players) {
    const c = px(p)
    const d = Math.hypot(c.x - at.x, c.y - at.y)
    if (d <= bestD) {
      best = p.id
      bestD = d
    }
  }
  return best
}
