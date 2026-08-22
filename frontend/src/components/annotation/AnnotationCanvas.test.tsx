import { createRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Point, type Canvas } from 'fabric';
import { AnnotationCanvas, type AnnotationCanvasHandle } from './AnnotationCanvas';
import { clearClipboard } from './annotationClipboard';
import { resetRememberedStyle } from './styleMemory';

// jsdom never actually loads image resources, so an <img>'s `load` event
// never fires. History snapshots serialize the canvas background image to a
// data URL, and undo/redo's loadFromJSON re-enlivens it through Fabric's
// loadImage - which awaits exactly that never-firing event, hanging every
// restore forever under jsdom. Fire `load` asynchronously on src assignment
// (matching real-browser data-URL behavior) so restores can complete.
beforeAll(() => {
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

// AnnotationCanvas talks to the real network/Image element to load its
// background photo - replaced here with an instantly-resolving fake so tests
// don't depend on image decoding (unsupported in jsdom) or real network I/O.
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

// Driving Fabric's real mouse pipeline through synthetic jsdom DOM events is
// unreliable (it depends on getBoundingClientRect/viewport math jsdom
// doesn't fully implement). Instead, capture the real Canvas instance
// AnnotationCanvas constructs and drive it through Fabric's own public
// `fire()` - Fabric's documented way of emitting on its internal semantic
// event bus, the exact same bus `canvas.on('mouse:down', ...)` subscribes
// to - so this exercises the real component code, just skipping the DOM
// event translation layer that's flaky under jsdom specifically.
let capturedCanvas: Canvas | null = null;
vi.mock('fabric', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fabric')>();
  class CapturingCanvas extends actual.Canvas {
    constructor(...args: ConstructorParameters<typeof actual.Canvas>) {
      super(...args);
      capturedCanvas = this;
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
  // onReady firing is not the same as React having COMMITTED isReady, and the
  // keyboard listener attaches in an effect gated on it. Tests that click a
  // button first flush that commit by accident; a test that presses a key
  // straight away does not, and would silently observe a dead listener.
  await act(async () => {});
}

function clickAt(x: number, y: number) {
  act(() => {
    capturedCanvas!.fire('mouse:down', { scenePoint: new Point(x, y) } as never);
    capturedCanvas!.fire('mouse:up', { scenePoint: new Point(x, y) } as never);
  });
}

function dragFrom(from: [number, number], to: [number, number]) {
  act(() => {
    capturedCanvas!.fire('mouse:down', { scenePoint: new Point(...from) } as never);
    capturedCanvas!.fire('mouse:move', { scenePoint: new Point(...to) } as never);
    capturedCanvas!.fire('mouse:up', { scenePoint: new Point(...to) } as never);
  });
}

function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('AnnotationCanvas curve tool - undo does not resurrect cleared points', () => {
  it('reproduces the exact reported bug and proves it no longer happens', async () => {
    const { ref, onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);
    expect(capturedCanvas).toBeTruthy();

    fireEvent.click(getByTitle(/Curve/));

    // Coach clicks three points of a connected line.
    clickAt(10, 10);
    clickAt(50, 50);
    clickAt(90, 10);

    // getAnnotations() serializes via Fabric's toObject(), which reports
    // capitalized class-name type strings ('Polyline') - distinct from the
    // lowercase 'polyline' Fabric's live in-canvas objects report via
    // .type, used elsewhere in this file's canvas.getObjects() calls.
    expect(
      ref.current!.getAnnotations().find((a) => a.type === 'Polyline'),
    ).toBeTruthy();

    // Undo repeatedly until the in-progress preview visually disappears -
    // each click above was its own history snapshot before the fix (the bug
    // this test targets), so this clears all of them.
    for (let i = 0; i < 5; i += 1) {
      act(() => fireEvent.click(getByTitle('Undo')));
    }

    await waitFor(() => {
      const annotations = ref.current!.getAnnotations();
      expect(annotations.filter((a) => a.type === 'Polyline')).toHaveLength(0);
    });

    // The reported bug: clicking the image again after undoing the curve
    // away brings the old, already-undone segments back. A single new click
    // should start a brand-new curve with exactly one point, not resume the
    // stale point list from before the undos.
    clickAt(200, 200);

    const annotations = ref.current!.getAnnotations();
    const previews = annotations.filter((a) => a.type === 'Polyline');
    expect(previews).toHaveLength(1);
    const points = previews[0].points as { x: number; y: number }[];
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ x: 200, y: 200 });
  });

  it('does not resume a stale point list after switching tools mid-curve', async () => {
    const { ref, onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(/Curve/));
    clickAt(10, 10);
    clickAt(50, 50);

    // Abandon the curve by switching to another tool without finishing it
    // (no double-click) - the leftover points/preview must not survive.
    fireEvent.click(getByTitle('Select'));
    fireEvent.click(getByTitle(/Curve/));

    clickAt(300, 300);

    const annotations = ref.current!.getAnnotations();
    const previews = annotations.filter((a) => a.type === 'Polyline');
    expect(previews).toHaveLength(1);
    const points = previews[0].points as { x: number; y: number }[];
    expect(points).toHaveLength(1);
  });

  it('finishing a curve normally still records exactly one history-worthy action', async () => {
    const { ref, onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(/Curve/));
    clickAt(10, 10);
    clickAt(50, 50);
    clickAt(90, 10);
    act(() => capturedCanvas!.fire('mouse:dblclick', {} as never));

    const finished = ref.current!.getAnnotations();
    expect(finished.filter((a) => a.type === 'Polyline')).toHaveLength(0);
    expect(finished.filter((a) => a.type === 'Path')).toHaveLength(1);

    // A single undo removes the whole finished curve in one step, not one
    // click at a time - proving finalize collapsed the gesture to one snapshot.
    act(() => fireEvent.click(getByTitle('Undo')));
    await waitFor(() => {
      expect(ref.current!.getAnnotations().filter((a) => a.type === 'Path')).toHaveLength(0);
    });
  });

  it('abandons an in-progress curve on Escape without resurrecting it', async () => {
    const { ref, onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(/Curve/));
    clickAt(10, 10);
    clickAt(50, 50);

    expect(press('Escape').defaultPrevented).toBe(true);
    expect(ref.current!.getAnnotations().filter((a) => a.type === 'Polyline')).toHaveLength(0);

    fireEvent.click(getByTitle(/Curve/));
    clickAt(200, 200);

    const previews = ref.current!.getAnnotations().filter((a) => a.type === 'Polyline');
    expect(previews).toHaveLength(1);
    expect(previews[0].points).toHaveLength(1);
  });
});

describe('AnnotationCanvas toolbar memory', () => {
  afterEach(() => resetRememberedStyle());

  it('carries the last-used settings onto the next image the coach opens', async () => {
    const first = renderCanvas();
    await waitForReady(first.onReady);

    fireEvent.click(first.getByTitle('#2a9d8f'));
    fireEvent.click(first.getByTitle('Text label'));
    fireEvent.click(first.getByLabelText('Bold'));

    // A different image remounts AnnotationCanvas entirely (see the `key` in
    // AnnotationPage) - the toolbar must not snap back to the defaults.
    first.unmount();
    const second = renderCanvas();
    await waitForReady(second.onReady);

    const teal = second.getByTitle('#2a9d8f');
    expect(teal.className).toMatch(/swatchActive/);
    fireEvent.click(second.getByTitle('Text label'));
    expect((second.getByLabelText('Bold') as HTMLInputElement).checked).toBe(false);
  });
});

describe('AnnotationCanvas keyboard shortcuts', () => {
  afterEach(() => clearClipboard());

  async function renderWithOneLine() {
    const utils = renderCanvas();
    await waitForReady(utils.onReady);
    fireEvent.click(utils.getByTitle('Line'));
    dragFrom([20, 20], [120, 90]);
    return utils;
  }

  it('copies and pastes the selected annotation, offset and auto-selected', async () => {
    const { ref } = await renderWithOneLine();

    const [original] = ref.current!.getAnnotations();
    expect(original).toBeTruthy();
    act(() => {
      capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]);
    });

    expect(press('c', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press('v', { ctrlKey: true }).defaultPrevented).toBe(true);

    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(2));

    const [first, copy] = ref.current!.getAnnotations();
    expect(copy.type).toBe(first.type);
    // Offset so the copy is visibly a separate shape...
    expect(copy.left).toBeGreaterThan(first.left as number);
    expect(copy.top).toBeGreaterThan(first.top as number);
    // ...with its own id, and selected so it can be dragged straight away.
    expect(copy.id).not.toBe(first.id);
    expect(capturedCanvas!.getActiveObject()?.get('id')).toBe(copy.id);
  });

  it('preserves colour, end caps and endpoint tagging through a copy', async () => {
    const { ref, onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    fireEvent.click(getByTitle('#2a9d8f'));
    dragFrom([20, 20], [140, 20]);

    act(() => capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]));
    press('c', { ctrlKey: true });
    press('v', { ctrlKey: true });

    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(2));
    const [original, copy] = ref.current!.getAnnotations();
    expect(copy.endCap).toBe('arrow');
    expect(copy.startCap).toBe(original.startCap);
    expect(copy.hasEditableEndpoints).toBe(true);
    // Endpoint tagging must travel with the copy, offset to match it - or its
    // drag handles would still grab at the original's position.
    expect((copy.segStart as { x: number }).x).toBeGreaterThan(
      (original.segStart as { x: number }).x,
    );
  });

  it('does nothing on paste when nothing has been copied', async () => {
    const { ref } = await renderWithOneLine();
    expect(press('v', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(ref.current!.getAnnotations()).toHaveLength(1);
  });

  it('deletes the selected annotation on Delete, and undo brings it back', async () => {
    const { ref, getByTitle } = await renderWithOneLine();
    act(() => capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]));

    expect(press('Delete').defaultPrevented).toBe(true);
    expect(ref.current!.getAnnotations()).toHaveLength(0);

    act(() => fireEvent.click(getByTitle('Undo')));
    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(1));
  });

  it('clears the selection on Escape', async () => {
    await renderWithOneLine();
    act(() => capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]));

    expect(press('Escape').defaultPrevented).toBe(true);
    expect(capturedCanvas!.getActiveObject()).toBeFalsy();
  });

  it('leaves annotations alone when the coach is typing in a quiz text field', async () => {
    const { ref } = await renderWithOneLine();
    act(() => capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]));

    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(press('Backspace', {}, input).defaultPrevented).toBe(false);
    expect(press('c', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press('z', { ctrlKey: true }, input).defaultPrevented).toBe(false);

    expect(ref.current!.getAnnotations()).toHaveLength(1);
    input.remove();
  });

  it('does not bank empty undo steps just for selecting a line', async () => {
    // Selecting a line draws two endpoint markers on the canvas. They are
    // decorations, never saved - but they used to land in history anyway, so
    // the first undo after selecting something appeared to do nothing.
    const { ref } = await renderWithOneLine();
    act(() => capturedCanvas!.setActiveObject(capturedCanvas!.getObjects()[0]));
    act(() => capturedCanvas!.discardActiveObject());

    press('z', { ctrlKey: true });
    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(0));
  });

  it('undoes and redoes with the keyboard', async () => {
    const { ref } = await renderWithOneLine();
    expect(ref.current!.getAnnotations()).toHaveLength(1);

    press('z', { ctrlKey: true });
    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(0));

    press('z', { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(ref.current!.getAnnotations()).toHaveLength(1));
  });
});

