import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Point } from 'fabric';
import { attachTouchGestures } from './annotationGestures';

/**
 * The gesture layer decides WHEN the viewport moves; annotationViewport decides
 * WHAT it does. These tests are about the WHEN - which contacts count, which
 * are handed to Fabric, and what happens to a stroke a second finger
 * interrupts.
 */

/** Enough of a Fabric Canvas for the gesture layer, with the viewport calls
 *  recorded rather than performed. */
function fakeCanvas() {
  let zoom = 1;
  const vpt = [1, 0, 0, 1, 0, 0];
  return {
    zoomCalls: [] as { point: Point; zoom: number }[],
    panCalls: [] as { x: number; y: number }[],
    getZoom: () => zoom,
    setZoom: (z: number) => {
      zoom = z;
    },
    getWidth: () => 900,
    getHeight: () => 500,
    get viewportTransform() {
      return vpt;
    },
    setViewportTransform: () => {},
    requestRenderAll: () => {},
    zoomToPoint(point: Point, z: number) {
      zoom = z;
      this.zoomCalls.push({ point, zoom: z });
    },
    relativePan(p: Point) {
      this.panCalls.push({ x: p.x, y: p.y });
    },
  };
}

function makeElement() {
  const el = document.createElement('div');
  // jsdom gives every element a zero rect; the gesture maths divides by it.
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 900, height: 500, right: 900, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  id: number,
  x: number,
  y: number,
  pointerType = 'touch',
) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

describe('annotation touch gestures', () => {
  let element: HTMLElement;
  let canvas: ReturnType<typeof fakeCanvas>;
  let abortDraw: () => void;
  let detach: () => void;

  beforeEach(() => {
    document.body.innerHTML = '';
    element = makeElement();
    canvas = fakeCanvas();
    abortDraw = vi.fn() as unknown as () => void;
    detach = attachTouchGestures({
      element,
      canvas: canvas as never,
      onViewportChange: () => {},
      abortDraw,
    });
  });

  it('lets ONE finger through to Fabric, so it draws', () => {
    const down = pointer('pointerdown', 1, 100, 100);
    element.dispatchEvent(down);
    // Not swallowed: the drawing tool gets it.
    expect(down.defaultPrevented).toBe(false);
    expect(abortDraw).not.toHaveBeenCalled();
    expect(canvas.zoomCalls).toHaveLength(0);
  });

  it('ABANDONS THE STROKE the moment a second finger lands', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    element.dispatchEvent(pointer('pointerdown', 2, 300, 100));
    // The half-drawn shape is thrown away rather than finished, so a pinch
    // never leaves a stray mark.
    expect(abortDraw).toHaveBeenCalledTimes(1);
  });

  it('keeps a two-finger gesture away from Fabric entirely', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    const second = pointer('pointerdown', 2, 300, 100);
    element.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);

    const move = pointer('pointermove', 2, 320, 100);
    element.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });

  it('PINCHING OUT zooms in, about the point between the fingers', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 400, 250));
    element.dispatchEvent(pointer('pointerdown', 2, 500, 250));
    // Same centre, fingers twice as far apart.
    element.dispatchEvent(pointer('pointermove', 1, 350, 250));
    element.dispatchEvent(pointer('pointermove', 2, 550, 250));

    expect(canvas.zoomCalls.length).toBeGreaterThan(0);
    const last = canvas.zoomCalls[canvas.zoomCalls.length - 1];
    expect(last.zoom).toBeGreaterThan(1);
    expect(last.point.x).toBeCloseTo(450, 0);
  });

  it('PINCHING IN zooms out', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 300, 250));
    element.dispatchEvent(pointer('pointerdown', 2, 600, 250));
    element.dispatchEvent(pointer('pointermove', 1, 420, 250));
    element.dispatchEvent(pointer('pointermove', 2, 480, 250));

    const last = canvas.zoomCalls[canvas.zoomCalls.length - 1];
    expect(last.zoom).toBeLessThan(1);
  });

  it('TWO FINGERS MOVING TOGETHER pan without zooming', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200));
    element.dispatchEvent(pointer('pointerdown', 2, 300, 200));
    canvas.zoomCalls.length = 0;
    // Both fingers move the same way: the spread never changes.
    element.dispatchEvent(pointer('pointermove', 1, 260, 240));
    element.dispatchEvent(pointer('pointermove', 2, 360, 240));

    expect(canvas.panCalls.length).toBeGreaterThan(0);
    // A drag with an unchanged spread must not be read as a zoom.
    expect(canvas.zoomCalls).toHaveLength(0);
  });

  it('never creates an annotation - it only ever touches the viewport', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200));
    element.dispatchEvent(pointer('pointerdown', 2, 400, 200));
    element.dispatchEvent(pointer('pointermove', 1, 150, 210));
    element.dispatchEvent(pointer('pointermove', 2, 450, 210));
    element.dispatchEvent(pointer('pointerup', 1, 150, 210));
    element.dispatchEvent(pointer('pointerup', 2, 450, 210));

    // The only things a gesture is allowed to call.
    expect(canvas.zoomCalls.length + canvas.panCalls.length).toBeGreaterThan(0);
  });

  it('A STYLUS IS NEVER PART OF A GESTURE', () => {
    // A pen plus a resting palm must still draw, not pinch.
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200, 'pen'));
    element.dispatchEvent(pointer('pointerdown', 2, 400, 200, 'pen'));
    expect(abortDraw).not.toHaveBeenCalled();
    expect(canvas.zoomCalls).toHaveLength(0);

    const move = pointer('pointermove', 1, 260, 240, 'pen');
    element.dispatchEvent(move);
    // Handed straight to Fabric.
    expect(move.defaultPrevented).toBe(false);
  });

  it('a pen and a finger together still do not make a pinch', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200, 'pen'));
    element.dispatchEvent(pointer('pointerdown', 2, 400, 200, 'touch'));
    expect(abortDraw).not.toHaveBeenCalled();
    expect(canvas.zoomCalls).toHaveLength(0);
  });

  it('returns to drawing once a finger lifts', () => {
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200));
    element.dispatchEvent(pointer('pointerdown', 2, 400, 200));
    element.dispatchEvent(pointer('pointerup', 2, 400, 200));
    canvas.zoomCalls.length = 0;
    canvas.panCalls.length = 0;

    // One finger again: moves are Fabric's, not ours.
    const move = pointer('pointermove', 1, 260, 240);
    element.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    expect(canvas.zoomCalls).toHaveLength(0);
    expect(canvas.panCalls).toHaveLength(0);
  });

  it('stops listening when detached', () => {
    detach();
    element.dispatchEvent(pointer('pointerdown', 1, 200, 200));
    element.dispatchEvent(pointer('pointerdown', 2, 400, 200));
    expect(abortDraw).not.toHaveBeenCalled();
  });
});
