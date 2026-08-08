import type { NormalisedRect } from './RegionDraw';

/** A text run detected in the PDF's own text layer, in normalised 0-1 page
 *  coordinates. Not OCR - see backend/app/services/document_text.py. */
export interface TextRun extends NormalisedRect {
  text: string;
}

/** How far outside a run a tap may land and still select it, as a fraction of
 *  the page's width.
 *
 * This exists because of what the spike measured. A formation page's runs are
 * the position labels - X, M, SS - with a median width of 9-11px on a 1000px
 * canvas. Point-in-box alone would make them nearly untappable. But those same
 * labels are ISOLATED (6-30% crowded), because they are scattered across a
 * field, so a generous radius resolves unambiguously there.
 *
 * Dense prose is the opposite: runs are 23-27px and comfortably hittable
 * directly, but tightly stacked, where a large radius would grab the wrong
 * line. Which is why the radius is only ever a FALLBACK - see hitTest.
 */
export const TAP_RADIUS = 0.012;

function contains(run: TextRun, x: number, y: number): boolean {
  return x >= run.x && x <= run.x + run.width && y >= run.y && y <= run.y + run.height;
}

/** Distance from a point to the nearest edge of a run, 0 when inside. */
function distanceTo(run: TextRun, x: number, y: number): number {
  const dx = Math.max(run.x - x, 0, x - (run.x + run.width));
  const dy = Math.max(run.y - y, 0, y - (run.y + run.height));
  return Math.hypot(dx, dy);
}

/** The run a tap selects, or null if the tap was on empty page.
 *
 * TWO PASSES, IN THIS ORDER, and the order is the whole design:
 *
 *   1. point-in-box - if the tap landed inside a run, that run wins outright
 *   2. otherwise, the nearest run within TAP_RADIUS
 *
 * The fallback can never steal a hit from a run the coach actually landed on,
 * so one policy serves both page types with no mode switch and nothing for the
 * coach to choose. That is what makes tap and drag genuinely hybrid rather
 * than two modes wearing a trenchcoat.
 *
 * When several runs contain the point - overlapping boxes do occur - the
 * smallest wins, because the smaller box is the more specific target.
 */
export function hitTest(runs: TextRun[], x: number, y: number): TextRun | null {
  let best: TextRun | null = null;
  let bestArea = Infinity;

  for (const run of runs) {
    if (!contains(run, x, y)) continue;
    const area = run.width * run.height;
    if (area < bestArea) {
      best = run;
      bestArea = area;
    }
  }
  if (best) return best;

  let nearest: TextRun | null = null;
  let nearestDistance = TAP_RADIUS;
  for (const run of runs) {
    const distance = distanceTo(run, x, y);
    if (distance < nearestDistance) {
      nearest = run;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Grows a run's box outward slightly so the mask fully covers its glyphs.
 *
 * PDFium's boxes sit tight on the type. Masking exactly that box can leave a
 * hairline of ink at the edges after rounding - and a mask that leaks a sliver
 * of the answer has failed at the one thing it does.
 */
export const RUN_PADDING = 0.002;

export function paddedRect(run: TextRun): NormalisedRect {
  const x = Math.max(0, run.x - RUN_PADDING);
  const y = Math.max(0, run.y - RUN_PADDING);
  return {
    x,
    y,
    width: Math.min(1 - x, run.width + RUN_PADDING * 2),
    height: Math.min(1 - y, run.height + RUN_PADDING * 2),
  };
}

/** Whether a point falls inside an already-created region.
 *
 * Used to decide whether a click SELECTS an existing region rather than
 * creating a new one. Checked before text hit-testing: a coach clicking a
 * region they can see is aiming at it, not at whatever is underneath.
 */
export function regionAt<T extends { rect: NormalisedRect }>(
  regions: T[],
  x: number,
  y: number,
): T | null {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const region of regions) {
    const { rect } = region;
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      best = region;
      bestArea = area;
    }
  }
  return best;
}
