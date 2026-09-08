import { createRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Point, type Canvas, type FabricObject } from 'fabric';
import { AnnotationCanvas, type AnnotationCanvasHandle } from './AnnotationCanvas';

/** MOVING AN ANNOTATION MUST NEVER DRAW A NEW ONE.
 *
 * THE REPORTED BUG, and why it only happened sometimes. The tool effect swept
 * `selectable:false, evented:false` over every object when the tool CHANGED -
 * a snapshot of what existed at that instant. Shape factories set neither
 * flag, so anything created afterwards kept Fabric's defaults and stayed
 * grabbable. With sticky tools the effect does not re-run between shapes, so
 * the NEWEST annotation - exactly the one a coach reaches for to nudge into
 * place - was the only object still offering to be dragged while Arrow was
 * active. Fabric painted selection handles on it, the coach dragged, and
 * mouse:down drew a second arrow because it never looked at `opt.target`.
 *
 * Older annotations had already been swept inert, which is why this read as
 * "a new annotation CAN be created" rather than always.
 *
 * The invariant these tests hold: a drawing tool owns the canvas and nothing
 * on it competes for the drag; Select owns nothing and manipulates everything.
 */

beforeAll(() => {
  // jsdom never loads image resources, so an <img>'s `load` never fires and
  // Fabric's re-enliven of the background hangs. Same shim as the main suite.
  const proto = window.HTMLImageElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'src')!;
  Object.defineProperty(proto, 'src', {
    get() {
      return desc.get!.call(this);
    },
    set(value: string) {
      desc.set!.call(this, value);
      if (value) setTimeout(() => this.dispatchEvent(new Event('load')), 0);
    },
  });
});

vi.mock('./imageLoading', () => ({
  loadPrescaledImage: vi.fn(async () => ({
    canvas: (() => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      return c;
    })(),
    width: 400,
    height: 300,
    naturalWidth: 400,
  })),
}));

let capturedCanvas: Canvas | null = null;
vi.mock('fabric', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fabric')>();
  class CapturingCanvas extends actual.Canvas {
    constructor(...args: ConstructorParameters<typeof actual.Canvas>) {
      super(...args);
      // Handed to a static rather than assigned straight to the module
      // variable: aliasing `this` is an oxlint warning, and the sibling suite
      // already carries that one - no reason to add a second.
      CapturingCanvas.capture(this);
    }
    static capture(instance: Canvas) {
      capturedCanvas = instance;
    }
  }
  return { ...actual, Canvas: CapturingCanvas };
});

function renderCanvas() {
  const ref = createRef<AnnotationCanvasHandle>();
  const onReady = vi.fn();
  const utils = render(
    <AnnotationCanvas
      ref={ref}
      imageUrl="https://example.com/fake.jpg"
      initialAnnotations={[]}
      savedCanvasWidth={null}
      onReady={onReady}
    />,
  );
  return { ref, onReady, ...utils };
}

async function waitForReady(onReady: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  await act(async () => {});
}

/** A drag over empty canvas - Fabric reports no target. */
function dragFrom(from: [number, number], to: [number, number]) {
  act(() => {
    capturedCanvas!.fire('mouse:down', { scenePoint: new Point(...from) } as never);
    capturedCanvas!.fire('mouse:move', { scenePoint: new Point(...to) } as never);
    capturedCanvas!.fire('mouse:up', { scenePoint: new Point(...to) } as never);
  });
}

/** A drag that GRABBED something. Fabric only populates `target` for an object
 *  that answers the pointer, so passing it models the state the bug depended
 *  on - and is the only way to exercise the safety net now that the
 *  normalisation makes real targets impossible under a drawing tool. */
function dragOn(target: FabricObject, from: [number, number], to: [number, number]) {
  act(() => {
    capturedCanvas!.fire('mouse:down', { scenePoint: new Point(...from), target } as never);
    capturedCanvas!.fire('mouse:move', { scenePoint: new Point(...to) } as never);
    capturedCanvas!.fire('mouse:up', { scenePoint: new Point(...to) } as never);
  });
}

const drawn = () => capturedCanvas!.getObjects();

