import { Point, type Canvas } from 'fabric';

/**
 * Zoom and pan for the annotation canvas — a VIEWPORT OVER the saved
 * coordinate space, never a change to it.
 *
 * WHY THIS CANNOT MOVE AN ANNOTATION. Fabric keeps a `viewportTransform`, an
 * affine matrix applied when the scene is drawn and when a pointer is mapped
 * back into it. It is not a property of any object: an object's left/top stay
 * exactly what they were, and `canvas.toObject(...).objects` — the only thing
 * AnnotationCanvas saves — never carries the matrix. So the coordinate space
 * pinned by `question_images.canvas_width` is untouched by anything in here,
 * by construction rather than by care.
 *
 * The same reasoning is why drawing stays accurate while zoomed. Fabric
 * derives a pointer's `scenePoint` as
 *
 *     sendPointToPlane(viewportPoint, undefined, viewportTransform)
 *
 * i.e. the screen position mapped back THROUGH the inverse of the viewport.
 * Every handler in AnnotationCanvas already draws from `scenePoint`, so a line
 * drawn at 4x lands on the same scene coordinates it would have at 1x, with no
 * arithmetic of our own.
 *
 * ONE THING DOES NOT COME FOR FREE: a distance compared in scene units shrinks
 * on screen as you zoom out. See `sceneHitRadius`.
 *
 * Kept as plain functions over a Canvas so the touch gestures in a later phase
 * drive the same operations rather than growing a second implementation.
 */

/** Far enough out to see a whole playbook page, far enough in to place an
 *  endpoint on one player's helmet. Past 8x a 1400px-wide coordinate space is
 *  showing individual source pixels, and below 0.25x the image is smaller than
 *  the toolbar beside it - both ends stop being useful before they stop being
 *  possible, which is where a limit belongs. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

/** Zoom steps for the on-screen buttons. A fixed ratio rather than a fixed
 *  amount, so every press feels the same at every scale. */
export const ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zoom about a fixed point, so whatever is under the pointer stays under it.
 *
 * Anchoring to the pointer rather than the canvas centre is most of what makes
 * zoom feel like a magnifying glass instead of a slider - a coach points at
 * the flat defender and zooms, rather than zooming and then hunting.
 */
export function zoomAtPoint(canvas: Canvas, point: Point, nextZoom: number): number {
  const clamped = clampZoom(nextZoom);
  canvas.zoomToPoint(point, clamped);
  clampPan(canvas);
  return canvas.getZoom();
}

/** Zoom by a ratio about a point - what a wheel notch and a +/- button do. */
export function zoomByStep(canvas: Canvas, point: Point, factor: number): number {
  return zoomAtPoint(canvas, point, canvas.getZoom() * factor);
}

/** Move the viewport by a screen-space delta. */
export function panBy(canvas: Canvas, dx: number, dy: number): void {
  canvas.relativePan(new Point(dx, dy));
  clampPan(canvas);
}

/**
 * The whole image, centred: zoom 1 and no translation.
 *
 * "Fit" is identity here rather than a computed ratio because the canvas's
 * backing store IS the coordinate space - `setDimensions` is given the
 * prescaled image's own width and height - so at zoom 1 the image already
 * exactly fills it. The element is then CSS-scaled to whatever room the page
 * gives it, which is a separate concern this must not touch.
 */
export function fitView(canvas: Canvas): void {
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.requestRenderAll();
}

/**
 * Keep the image from being dragged off into empty space.
 *
 * Zoomed IN, the visible window is smaller than the scene, so panning is
 * bounded by the scene's edges. Zoomed OUT, the whole scene is smaller than
 * the window and there is nothing to pan to - so it is pinned centred, which
 * is less irritating than letting a coach lose the image entirely and have to
 * find Fit.
 */
export function clampPan(canvas: Canvas): void {
  const vpt = canvas.viewportTransform;
  if (!vpt) return;
  const zoom = canvas.getZoom();
  const sceneW = canvas.getWidth() * zoom;
  const sceneH = canvas.getHeight() * zoom;
  const viewW = canvas.getWidth();
  const viewH = canvas.getHeight();

  vpt[4] = sceneW <= viewW ? (viewW - sceneW) / 2 : Math.min(0, Math.max(viewW - sceneW, vpt[4]));
  vpt[5] = sceneH <= viewH ? (viewH - sceneH) / 2 : Math.min(0, Math.max(viewH - sceneH, vpt[5]));
  canvas.setViewportTransform(vpt);
}

/**
 * A hit radius that stays the same size to a fingertip at any zoom.
 *
 * THE BUG THIS EXISTS FOR. Endpoint grabbing compares distances between
 * `scenePoint`s, so its radius is in SCENE units. Zoomed to 0.25x, a 14-unit
 * radius is three and a half pixels on screen - an endpoint a coach cannot
 * reliably hit. Zoomed to 4x it is fifty-six, and neighbouring endpoints
 * start stealing each other's grabs.
 *
 * Dividing by the zoom converts a constant SCREEN radius into the scene
 * distance that currently represents it, so the target stays the size it is
 * today at 1x and stays that size everywhere else.
 */
export function sceneHitRadius(screenRadius: number, zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return screenRadius;
  return screenRadius / zoom;
}
