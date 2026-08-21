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
