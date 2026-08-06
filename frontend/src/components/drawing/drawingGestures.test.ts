import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GESTURE_CONFIG,
  initialGestureState,
  pointerDown,
  pointerMove,
  pointerUp,
  type GesturePoint,
  type GestureState,
} from './drawingGestures';

const p = (id: number, x: number, y: number): GesturePoint => ({ id, x, y });

/** Drives a sequence of events through the machine, collecting every effect -
 * the arbitration bugs that matter are all about what happens ACROSS several
 * events, not within one. */
function run(
  steps: Array<
    | { down: GesturePoint; at?: number; tool?: 'pen' | 'eraser' | 'pan'; scale?: number }
    | { move: GesturePoint; at?: number; tool?: 'pen' | 'eraser' | 'pan' }
    | { up: number; tool?: 'pen' | 'eraser' | 'pan' }
  >,
) {
  let state: GestureState = initialGestureState();
  const effects = [];
  for (const step of steps) {
    if ('down' in step) {
      const r = pointerDown(state, step.down, step.tool ?? 'pen', step.at ?? 0, step.scale ?? 1);
      state = r.state;
      effects.push(r.effect);
    } else if ('move' in step) {
      const r = pointerMove(state, step.move, step.tool ?? 'pen', step.at ?? 0);
      state = r.state;
      effects.push(r.effect);
    } else {
      const r = pointerUp(state, step.up, step.tool ?? 'pen');
      state = r.state;
      effects.push(r.effect);
    }
  }
  return { state, effects };
}

describe('the two-finger race (the reason this module exists)', () => {
  it('paints nothing when a second finger arrives during the grace window', () => {
    // The exact real-world sequence: finger 1 lands, drifts a hair, finger 2
    // lands 40ms later. A naive implementation draws a stray dash here.
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0 },
      { move: p(1, 101, 100), at: 20 },
      { down: p(2, 200, 200), at: 40 },
    ]);

    expect(effects.some((e) => e.beginStroke)).toBe(false);
    expect(effects.some((e) => e.abortStroke)).toBe(false); // nothing to abort - never committed
    expect(effects.at(-1)?.discardedPending).toBe(true);
    expect(state.phase.kind).toBe('pinch');
  });

  it('aborts an already-committed stroke if a second finger still arrives', () => {
    // Slower pinch: finger 1 survived the grace window and became a real
    // stroke before finger 2 landed. The stroke must be removed, not kept.
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0 },
      { move: p(1, 130, 100), at: 30 }, // moved far -> promoted immediately
      { down: p(2, 300, 300), at: 200 },
    ]);

    expect(effects.some((e) => e.beginStroke)).toBe(true);
    expect(effects.at(-1)?.abortStroke).toBe(true);
    expect(state.phase.kind).toBe('pinch');
  });

  it('does not resume drawing when one finger lifts out of a pinch', () => {
    // Lifting one finger mid-pinch must not hand control back to the pen,
    // or the player gets a stray mark every time they finish zooming.
    const { state, effects } = run([
      { down: p(1, 100, 100), at: 0 },
      { down: p(2, 200, 200), at: 20 },
      { move: p(2, 260, 260), at: 60 },
      { up: 2 },
    ]);

    expect(state.phase.kind).toBe('idle');
    expect(effects.some((e) => e.beginStroke)).toBe(false);
  });
});

describe('promoting a pending pointer to a real stroke', () => {
  it('promotes on distance, before the grace window elapses', () => {
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0 },
      { move: p(1, 100 + DEFAULT_GESTURE_CONFIG.commitDistancePx, 100), at: 10 },
    ]);

    expect(effects.at(-1)?.beginStroke).toBeTruthy();
    expect(state.phase.kind).toBe('drawing');
  });

  it('promotes on time, for a slow deliberate stroke that barely moves', () => {
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0 },
      { move: p(1, 101, 101), at: DEFAULT_GESTURE_CONFIG.graceMs + 1 },
    ]);

    expect(effects.at(-1)?.beginStroke).toBeTruthy();
    expect(state.phase.kind).toBe('drawing');
  });

  it('replays the whole buffer so the stroke starts at the true first touch', () => {
    // Without this, every stroke silently loses its first few millimetres -
    // subtle enough to ship, and very annoying to draw with.
    const { effects } = run([
      { down: p(1, 100, 100), at: 0 },
      { move: p(1, 102, 100), at: 10 },
      { move: p(1, 104, 100), at: 20 },
      { move: p(1, 110, 100), at: 30 }, // promotes here
    ]);

    const begin = effects.find((e) => e.beginStroke)?.beginStroke;
    expect(begin?.[0]).toMatchObject({ x: 100, y: 100 });
    expect(begin?.length).toBe(4);
  });

  it('commits a tap as a dot rather than losing it', () => {
    const { effects } = run([{ down: p(1, 50, 50), at: 0 }, { up: 1 }]);

    expect(effects.at(-1)?.beginStroke).toBeTruthy();
    expect(effects.at(-1)?.endStroke).toBe(true);
  });
});

