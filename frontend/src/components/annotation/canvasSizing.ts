// The annotation canvas's internal pixel width doubles as the coordinate
// space every saved shape's x/y is relative to, so this can never just be
// bumped in place - that would shift every already-saved shape on every
// question that predates the change. LEGACY is frozen forever for images
// that don't carry their own pinned `canvas_width`; the bigger cap only
// applies to images that have never had a width pinned yet.
export const MAX_CANVAS_WIDTH_LEGACY = 900;
export const MAX_CANVAS_WIDTH = 1400;

// Purely a rendering-resolution multiplier for the player-facing read-only viewer - NOT the
// coordinate space (that stays resolveCanvasWidth()'s output, below, untouched, so existing
// annotation positions never shift). Bumps how much real photo detail survives into the canvas
// backing store, so pinch-zooming in AnnotationViewer/ImageLightbox stays crisp instead of
// upscaling a source that was already shrunk down to the coordinate-space width.
export const PLAYER_RENDER_SCALE = 2;

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

/** The coordinate space annotation shapes were *actually* authored in, which can be smaller than
 * `capWidth` (resolveCanvasWidth's output) when the source photo's real resolution is smaller -
 * the editor's own loadPrescaledImage call would have capped at naturalWidth too, so shapes drawn
 * there are positioned relative to naturalWidth, not capWidth, regardless of what got saved as
 * `canvas_width`. Math.min means this can never exceed capWidth, so a normal photo (naturalWidth
 * >= capWidth) is unaffected - this only kicks in for the smaller-than-cap case, and self-corrects
 * any already-saved mismatch without a data migration, since it's derived from the photo file's
 * real dimensions rather than trusted metadata. */
export function resolveTrueCapWidth(capWidth: number, naturalWidth: number): number {
  return Math.min(capWidth, naturalWidth);
}
