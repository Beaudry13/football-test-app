/** Pointer arbitration for the Draw on Image board: decides, from the raw
 * stream of pointer events, whether the player is drawing, pinching, or
 * panning - and critically, whether a stroke that has already begun should
 * be thrown away because a second finger arrived.
 *
 * Pure and synchronous on purpose (same discipline as pinchZoomMath.ts):
 * every decision is a function of the previous state plus one event, with
 * no Fabric, no DOM and no React in scope, so the hardest interaction logic
 * in the feature can be unit-tested exhaustively instead of only being
 * testable by hand on a phone.
 *
 * The problem it solves
 * ---------------------
 * A player pinching to zoom does not land both fingers at the same instant -
 * the second arrives roughly 30-80ms after the first. A naive "one finger
 * draws" rule therefore paints a stray dash at the start of every single
 * pinch gesture. The fix is to not commit a stroke immediately: buffer the
 * first pointer, and only promote it to a real stroke once it has either
 * survived a grace window or moved far enough to be unambiguous. If a
 * second pointer shows up first, the buffered points are discarded and
 * nothing was ever drawn.
 *
 * Per the product decision, one finger ALWAYS draws (there is a dedicated
 * Pan tool instead of intent-guessing), so single-finger pan only exists
 * while the Pan tool is selected.
 */

export type Tool = 'pen' | 'eraser' | 'pan';

export interface GesturePoint {
  id: number;
  x: number;
  y: number;
}

export type GesturePhase =
  /** Nothing touching the surface. */
  | { kind: 'idle' }
  /** One pointer down, but not yet committed to being a stroke - see the
   *  module docstring. Points are buffered so a promoted stroke starts from
   *  the real first touch rather than from wherever the finger had moved to. */
  | { kind: 'pending'; pointerId: number; startedAt: number; origin: GesturePoint; buffer: GesturePoint[] }
  /** A committed stroke. Points now flow to the brush. */
  | { kind: 'drawing'; pointerId: number }
  /** Two pointers: pinch to zoom, and drag the midpoint to pan. */
  | { kind: 'pinch'; pointerIds: [number, number]; startDistance: number; startScale: number }
  /** Single-finger pan, only reachable with the Pan tool selected. */
  | { kind: 'panning'; pointerId: number; last: GesturePoint };

export interface GestureConfig {
  /** How long a lone pointer must survive before it counts as a stroke.
   *  Long enough to cover the gap between two fingers landing, short enough
   *  that a deliberate stroke doesn't feel laggy. */
  graceMs: number;
  /** Movement that promotes a pending pointer to a stroke immediately,
   *  regardless of the grace window - a fast deliberate stroke should not
   *  wait. Must exceed the jitter of a stationary finger. */
  commitDistancePx: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  graceMs: 120,
  commitDistancePx: 6,
};

/** What the caller should do as a result of the event just processed.
 *  Deliberately data, not callbacks, so tests assert on plain values. */
export interface GestureEffect {
  /** Begin a brush stroke at these scene points (the buffered origin first). */
  beginStroke?: GesturePoint[];
  /** Extend the live stroke to this point. */
  extendStroke?: GesturePoint;
  /** Finish and commit the live stroke. */
  endStroke?: boolean;
  /** Throw away the in-progress stroke without committing it. Fires when a
   *  second finger arrives after a stroke was already promoted. */
  abortStroke?: boolean;
  /** Erase whatever stroke sits under this point (whole-stroke deletion). */
  eraseAt?: GesturePoint;
  /** Apply this zoom scale, focused on this point. */
  zoomTo?: { scale: number; focal: GesturePoint };
  /** Pan by this delta. */
  panBy?: { dx: number; dy: number };
  /** A pinch discarded a pending stroke before it was ever drawn. Counted
   *  by the spike harness: if this number is healthy and `abortStroke`
   *  stays near zero on real hardware, arbitration is working. */
  discardedPending?: boolean;
}

export interface GestureState {
  phase: GesturePhase;
  pointers: Map<number, GesturePoint>;
}

export function initialGestureState(): GestureState {
  return { phase: { kind: 'idle' }, pointers: new Map() };
}

