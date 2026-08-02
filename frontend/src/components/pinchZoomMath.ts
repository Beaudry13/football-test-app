export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(scale: number, min: number = MIN_SCALE, max: number = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

/** Zooms `state` to `newScale`, keeping whatever content point currently sits under
 * `focalPoint` (both in the same local coordinate space, e.g. offsets from the gesture
 * surface's top-left corner) under that same point after the zoom - the standard
 * "zoom toward where the fingers/cursor are" behavior, not zoom-toward-origin. */
export function zoomAroundPoint(
  state: ZoomState,
  focalPoint: Point,
  newScale: number,
  min: number = MIN_SCALE,
  max: number = MAX_SCALE,
): ZoomState {
  const clamped = clampScale(newScale, min, max);
  const contentX = (focalPoint.x - state.x) / state.scale;
  const contentY = (focalPoint.y - state.y) / state.scale;
  return {
    scale: clamped,
    x: focalPoint.x - contentX * clamped,
    y: focalPoint.y - contentY * clamped,
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export const RESET_STATE: ZoomState = { scale: MIN_SCALE, x: 0, y: 0 };
