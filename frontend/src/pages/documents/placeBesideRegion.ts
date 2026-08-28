/** Where to put a panel so it sits BESIDE the region it belongs to, and never
 *  on top of it.
 *
 * The question form used to live in a fixed column on the right, which meant
 * the coach's eyes crossed the whole page between the rectangle they had just
 * drawn and the box they typed into. Anchoring the panel to the region closes
 * that gap.
 *
 * READ-ONLY. This consumes a region and returns pixel offsets for a floating
 * box. It never returns a region, and nothing it computes is stored - the
 * saved rectangle is whatever RegionDraw produced, untouched. Moving a panel
 * cannot move a mask.
 *
 * Everything here is in PIXELS WITHIN THE PAGE BOX, not viewport coordinates,
 * because the page box is the only frame both the region and the panel share.
 * The caller converts the region's normalised 0-1 rect once, on the way in.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Which side it landed on. Exposed so the panel can point at the region
   *  and so tests can assert the CHOICE, not just the coordinates. */
  side: 'right' | 'left' | 'below' | 'above';
}

function clamp(value: number, min: number, max: number): number {
  // max < min when the panel is taller or wider than the page. Pinning to min
  // keeps the panel's top-left on the page rather than flinging it negative.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Place `panel` beside `region`, both in pixels within a `page`-sized box.
 *
 * The order is deliberate:
 *
 *   1. RIGHT if it fits, because a coach reading left-to-right expects the
 *      answer box after the thing it describes.
 *   2. LEFT if it does not - a region against the right edge is the common
 *      case on a two-column install sheet.
 *   3. BELOW, then ABOVE, when the region is so wide that neither side has
 *      room. A full-width diagram has no beside.
 *
 * In every branch the panel is clamped inside the page box, so it cannot
 * leave the surface no matter where the region is.
 */
export function placeBesideRegion(
  region: Box,
  panel: Size,
  page: Size,
  gap = 12,
): Placement {
  const needed = panel.width + gap;
  const freeRight = page.width - (region.x + region.width);
  const freeLeft = region.x;

  if (freeRight >= needed) {
    return {
      left: region.x + region.width + gap,
      top: clamp(region.y, 0, page.height - panel.height),
      side: 'right',
    };
  }

  if (freeLeft >= needed) {
    return {
      left: region.x - panel.width - gap,
      top: clamp(region.y, 0, page.height - panel.height),
      side: 'left',
    };
  }

  // Neither side fits. Centre it on the region horizontally and move it off
  // the region vertically - below by preference, above when the region is
  // near the bottom.
  const left = clamp(
    region.x + region.width / 2 - panel.width / 2,
    0,
    page.width - panel.width,
  );
  const below = region.y + region.height + gap;
  if (below + panel.height <= page.height) {
    return { left, top: below, side: 'below' };
  }

  const above = region.y - panel.height - gap;
  if (above >= 0) {
    return { left, top: above, side: 'above' };
  }

  // The region is taller than the page has room around. Nothing can avoid it
  // completely, so take the larger remaining strip rather than guessing.
  const roomBelow = page.height - (region.y + region.height);
  const roomAbove = region.y;
  return roomBelow >= roomAbove
    ? { left, top: clamp(below, 0, page.height - panel.height), side: 'below' }
    : { left, top: clamp(above, 0, page.height - panel.height), side: 'above' };
}

/** Does `placement` overlap `region`? Only used by the tests, which is the
 *  point - "never covers the region" is the one promise this file makes, and
 *  it should be checked by something other than the code that made it. */
export function overlaps(placement: Placement, panel: Size, region: Box): boolean {
  const a = {
    left: placement.left,
    right: placement.left + panel.width,
    top: placement.top,
    bottom: placement.top + panel.height,
  };
  const b = {
    left: region.x,
    right: region.x + region.width,
    top: region.y,
    bottom: region.y + region.height,
  };
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
