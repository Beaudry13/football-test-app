import { describe, expect, it } from 'vitest';
import { DEFAULT_ARBITER_CONFIG, GestureArbiter, type ArbiterCommand } from './gestureArbiter';

const GRACE = DEFAULT_ARBITER_CONFIG.graceMs;

function down(arbiter: GestureArbiter, id: number, x: number, y: number, t: number) {
  return arbiter.pointerDown({ id, x, y, t });
}
function move(arbiter: GestureArbiter, id: number, x: number, y: number, t: number) {
  return arbiter.pointerMove({ id, x, y, t });
}
function up(arbiter: GestureArbiter, id: number, x: number, y: number, t: number) {
  return arbiter.pointerUp({ id, x, y, t });
}

function types(commands: ArbiterCommand[]): string[] {
  return commands.map((c) => c.type);
}

/** Every command a sequence produced, flattened - most assertions care about
 * "did a stroke ever begin", not which call returned it. */
function drive(steps: Array<() => ArbiterCommand[]>): ArbiterCommand[] {
  return steps.flatMap((step) => step());
}

function beginPoints(commands: ArbiterCommand[]) {
  return commands.filter((c): c is Extract<ArbiterCommand, { type: 'strokeBegin' }> => c.type === 'strokeBegin');
}

describe('GestureArbiter - single-finger drawing', () => {
  it('does not draw anything during the grace window', () => {
    const arbiter = new GestureArbiter();
    expect(types(down(arbiter, 1, 10, 10, 0))).toEqual([]);
    expect(types(move(arbiter, 1, 12, 12, 10))).toEqual([]);
    expect(arbiter.getState()).toBe('pending');
  });

  it('commits the stroke once the grace window expires', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    const commands = move(arbiter, 1, 20, 20, GRACE + 1);
    // Two buffered samples: the touch-down and the move that crossed the
    // deadline. Both are replayed, the first as the stroke's origin.
    expect(types(commands)).toEqual(['strokeBegin', 'strokeExtend']);
    expect(arbiter.getState()).toBe('drawing');
  });

  it('replays the stroke from the TRUE first touch point, not the commit point', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 200, 0);
    move(arbiter, 1, 104, 205, 20);
    move(arbiter, 1, 110, 210, 40);
    const commands = move(arbiter, 1, 120, 220, GRACE + 1);

    // The stroke must start where the finger landed. Starting at the commit
    // point is the "stroke lags several millimeters behind the finger" bug.
    expect(beginPoints(commands)[0].point).toMatchObject({ x: 100, y: 200 });
    // And no buffered sample may be lost in the replay.
    const extended = commands.filter((c) => c.type === 'strokeExtend');
    expect(extended).toHaveLength(3);
  });

  it('commits when the finger holds still and only the clock advances', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    expect(types(arbiter.tick(GRACE - 1))).toEqual([]);
    expect(types(arbiter.tick(GRACE + 1))).toEqual(['strokeBegin']);
    expect(arbiter.getState()).toBe('drawing');
  });

  it('extends a committed stroke on subsequent moves', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    expect(types(move(arbiter, 1, 30, 30, GRACE + 20))).toEqual(['strokeExtend']);
  });

  it('ends the stroke on pointerup and returns to idle', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    expect(types(up(arbiter, 1, 10, 10, GRACE + 50))).toEqual(['strokeEnd']);
    expect(arbiter.getState()).toBe('idle');
    expect(arbiter.getPointerCount()).toBe(0);
  });

  it('treats a very short tap as a deliberate dot rather than eating it', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 50, 50, 0);
    const commands = up(arbiter, 1, 50, 50, 10);
    expect(types(commands)).toEqual(['strokeBegin', 'strokeEnd']);
    expect(beginPoints(commands)[0].point).toMatchObject({ x: 50, y: 50 });
  });

  it('keeps every sample of a very fast stroke', () => {
    const arbiter = new GestureArbiter();
    const commands = drive([
      () => down(arbiter, 1, 0, 0, 0),
      () => move(arbiter, 1, 40, 5, 8),
      () => move(arbiter, 1, 90, 12, 16),
      () => move(arbiter, 1, 150, 20, 24),
      () => move(arbiter, 1, 220, 30, GRACE + 2),
      () => up(arbiter, 1, 220, 30, GRACE + 10),
    ]);
    const points = commands.filter((c) => c.type === 'strokeBegin' || c.type === 'strokeExtend');
    expect(points).toHaveLength(5);
    expect(beginPoints(commands)[0].point).toMatchObject({ x: 0, y: 0 });
  });
});