describe('sticky tools - a coach picks a tool once and keeps drawing', () => {
  type ByTitle = (id: string | RegExp) => HTMLElement;
  const isActive = (byTitle: ByTitle, label: string | RegExp) =>
    byTitle(label).className.includes('Active');

  it.each(['Line', 'Arrow', 'Rectangle', 'Circle / Ellipse'])(
    'stays on %s after drawing one, and draws a second',
    async (label) => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(label));
    dragFrom([10, 10], [80, 80]);
    const afterFirst = capturedCanvas!.getObjects().length;
    expect(isActive(getByTitle, label)).toBe(true);

    // The point of the phase: the SECOND shape costs no extra clicks.
    dragFrom([100, 100], [170, 170]);
    expect(capturedCanvas!.getObjects().length).toBeGreaterThan(afterFirst);
    expect(isActive(getByTitle, label)).toBe(true);
    },
  );

  it('stays on Route after a route is finished, ready for the next one', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle(/Curve/));
    clickAt(10, 10);
    clickAt(50, 40);
    clickAt(90, 10);
    act(() => capturedCanvas!.fire('mouse:dblclick', {} as never));

    expect(isActive(getByTitle, /Curve/)).toBe(true);
  });

  it('RETURNS TO SELECT after a text label, which is the one exception', async () => {
    // Creating a label immediately opens it for typing. Staying on Text would
    // mean the click that commits the edit lands on the canvas and stamps a
    // SECOND empty label - the accidental-duplicate hazard sticky tools are
    // otherwise free of.
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Text label'));
    clickAt(40, 40);

    expect(isActive(getByTitle, 'Select')).toBe(true);
    expect(isActive(getByTitle, 'Text label')).toBe(false);
  });

  it('Escape leaves a sticky tool and lands on Select', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    fireEvent.click(getByTitle('Arrow'));
    expect(isActive(getByTitle, 'Arrow')).toBe(true);

    press('Escape');
    expect(isActive(getByTitle, 'Select')).toBe(true);
  });

  it('switches tools from the keyboard alone', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    press('l');
    expect(isActive(getByTitle, 'Line')).toBe(true);
    press('a');
    expect(isActive(getByTitle, 'Arrow')).toBe(true);
    press('r');
    expect(isActive(getByTitle, /Curve/)).toBe(true);
    press('o');
    expect(isActive(getByTitle, 'Circle / Ellipse')).toBe(true);
    press('v');
    expect(isActive(getByTitle, 'Select')).toBe(true);
  });

  it('does not switch tools while the coach is typing in a quiz field', async () => {
    const { onReady, getByTitle } = renderCanvas();
    await waitForReady(onReady);

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    press('a', {}, field);
    press('t', {}, field);
    expect(isActive(getByTitle, 'Select')).toBe(true);
    field.remove();
  });

  it('SAVES THE SAME DATA a non-sticky editor would have saved', async () => {
    // The invariant for this phase: tool selection is interface state and must
    // never reach the serialized annotation. Two lines drawn with a sticky
    // tool must be byte-identical to two drawn by re-picking the tool between
    // them.
    const first = renderCanvas();
    const getByTitle = first.getByTitle;
    await waitForReady(first.onReady);
    fireEvent.click(getByTitle('Line'));
    dragFrom([10, 10], [80, 80]);
    dragFrom([100, 100], [170, 170]);
    const withoutIds = (layers: unknown[]) =>
      JSON.stringify(layers.map((l) => ({ ...(l as Record<string, unknown>), id: undefined })));
    const sticky = withoutIds(first.ref.current!.getAnnotations());
    first.unmount();

    const second = renderCanvas();
    const getByTitle2 = second.getByTitle;
    await waitForReady(second.onReady);
    fireEvent.click(getByTitle('Line'));
    dragFrom([10, 10], [80, 80]);
    fireEvent.click(getByTitle('Select'));
    fireEvent.click(getByTitle2('Line'));
    dragFrom([100, 100], [170, 170]);
    const rePicked = withoutIds(second.ref.current!.getAnnotations());

    expect(sticky).toEqual(rePicked);
  });
});
