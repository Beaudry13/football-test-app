// The annotation canvas's internal pixel width doubles as the coordinate
// space every saved shape's x/y is relative to, so this can never just be
// bumped in place - that would shift every already-saved shape on every
// question that predates the change. LEGACY is frozen forever for images
// that don't carry their own pinned `canvas_width`; the bigger cap only
// applies to images that have never had a width pinned yet.
export const MAX_CANVAS_WIDTH_LEGACY = 900;
export const MAX_CANVAS_WIDTH = 1400;

/** The canvas width to size this image's coordinate space at. A pinned
 * `savedCanvasWidth` (from a prior save) always wins, so an already-annotated
 * image keeps rendering at the exact width its shapes were authored in. Only
 * an image with no pin AND no existing annotations - i.e. truly new - gets
 * the bigger cap; one with existing annotations but no pin predates the
 * `canvas_width` column entirely and must fall back to the legacy width. */
export function resolveCanvasWidth(
  savedCanvasWidth: number | null,
  hasExistingAnnotations: boolean,
): number {
  if (savedCanvasWidth != null) return savedCanvasWidth;
  return hasExistingAnnotations ? MAX_CANVAS_WIDTH_LEGACY : MAX_CANVAS_WIDTH;
}