function distance(a: GesturePoint, b: GesturePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: GesturePoint, b: GesturePoint): GesturePoint {
  return { id: -1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function twoPointers(state: GestureState): [GesturePoint, GesturePoint] | null {
  const list = Array.from(state.pointers.values());
  return list.length >= 2 ? [list[0], list[1]] : null;
}

export function pointerDown(
  state: GestureState,
  point: GesturePoint,
  tool: Tool,
  now: number,
  currentScale: number,
  config: GestureConfig = DEFAULT_GESTURE_CONFIG,
): { state: GestureState; effect: GestureEffect } {
  void config;
  const pointers = new Map(state.pointers);
  pointers.set(point.id, point);
  const effect: GestureEffect = {};

  // A second finger always wins over drawing - it means "zoom", never "draw
  // two lines". Anything the first finger had started is undone here: a
  // committed stroke is aborted, a merely-pending one is silently dropped.
  if (pointers.size >= 2) {
    if (state.phase.kind === 'drawing') effect.abortStroke = true;
    if (state.phase.kind === 'pending') effect.discardedPending = true;

    const pair = twoPointers({ phase: state.phase, pointers });
    if (pair) {
      return {
        state: {
          pointers,
          phase: {
            kind: 'pinch',
            pointerIds: [pair[0].id, pair[1].id],
            startDistance: distance(pair[0], pair[1]),
            startScale: currentScale,
          },
        },
        effect,
      };
    }
  }

  if (tool === 'pan') {
    return { state: { pointers, phase: { kind: 'panning', pointerId: point.id, last: point } }, effect };
  }

  if (tool === 'eraser') {
    // Erasing is immediate and per-point; there is no stroke to arbitrate,
    // and a stray erase tap during a pinch is prevented by the size check
    // above rather than by a grace window.
    effect.eraseAt = point;
    return { state: { pointers, phase: { kind: 'drawing', pointerId: point.id } }, effect };
  }

  return {
    state: {
      pointers,
      phase: { kind: 'pending', pointerId: point.id, startedAt: now, origin: point, buffer: [point] },
    },
    effect,
  };
}

export function pointerMove(
  state: GestureState,
  point: GesturePoint,
  tool: Tool,
  now: number,
  config: GestureConfig = DEFAULT_GESTURE_CONFIG,
): { state: GestureState; effect: GestureEffect } {
  if (!state.pointers.has(point.id)) return { state, effect: {} };

  const pointers = new Map(state.pointers);
  pointers.set(point.id, point);
  const phase = state.phase;
  const effect: GestureEffect = {};

  if (phase.kind === 'pinch') {
    const p1 = pointers.get(phase.pointerIds[0]);
    const p2 = pointers.get(phase.pointerIds[1]);
    if (!p1 || !p2) return { state: { pointers, phase }, effect };
    const previous1 = state.pointers.get(phase.pointerIds[0])!;
    const previous2 = state.pointers.get(phase.pointerIds[1])!;

    const scale = phase.startScale * (distance(p1, p2) / phase.startDistance);
    effect.zoomTo = { scale, focal: midpoint(p1, p2) };

    // Two-finger drag pans at the same time as the pinch scales - matching
    // the platform behaviour players already expect from photo viewers.
    const before = midpoint(previous1, previous2);
    const after = midpoint(p1, p2);
    if (before.x !== after.x || before.y !== after.y) {
      effect.panBy = { dx: after.x - before.x, dy: after.y - before.y };
    }
    return { state: { pointers, phase }, effect };
  }

  if (phase.kind === 'panning' && phase.pointerId === point.id) {
    effect.panBy = { dx: point.x - phase.last.x, dy: point.y - phase.last.y };
    return { state: { pointers, phase: { ...phase, last: point } }, effect };
  }

  if (phase.kind === 'pending' && phase.pointerId === point.id) {
    const buffer = [...phase.buffer, point];
    const movedFar = distance(phase.origin, point) >= config.commitDistancePx;
    const survivedGrace = now - phase.startedAt >= config.graceMs;

    if (movedFar || survivedGrace) {
      // Promote. The whole buffer is replayed so the committed stroke
      // starts at the true first touch, not at the promotion point -
      // otherwise every stroke would be missing its first few millimetres.
      effect.beginStroke = buffer;
      return { state: { pointers, phase: { kind: 'drawing', pointerId: point.id } }, effect };
    }
    return { state: { pointers, phase: { ...phase, buffer } }, effect };
  }

  if (phase.kind === 'drawing' && phase.pointerId === point.id) {
    if (tool === 'eraser') effect.eraseAt = point;
    else effect.extendStroke = point;
    return { state: { pointers, phase }, effect };
  }

  return { state: { pointers, phase }, effect };
}

export function pointerUp(
  state: GestureState,
  pointerId: number,
  tool: Tool,
): { state: GestureState; effect: GestureEffect } {
  const pointers = new Map(state.pointers);
  pointers.delete(pointerId);
  const phase = state.phase;
  const effect: GestureEffect = {};

  if (phase.kind === 'drawing' && phase.pointerId === pointerId) {
    if (tool !== 'eraser') effect.endStroke = true;
  }

  if (phase.kind === 'pending' && phase.pointerId === pointerId) {
    // Lifted before promotion: a tap, not a stroke. With the pen this is a
    // deliberate dot, so commit the buffered origin rather than losing it.
    if (tool === 'pen') {
      effect.beginStroke = phase.buffer;
      effect.endStroke = true;
    }
  }

  // Re-derive from the pointers that are actually still down rather than
  // adjusting the existing phase - the same "never patch incrementally"
  // rule PinchZoomPan.reanchor() follows, for the same reason: a finger
  // lifting out of a pinch must not leave a stale baseline behind.
  const remaining = Array.from(pointers.values());
  if (remaining.length === 0) {
    return { state: { pointers, phase: { kind: 'idle' } }, effect };
  }
  if (remaining.length === 1 && tool === 'pan') {
    return { state: { pointers, phase: { kind: 'panning', pointerId: remaining[0].id, last: remaining[0] } }, effect };
  }
  // One finger left after a pinch does NOT resume drawing - the player is
  // still mid-gesture and would otherwise get a stray mark on lift-off.
  return { state: { pointers, phase: { kind: 'idle' } }, effect };
}
