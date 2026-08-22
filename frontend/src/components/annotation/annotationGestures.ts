import { Point, type Canvas } from 'fabric';
import { panBy, zoomAtPoint } from './annotationViewport';

/**
 * Touch and stylus gestures for the annotation workspace.
 *
 * THE RULE, AND EVERYTHING ELSE FOLLOWS FROM IT:
 *
 *     ONE POINTER DRAWS.  TWO FINGERS MOVE THE VIEW.
 *
 * A finger has no hover, no right button and no modifier keys, so the number
 * of contacts is the only signal available - and it is enough. One finger or a
 * stylus is always drawing with whatever tool is selected; the moment a second
 * finger lands it stops being a drawing and becomes a pinch, and the stroke in
 * progress is abandoned rather than finished, so a coach who starts to draw
 * and then decides to reposition never leaves a stray mark behind.
 *
 * A STYLUS IS NEVER PART OF A GESTURE. `pointerType === 'pen'` is excluded
 * from the contact count entirely, so a palm resting on the glass cannot turn
 * a pen stroke into a pinch, and a pen cannot become the second finger of one.
 *
 * ZOOM AND PAN GO THROUGH THE SAME FUNCTIONS THE MOUSE USES. This file decides
 * WHEN, `annotationViewport` decides WHAT - so touch cannot drift away from
 * wheel and Space-drag, and there is one place where clamping and bounds live.
 * Nothing here touches an object, a coordinate or the serialized document.
 */

export interface TouchGestureOptions {
  /** The element gestures are read from. Must be an ANCESTOR of Fabric's own
   *  canvases so a capture-phase listener sees a touch before Fabric does. */
  element: HTMLElement;
  canvas: Canvas;
  /** Called after the viewport moves, so the zoom readout can follow. */
  onViewportChange: () => void;
  /** Throws away a half-drawn shape when a gesture takes over. */
  abortDraw: () => void;
}

interface Contact {
  x: number;
  y: number;
}

/**
 * Convert a client position into the canvas's own coordinate space.
 *
 * The workspace scales the canvas ELEMENT to fit (Phase 5C), so its CSS size
 * and its attribute size are different numbers. Fabric's viewport maths works
 * in attribute space, so every client coordinate has to be divided back
 * through that display scale or a pinch would zoom about the wrong place.
 */
function toCanvasPoint(canvas: Canvas, element: HTMLElement, clientX: number, clientY: number): Point {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width ? canvas.getWidth() / rect.width : 1;
  const scaleY = rect.height ? canvas.getHeight() / rect.height : 1;
  return new Point((clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY);
}

function centroid(contacts: Contact[]): Contact {
  const sum = contacts.reduce((acc, c) => ({ x: acc.x + c.x, y: acc.y + c.y }), { x: 0, y: 0 });
  return { x: sum.x / contacts.length, y: sum.y / contacts.length };
}

function spread(contacts: Contact[]): number {
  const [a, b] = contacts;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function attachTouchGestures({
  element,
  canvas,
  onViewportChange,
  abortDraw,
}: TouchGestureOptions): () => void {
  /** Finger contacts only - a pen never appears here, by design. */
  const contacts = new Map<number, Contact>();
  let gesturing = false;
  let lastSpread = 0;
  let lastCentre: Contact | null = null;
  /* WHICH FINGERS HAVE MOVED SINCE THE LAST TIME THE VIEW DID.
     Two fingers do not move in one event - the browser sends one pointermove
     per contact - so acting on the first of them compares a NEW position
     against the other finger's STALE one. A plain two-finger drag then reads
     as a spread change, and the view zooms when the coach only meant to move.
     Waiting until both have reported makes a drag a drag again. */
  const moved = new Set<number>();

  const isFinger = (event: PointerEvent) => event.pointerType === 'touch';

  function beginGestureIfReady() {
    if (gesturing || contacts.size < 2) return;
    gesturing = true;
    // The half-drawn line the first finger started is not what the coach is
    // asking for any more.
    abortDraw();
    const points = [...contacts.values()];
    lastSpread = spread(points);
    lastCentre = centroid(points);
    moved.clear();
  }

  function endGesture() {
    gesturing = false;
    lastSpread = 0;
    lastCentre = null;
    moved.clear();
  }

  function onPointerDown(event: PointerEvent) {
    if (!isFinger(event)) return;
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGestureIfReady();
    if (gesturing) {
      // Keep it away from Fabric entirely - a second finger is never drawing.
      event.stopPropagation();
      event.preventDefault();
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!isFinger(event) || !contacts.has(event.pointerId)) return;
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!gesturing) return;

    event.stopPropagation();
    event.preventDefault();

    moved.add(event.pointerId);
    if (moved.size < contacts.size) return;
    moved.clear();

    const points = [...contacts.values()];
    if (points.length < 2) return;

    const nextSpread = spread(points);
    const nextCentre = centroid(points);

    // PAN FIRST, THEN ZOOM ABOUT THE NEW CENTRE. Doing it the other way round
    // makes a two-finger drag that also drifts apart feel like it is fighting
    // itself, because the zoom anchor moves after the pan has been applied.
    if (lastCentre) {
      const rect = element.getBoundingClientRect();
      const scaleX = rect.width ? canvas.getWidth() / rect.width : 1;
      const scaleY = rect.height ? canvas.getHeight() / rect.height : 1;
      panBy(canvas, (nextCentre.x - lastCentre.x) * scaleX, (nextCentre.y - lastCentre.y) * scaleY);
    }

    if (lastSpread > 0 && nextSpread > 0) {
      const ratio = nextSpread / lastSpread;
      // A pinch that has barely moved is a two-finger drag, not a zoom.
      if (Math.abs(ratio - 1) > 0.01) {
        const anchor = toCanvasPoint(canvas, element, nextCentre.x, nextCentre.y);
        zoomAtPoint(canvas, anchor, canvas.getZoom() * ratio);
      }
    }

    lastSpread = nextSpread;
    lastCentre = nextCentre;
    canvas.requestRenderAll();
    onViewportChange();
  }

  function onPointerUp(event: PointerEvent) {
    if (!isFinger(event)) return;
    const wasGesturing = gesturing;
    contacts.delete(event.pointerId);
    if (contacts.size < 2) endGesture();
    if (wasGesturing) {
      /* Swallow the lift too. Without this, lifting one finger of a pinch
         hands Fabric a mouse:up it never saw a mouse:down for, and the tool
         reacts to a gesture the coach never meant as a click. */
      event.stopPropagation();
    }
    if (contacts.size >= 2) {
      // Still multi-touch (three fingers down to two): re-baseline so the
      // view does not jump.
      const points = [...contacts.values()];
      lastSpread = spread(points);
      lastCentre = centroid(points);
    }
  }

  // Capture phase: these run before Fabric's own listeners further down.
  const opts = { capture: true, passive: false } as const;
  element.addEventListener('pointerdown', onPointerDown, opts);
  element.addEventListener('pointermove', onPointerMove, opts);
  element.addEventListener('pointerup', onPointerUp, opts);
  element.addEventListener('pointercancel', onPointerUp, opts);

  return () => {
    element.removeEventListener('pointerdown', onPointerDown, opts);
    element.removeEventListener('pointermove', onPointerMove, opts);
    element.removeEventListener('pointerup', onPointerUp, opts);
    element.removeEventListener('pointercancel', onPointerUp, opts);
    contacts.clear();
    endGesture();
  };
}