describe('GestureArbiter - the two-finger race', () => {
  it('discards the pending stroke when a second finger arrives in the window', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    move(arbiter, 1, 103, 101, 20);
    const commands = down(arbiter, 2, 200, 200, 45);

    expect(types(commands)).toEqual(['strokeDiscard']);
    expect(arbiter.getState()).toBe('pinch');
    expect(arbiter.getMetrics().discardedBySecondPointer).toBe(1);
  });

  it('records NO stroke at all across a full pinch gesture', () => {
    const arbiter = new GestureArbiter();
    const commands = drive([
      () => down(arbiter, 1, 100, 100, 0),
      () => move(arbiter, 1, 102, 100, 15),
      () => down(arbiter, 2, 300, 300, 40),
      () => move(arbiter, 1, 90, 90, 60),
      () => move(arbiter, 2, 320, 320, 70),
      () => up(arbiter, 1, 90, 90, 200),
      () => up(arbiter, 2, 320, 320, 220),
    ]);

    // The assertion this whole module exists to satisfy.
    expect(types(commands)).not.toContain('strokeBegin');
    expect(arbiter.getState()).toBe('idle');
  });

  it('holds the stroke through the full 30-80ms second-finger spread', () => {
    for (const delay of [30, 40, 50, 59]) {
      const arbiter = new GestureArbiter();
      down(arbiter, 1, 100, 100, 0);
      move(arbiter, 1, 101, 100, delay - 5);
      const commands = down(arbiter, 2, 300, 300, delay);
      expect(types(commands), `second finger at ${delay}ms`).toEqual(['strokeDiscard']);
    }
  });

  it('finalizes (does not discard) a stroke the player genuinely drew before the second finger', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    arbiter.tick(GRACE + 1);
    move(arbiter, 1, 150, 150, 200);
    const commands = down(arbiter, 2, 300, 300, 400);

    // Past the window with real movement, this is a real stroke - throwing it
    // away would lose the player's work.
    expect(types(commands)).toEqual(['strokeEnd']);
    expect(arbiter.getState()).toBe('pinch');
    expect(arbiter.getMetrics().suspectedStrays).toBe(0);
  });

  it('flags a barely-committed stroke interrupted by a second finger as a suspected stray', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    arbiter.tick(GRACE + 1);
    const commands = down(arbiter, 2, 300, 300, GRACE + 20);

    expect(types(commands)).toEqual(['strokeEnd']);
    // Committed, immediately interrupted, almost no points: the signature of
    // a grace window that is too short for this device.
    expect(arbiter.getMetrics().suspectedStrays).toBe(1);
  });
});

