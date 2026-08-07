/** Device-aware canvas sizing.
 *
 * Canvas backing-store memory is the single most likely way this feature
 * crashes a phone. iOS Safari kills a tab that allocates too much canvas
 * memory, and it does so without a catchable error - the page simply
 * reloads, taking the player's in-progress answer with it.
 *
 * The naive sizing is `devicePixelRatio x full source resolution`. On a
 * DPR-3 phone with a 4000px-wide photo that is a 12000px-wide backing store,
 * and Fabric allocates TWO of them (the committed lower canvas and the
 * in-progress upper canvas the brush draws on). That is instant death.
 *
 * So: the logical coordinate space stays fixed (see types.ts - it must, or
 * strokes move), and only the render scale flexes per device, under a hard
 * cap on total backing pixels.
 */

/** Fabric maintains a lower canvas (committed objects) and an upper canvas
 * (the brush's live stroke). Both are full size, so every memory estimate
 * doubles. Missing this factor is how a "safe" number turns out not to be. */
export const FABRIC_CANVAS_LAYERS = 2;

const BYTES_PER_PIXEL = 4;

/** Ceiling on backing-store pixels per canvas layer.
 *
 * ~4.2M px/layer = 8.4M px across both = ~33MB of backing store, which
 * leaves headroom under the several-hundred-MB budget older iPhones enforce
 * once the decoded source image and the page itself are accounted for.
 * Expressed as an area rather than a dimension so tall and wide photos are
 * treated alike. */
export const MAX_BACKING_PIXELS_PER_LAYER = 4_200_000;

/** Even on a DPR-3 device, render scale stops here.
 *
 * The prior spike landed on ~1.5x for a DPR-2 phone viewport. Past that,
 * added sharpness on a photograph under a 6px pen stroke is not perceptible,
 * while memory grows with the square. Recomputed on real hardware during the
 * gate rather than trusted from a desk. */
export const MAX_RENDER_SCALE = 1.5;
export const MIN_RENDER_SCALE = 0.75;

export interface RenderScaleInput {
  /** The on-screen size of the board in CSS pixels.
   *
   * Deliberately the viewport, NOT the image's coordinate space. The canvas
   * is a window onto the scene, not a copy of it: a 4000px-wide photo viewed
   * on a 390px phone needs 390 CSS px of canvas, and allocating 4000 would
   * spend memory on pixels that are never on screen. Zooming in shows more
   * detail by changing the viewportTransform, not by growing the backing
   * store. */
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  /** Optional override from the spike HUD so a tester can sweep values on a
   * real phone without a rebuild. */
  requestedScale?: number;
}

export interface RenderScaleResult {
  scale: number;
  backingWidth: number;
  backingHeight: number;
  /** Both Fabric layers combined. */
  estimatedBytes: number;
  /** True when MAX_BACKING_PIXELS_PER_LAYER, not DPR, decided the scale -
   * surfaced in the HUD because it means this device is running below its
   * display's capability and the image may look soft. */
  cappedByMemory: boolean;
}

export function resolveRenderScale({
  viewportWidth,
  viewportHeight,
  devicePixelRatio,
  requestedScale,
}: RenderScaleInput): RenderScaleResult {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const desired = clamp(requestedScale ?? dpr, MIN_RENDER_SCALE, MAX_RENDER_SCALE);

  const area = Math.max(1, viewportWidth * viewportHeight);
  // Scale enters the area quadratically, so the memory-safe ceiling is the
  // square root of the pixel-budget ratio.
  const memoryCeiling = Math.sqrt(MAX_BACKING_PIXELS_PER_LAYER / area);
  // The memory ceiling is applied AFTER the floor, and is allowed to win.
  // MIN_RENDER_SCALE is a floor on the DPR-derived scale (don't render a
  // phone's board softer than necessary), not a licence to exceed the pixel
  // budget: an unusually tall panorama can need less than the floor, and a
  // soft image is recoverable where a killed tab - taking the player's
  // in-progress answer with it - is not.
  const scale = Math.min(desired, memoryCeiling);

  const backingWidth = Math.round(viewportWidth * scale);
  const backingHeight = Math.round(viewportHeight * scale);

  return {
    scale,
    backingWidth,
    backingHeight,
    estimatedBytes: estimateCanvasBytes(backingWidth, backingHeight),
    cappedByMemory: memoryCeiling < desired,
  };
}

export function estimateCanvasBytes(backingWidth: number, backingHeight: number): number {
  return backingWidth * backingHeight * BYTES_PER_PIXEL * FABRIC_CANVAS_LAYERS;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fits the coordinate space inside the overlay viewport, which is what the
 * board zooms out to on open and returns to on Reset View. Pure so it can be
 * asserted without a DOM. */
export function fitScale(
  coordinateWidth: number,
  coordinateHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (coordinateWidth <= 0 || coordinateHeight <= 0) return 1;
  return Math.min(viewportWidth / coordinateWidth, viewportHeight / coordinateHeight);
}

export interface ContainFit {
  /** Scene units per CSS pixel - the zoom a person perceives. Comparisons
   * and clamps belong in this space, never in backing space. */
  cssZoom: number;
  /** What Fabric's viewportTransform takes. Backing space, because
   * canvas.width IS the backing width, so the transform is measured in
   * device pixels whether or not anyone intends it to be. */
  zoom: number;
  /** Backing-space translation that centres the image. */
  offsetX: number;
  offsetY: number;
}

/** Contain-style fit: the WHOLE image visible, centred, aspect preserved.
 *
 * Derived from the CSS viewport and the render scale as two explicit inputs
 * rather than from `canvas.getWidth()`. Both routes give the same answer while
 * backing === css x renderScale, but reading the backing store hides which
 * space a number is in - and mixing the two is what put the board's initial
 * view in the wrong place on a phone. Keeping the CSS box and the scale
 * separate makes the unit of every value in here obvious, and lets a test
 * assert that DPR changes the backing store without changing the fit.
 *
 * Returns an identity-ish fit for a zero-sized viewport: a board mounted
 * before layout settles (iOS resolves dvh only after the URL bar does) must
 * not produce a NaN or zero transform that later maths then propagates.
 */
export function containFit(
  coordinateWidth: number,
  coordinateHeight: number,
  cssWidth: number,
  cssHeight: number,
  renderScale: number,
): ContainFit {
  if (coordinateWidth <= 0 || coordinateHeight <= 0 || cssWidth <= 0 || cssHeight <= 0) {
    return { cssZoom: 1, zoom: renderScale > 0 ? renderScale : 1, offsetX: 0, offsetY: 0 };
  }

  // min(), not max(): contain, not cover. max() would fill the viewport by
  // cropping the image, which for a film still means hiding the part of the
  // play the question is about.
  const cssZoom = Math.min(cssWidth / coordinateWidth, cssHeight / coordinateHeight);
  const zoom = cssZoom * renderScale;

  const backingWidth = cssWidth * renderScale;
  const backingHeight = cssHeight * renderScale;
  return {
    cssZoom,
    zoom,
    offsetX: (backingWidth - coordinateWidth * zoom) / 2,
    offsetY: (backingHeight - coordinateHeight * zoom) / 2,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
