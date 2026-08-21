/**
 * Where the open menu's right edge goes, as an offset from the viewport's
 * right edge.
 *
 * ALIGN TO THE TRIGGER, BUT NEVER OFF THE SCREEN. Right-aligning to the
 * trigger is correct on a wide screen and wrong on a narrow one: `.wrapper`
 * stretches inside the card's layout - 277px on a 375px phone - while the 40px
 * trigger sits at its LEFT end, so a right-aligned 176px menu began 87px off
 * the left edge of the screen. Measured, and invisible at desktop widths,
 * where the trigger and the wrapper end at the same x.
 *
 * Extracted as a function because jsdom computes no layout: the component
 * cannot be tested for this, but the arithmetic can, and the arithmetic is
 * where the bug was.
 */
export function menuRightOffset(triggerRight: number, menuWidth: number, viewportWidth: number) {
  const MARGIN = 8;
  const alignedToTrigger = viewportWidth - triggerRight;
  // Keeping the menu on screen means keeping its LEFT edge at or past MARGIN,
  // which caps the offset at viewportWidth - menuWidth - MARGIN. The lower
  // bound keeps the RIGHT edge in, for a trigger near the screen's edge.
  const furthestLeft = viewportWidth - menuWidth - MARGIN;
  return Math.max(MARGIN, Math.min(alignedToTrigger, furthestLeft));
}

/**
 * Where the open menu's top edge goes, in viewport coordinates.
 *
 * THE MENU HAS TO BE ON THE SCREEN TO BE USED. The horizontal rule above was
 * added after half a menu hung off the left of a phone; this is the same bug
 * on the other axis, and a worse one. A menu is `position: fixed` and closes
 * on scroll, so one that opens below the fold cannot be scrolled to - it is
 * simply unreachable, and with it Rename, Duplicate, Move to and Delete.
 * Measured on a 375x812 screen: a trigger near the bottom of a folder list
 * put its menu at y=816..966, entirely past the bottom of the viewport.
 *
 * BELOW THE TRIGGER WHEN IT FITS, ABOVE IT WHEN IT DOES NOT. Flipping is what
 * a coach expects and keeps the menu attached to the control that opened it.
 * Only when neither side fits - a menu taller than the screen it is on - does
 * it fall back to sitting as high as it can and letting its own list scroll.
 */
export function menuTopOffset(
  triggerTop: number,
  triggerBottom: number,
  menuHeight: number,
  viewportHeight: number,
) {
  const MARGIN = 8;
  const GAP = 4;

  const below = triggerBottom + GAP;
  if (below + menuHeight + MARGIN <= viewportHeight) return below;

  const above = triggerTop - GAP - menuHeight;
  if (above >= MARGIN) return above;

  return Math.max(MARGIN, viewportHeight - menuHeight - MARGIN);
}