describe('GestureArbiter - pinch zoom and two-finger pan', () => {
  it('emits a scale factor matching the change in finger distance', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 0, 0, 0);
    down(arbiter, 2, 100, 0, 20);
    move(arbiter, 2, 200, 0, 40);
    const commands = arbiter.tick(40);

    const transform = commands.find((c) => c.type === 'transform');
    expect(transform).toBeDefined();
    expect(transform).toMatchObject({ scaleBy: 2 });
  });

  it('holds the transform until the frame tick rather than emitting per move', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 0, 0, 0);
    down(arbiter, 2, 100, 0, 20);
    expect(types(move(arbiter, 2, 200, 0, 40))).toEqual([]);
    expect(types(arbiter.tick(40))).toEqual(['transform']);
    // Nothing further until a finger moves again.
    expect(types(arbiter.tick(56))).toEqual([]);
  });

  it('zooms about the midpoint of the two fingers', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 0, 0, 0);
    down(arbiter, 2, 100, 100, 20);
    move(arbiter, 2, 200, 200, 40);
    const commands = arbiter.tick(40);

    const transform = commands.find((c) => c.type === 'transform');
    expect(transform && transform.type === 'transform' && transform.focal).toMatchObject({ x: 100, y: 100 });
  });

  it('translates a two-finger pan with no scale wobble from sequential events', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    down(arbiter, 2, 200, 100, 20);
    // Both fingers translate by (+30, +40), but as two separate events - the
    // exact pattern that produced a 1.24x phantom zoom before coalescing.
    move(arbiter, 1, 130, 140, 40);
    move(arbiter, 2, 230, 140, 41);
    const commands = arbiter.tick(48);

    const transform = commands.find((c) => c.type === 'transform');
    expect(transform).toMatchObject({ scaleBy: 1, panBy: { x: 30, y: 40 } });
  });

  it('ignores the scale factor when the fingers are too close to be a reliable pinch', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    down(arbiter, 2, 104, 100, 20); // 4px apart - jitter would produce wild ratios
    move(arbiter, 2, 112, 100, 40);
    const commands = arbiter.tick(40);

    const transform = commands.find((c) => c.type === 'transform');
    expect(transform).toMatchObject({ scaleBy: 1 });
  });

  it('does not let the finger left behind after a pinch start a new stroke', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    down(arbiter, 2, 300, 300, 30);
    up(arbiter, 2, 300, 300, 300);

    expect(arbiter.getState()).toBe('blocked');
    // The remaining finger keeps moving - this must stay silent.
    expect(types(move(arbiter, 1, 150, 150, 320))).toEqual([]);
    expect(types(arbiter.tick(1000))).toEqual([]);

    up(arbiter, 1, 150, 150, 400);
    expect(arbiter.getState()).toBe('idle');
  });

  it('stays blocked when a third finger lands mid-gesture', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    down(arbiter, 2, 300, 300, 30);
    up(arbiter, 1, 100, 100, 200);
    expect(arbiter.getState()).toBe('blocked');

    expect(types(down(arbiter, 3, 50, 50, 220))).toEqual([]);
    expect(arbiter.getState()).toBe('blocked');
  });
});

describe('GestureArbiter - pan tool', () => {
  it('pans with one finger and never draws', () => {
    const arbiter = new GestureArbiter();
    arbiter.setTool('pan');
    expect(types(down(arbiter, 1, 100, 100, 0))).toEqual([]);

    const commands = move(arbiter, 1, 130, 90, 40);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'pan', by: { x: 30, y: -10 } });
  });

  it('measures each pan delta against the previous position, not the origin', () => {
    const arbiter = new GestureArbiter();
    arbiter.setTool('pan');
    down(arbiter, 1, 0, 0, 0);
    move(arbiter, 1, 10, 0, 10);
    const commands = move(arbiter, 1, 25, 0, 20);
    expect(commands[0]).toMatchObject({ type: 'pan', by: { x: 15, y: 0 } });
  });

  it('still pinches with two fingers while the pan tool is active', () => {
    const arbiter = new GestureArbiter();
    arbiter.setTool('pan');
    down(arbiter, 1, 0, 0, 0);
    down(arbiter, 2, 100, 0, 20);
    expect(arbiter.getState()).toBe('pinch');
    move(arbiter, 2, 200, 0, 40);
    expect(arbiter.tick(40).find((c) => c.type === 'transform')).toMatchObject({ scaleBy: 2 });
  });

  it('abandons an in-flight pen stroke when the tool changes mid-stroke', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    expect(types(arbiter.setTool('pan'))).toEqual(['strokeAbort']);
  });

  it('discards a pending buffer when the tool changes before commitment', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    expect(types(arbiter.setTool('eraser'))).toEqual(['strokeDiscard']);
  });
});

describe('GestureArbiter - eraser', () => {
  it('emits a whole-stroke erase at the touch point', () => {
    const arbiter = new GestureArbiter();
    arbiter.setTool('eraser');
    const commands = down(arbiter, 1, 120, 140, 0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'eraseAt', point: { x: 120, y: 140 } });
  });

  it('never begins a stroke while erasing', () => {
    const arbiter = new GestureArbiter();
    arbiter.setTool('eraser');
    const commands = drive([
      () => down(arbiter, 1, 120, 140, 0),
      () => move(arbiter, 1, 130, 150, 100),
      () => arbiter.tick(500),
      () => up(arbiter, 1, 130, 150, 200),
    ]);
    expect(types(commands)).toEqual(['eraseAt']);
    expect(arbiter.getState()).toBe('idle');
  });
});