describe('pinch zoom and two-finger pan', () => {
  it('scales relative to the distance the fingers started at', () => {
    const { effects } = run([
      { down: p(1, 100, 100), at: 0, scale: 1 },
      { down: p(2, 200, 100), at: 10, scale: 1 }, // 100px apart
      { move: p(2, 300, 100), at: 30 }, // now 200px apart -> 2x
    ]);

    expect(effects.at(-1)?.zoomTo?.scale).toBeCloseTo(2);
  });

  it('zooms around the midpoint of the two fingers, not the origin', () => {
    const { effects } = run([
      { down: p(1, 100, 100), at: 0 },
      { down: p(2, 300, 100), at: 10 },
      { move: p(2, 400, 100), at: 30 },
    ]);

    expect(effects.at(-1)?.zoomTo?.focal).toMatchObject({ x: 250, y: 100 });
  });

  it('pans by the movement of the midpoint while pinching', () => {
    const { effects } = run([
      { down: p(1, 100, 100), at: 0 },
      { down: p(2, 200, 100), at: 10 },
      { move: p(1, 150, 140), at: 30 }, // midpoint moves right and down
    ]);

    expect(effects.at(-1)?.panBy).toBeTruthy();
    expect(effects.at(-1)?.panBy!.dx).toBeCloseTo(25);
    expect(effects.at(-1)?.panBy!.dy).toBeCloseTo(20);
  });
});

describe('the dedicated Pan tool (one finger always draws with the pen)', () => {
  it('pans with a single finger when the pan tool is selected', () => {
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0, tool: 'pan' },
      { move: p(1, 140, 130), at: 20, tool: 'pan' },
    ]);

    expect(state.phase.kind).toBe('panning');
    expect(effects.at(-1)?.panBy).toMatchObject({ dx: 40, dy: 30 });
    expect(effects.some((e) => e.beginStroke)).toBe(false);
  });

  it('never single-finger pans with the pen, even zoomed in', () => {
    // The product decision: no intent-guessing. Zoomed to 3x, one finger
    // still draws.
    const { effects, state } = run([
      { down: p(1, 100, 100), at: 0, scale: 3 },
      { move: p(1, 160, 100), at: 20 },
    ]);

    expect(state.phase.kind).toBe('drawing');
    expect(effects.some((e) => e.panBy)).toBe(false);
  });
});

describe('whole-stroke eraser', () => {
  it('erases immediately on touch and keeps erasing while dragging', () => {
    const { effects } = run([
      { down: p(1, 100, 100), at: 0, tool: 'eraser' },
      { move: p(1, 120, 100), at: 20, tool: 'eraser' },
    ]);

    expect(effects[0].eraseAt).toMatchObject({ x: 100, y: 100 });
    expect(effects[1].eraseAt).toMatchObject({ x: 120, y: 100 });
    expect(effects.some((e) => e.beginStroke)).toBe(false);
  });

  it('does not emit endStroke, since erasing commits nothing', () => {
    const { effects } = run([
      { down: p(1, 100, 100), at: 0, tool: 'eraser' },
      { up: 1, tool: 'eraser' },
    ]);

    expect(effects.some((e) => e.endStroke)).toBe(false);
  });
});

describe('robustness against out-of-order and stray events', () => {
  it('ignores a move for a pointer that was never pressed', () => {
    const { effects } = run([{ move: p(99, 10, 10), at: 0 }]);
    expect(effects[0]).toEqual({});
  });

  it('returns to idle when every pointer lifts', () => {
    const { state } = run([
      { down: p(1, 100, 100), at: 0 },
      { down: p(2, 200, 200), at: 10 },
      { up: 1 },
      { up: 2 },
    ]);
    expect(state.phase.kind).toBe('idle');
    expect(state.pointers.size).toBe(0);
  });

  it('survives a third finger landing mid-pinch without losing the gesture', () => {
    const { state } = run([
      { down: p(1, 100, 100), at: 0 },
      { down: p(2, 200, 100), at: 10 },
      { down: p(3, 300, 100), at: 20 },
    ]);
    expect(state.phase.kind).toBe('pinch');
    expect(state.pointers.size).toBe(3);
  });
});