describe('the reported regression: drag an annotation, get a second one', () => {
  it('dragging the shape just drawn does NOT create another', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    dragFrom([10, 10], [80, 80]);
    const afterFirst = drawn().length;
    expect(afterFirst).toBe(1);

    // The coach now reaches for the arrow they just drew, still on Arrow.
    // Before the fix this arrived carrying a target and drew a second arrow.
    dragOn(drawn()[0], [40, 40], [120, 120]);

    expect(drawn()).toHaveLength(afterFirst);
  });

  it('the freshly drawn shape is inert while a drawing tool is active', async () => {
    // THE ACTUAL FIX, asserted directly rather than through its symptom. This
    // is what makes the drag above never carry a target in a real browser -
    // and it is what stops Fabric promising a move it will not perform by
    // painting selection handles on the shape.
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    dragFrom([10, 10], [80, 80]);

    const shape = drawn()[0];
    expect(shape.selectable).toBe(false);
    expect(shape.evented).toBe(false);
  });

  it('every drawing tool leaves its new shape inert, not just Arrow', async () => {
    for (const label of ['Line', 'Rectangle', 'Circle / Ellipse']) {
      const { onReady, getByTitle, unmount } = renderCanvas();
      await waitForReady(onReady);

      fireEvent.click(getByTitle(label));
      dragFrom([10, 10], [80, 80]);

      const shape = drawn()[drawn().length - 1];
      expect(shape.evented, `${label} left its shape grabbable`).toBe(false);
      unmount();
    }
  });

  it('a finished Route is inert too, since Route stays sticky', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(/Curve/));
    act(() => {
      capturedCanvas!.fire('mouse:down', { scenePoint: new Point(10, 10) } as never);
      capturedCanvas!.fire('mouse:up', { scenePoint: new Point(10, 10) } as never);
      capturedCanvas!.fire('mouse:down', { scenePoint: new Point(50, 40) } as never);
      capturedCanvas!.fire('mouse:up', { scenePoint: new Point(50, 40) } as never);
      capturedCanvas!.fire('mouse:dblclick', {} as never);
    });

    const path = drawn()[drawn().length - 1];
    expect(path.evented).toBe(false);
  });
});

describe('what the fix must NOT have cost', () => {
  it('a coach can still draw a new shape starting ON TOP of an existing one', async () => {
    /* THE CASE A NAIVE `if (opt.target) return;` WOULD HAVE BROKEN. An arrow
       out of a circled safety is ordinary football diagramming, and it starts
       exactly where another annotation already is. It works because the
       existing shape is inert under a drawing tool, so the drag carries no
       target at all - the guard never sees one. */
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Circle / Ellipse'));
    dragFrom([10, 10], [90, 90]);
    expect(drawn()).toHaveLength(1);

    fireEvent.click(getByTitle('Arrow'));
    // Starting inside the circle's bounds, on purpose.
    dragFrom([40, 40], [200, 200]);

    expect(drawn()).toHaveLength(2);
  });

  it('SELECT moves an existing annotation and creates nothing', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    dragFrom([10, 10], [80, 80]);
    expect(drawn()).toHaveLength(1);

    fireEvent.click(getByTitle(/Select/));
    // Switching to Select hands the objects back - that is the whole contract.
    expect(drawn()[0].selectable).toBe(true);
    expect(drawn()[0].evented).toBe(true);

    dragOn(drawn()[0], [40, 40], [120, 120]);
    expect(drawn()).toHaveLength(1);
  });

  it('Space-drag pans and creates nothing', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }),
      );
    });

    act(() => {
      capturedCanvas!.fire('mouse:down', {
        scenePoint: new Point(10, 10),
        e: { clientX: 10, clientY: 10 },
      } as never);
      capturedCanvas!.fire('mouse:move', {
        scenePoint: new Point(90, 90),
        e: { clientX: 90, clientY: 90 },
      } as never);
      capturedCanvas!.fire('mouse:up', { scenePoint: new Point(90, 90) } as never);
    });

    expect(drawn()).toHaveLength(0);
  });

  it('a two-finger gesture creates nothing', async () => {
    /* Touch pan/zoom is handled in annotationGestures, which aborts a
       half-drawn shape the moment a second contact lands. Asserted here at the
       canvas level because "pan never creates" is a rule about the drawing,
       not about which module implements it. */
    const { onReady, getByTitle, container } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    const surface = container.querySelector('canvas')!.parentElement!;

    act(() => {
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 10,
          clientY: 10,
          bubbles: true,
        }),
      );
      surface.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 2,
          pointerType: 'touch',
          clientX: 90,
          clientY: 90,
          bubbles: true,
        }),
      );
      surface.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 2,
          pointerType: 'touch',
          clientX: 140,
          clientY: 140,
          bubbles: true,
        }),
      );
    });

    expect(drawn()).toHaveLength(0);
  });
});