describe('GestureArbiter - interruptions and malformed event streams', () => {
  it('discards a pending stroke on pointercancel', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    const commands = arbiter.pointerCancel({ id: 1, x: 10, y: 10, t: 20 });
    expect(types(commands)).toEqual(['strokeDiscard']);
    expect(arbiter.getState()).toBe('idle');
  });

  it('aborts (does not finalize) a committed stroke on pointercancel', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    const commands = arbiter.pointerCancel({ id: 1, x: 10, y: 10, t: 300 });
    expect(types(commands)).toEqual(['strokeAbort']);
    expect(arbiter.getMetrics().strokesCommitted).toBe(0);
  });

  it('ignores a move for a pointer that was never down', () => {
    const arbiter = new GestureArbiter();
    expect(types(move(arbiter, 99, 10, 10, 0))).toEqual([]);
    expect(arbiter.getState()).toBe('idle');
  });

  it('ignores an up for a pointer that was never down', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    expect(types(up(arbiter, 99, 0, 0, 10))).toEqual([]);
    expect(arbiter.getPointerCount()).toBe(1);
  });

  it('ignores a move arriving after its pointer already lifted', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    up(arbiter, 1, 20, 20, 200);
    expect(types(move(arbiter, 1, 30, 30, 210))).toEqual([]);
  });

  it('ignores a duplicate pointerdown for a live id', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    expect(types(down(arbiter, 1, 10, 10, 5))).toEqual([]);
    // Critically, the duplicate must not be mistaken for a second finger.
    expect(arbiter.getPointerCount()).toBe(1);
    expect(arbiter.getState()).toBe('pending');
  });

  it('recovers when the second pointer vanishes without an up event', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    down(arbiter, 2, 300, 300, 30);
    arbiter.pointerCancel({ id: 2, x: 300, y: 300, t: 100 });

    expect(arbiter.getState()).toBe('blocked');
    expect(types(move(arbiter, 1, 150, 150, 120))).toEqual([]);
    up(arbiter, 1, 150, 150, 200);
    expect(arbiter.getState()).toBe('idle');
  });

  it('clears everything on reset (orientation change / overlay close)', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    arbiter.tick(GRACE + 1);
    expect(types(arbiter.reset())).toEqual(['strokeAbort']);
    expect(arbiter.getState()).toBe('idle');
    expect(arbiter.getPointerCount()).toBe(0);
  });

  it('discards a pending buffer on reset without aborting anything committed', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    expect(types(arbiter.reset())).toEqual(['strokeDiscard']);
  });

  it('is usable again immediately after an interruption', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 100, 100, 0);
    arbiter.reset();

    down(arbiter, 5, 10, 10, 500);
    const commands = arbiter.tick(500 + GRACE + 1);
    expect(types(commands)).toEqual(['strokeBegin']);
    expect(beginPoints(commands)[0].point).toMatchObject({ x: 10, y: 10 });
  });

  it('does not let a second pointer extend the first pointer\'s stroke', () => {
    const arbiter = new GestureArbiter();
    down(arbiter, 1, 10, 10, 0);
    arbiter.tick(GRACE + 1);
    // A stray pointermove from a different id while drawing (palm, or a
    // pointer the browser never sent a down for in order).
    expect(types(move(arbiter, 7, 500, 500, 100))).toEqual([]);
  });
});

describe('GestureArbiter - metrics for the real-device HUD', () => {
  it('counts prevented strays across repeated pinches', () => {
    const arbiter = new GestureArbiter();
    for (let i = 0; i < 5; i += 1) {
      const base = i * 1000;
      down(arbiter, 1, 100, 100, base);
      move(arbiter, 1, 102, 100, base + 15);
      down(arbiter, 2, 300, 300, base + 40);
      up(arbiter, 1, 102, 100, base + 200);
      up(arbiter, 2, 300, 300, base + 220);
    }
    const metrics = arbiter.getMetrics();
    expect(metrics.discardedBySecondPointer).toBe(5);
    expect(metrics.pinchGestures).toBe(5);
    expect(metrics.strokesCommitted).toBe(0);
  });

  it('counts committed strokes across a normal drawing session', () => {
    const arbiter = new GestureArbiter();
    for (let i = 0; i < 3; i += 1) {
      const base = i * 1000;
      down(arbiter, 1, 10, 10, base);
      arbiter.tick(base + GRACE + 1);
      move(arbiter, 1, 80, 80, base + 200);
      up(arbiter, 1, 80, 80, base + 300);
    }
    expect(arbiter.getMetrics().strokesCommitted).toBe(3);
  });
});
