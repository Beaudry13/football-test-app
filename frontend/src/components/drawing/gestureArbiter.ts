/** Pointer-gesture arbitration for the drawing board.
 *
 * Deliberately pure: no React, no DOM, no Fabric. It consumes normalized
 * pointer samples and returns a list of commands for the host to apply.
 * That boundary is the whole point - the hard part of this feature is the
 * two-finger race, and a state machine that can only be exercised through
 * a real touchscreen is a state machine that never gets tested. Everything
 * here runs in jsdom in microseconds.
 *
 * THE RACE
 * --------
 * A player who intends to pinch does not land both fingers simultaneously.
 * The second finger arrives ~30-80ms after the first. A naive board starts
 * drawing the instant the first finger lands, so every pinch leaves a stray
 * dash on the image.
 *
 * The fix is deferred stroke commitment: the first finger's movement is
 * buffered, not drawn. If a second pointer arrives inside the grace window,
 * the buffer is discarded and the gesture becomes a pinch - no mark is ever
 * created. If the window expires with one pointer still down, the buffer is
 * replayed into the brush starting at the TRUE first touch point, so the
 * stroke begins exactly where the finger landed.
 *
 * Replaying rather than skipping matters. Dropping the buffered points would
 * start every stroke a few millimeters late, which on a phone reads as the
 * pen not tracking your finger - a subtler bug than the stray dash, and one
 * that would survive the real-device gate unnoticed.
 */

export type PointerId = number;

/** Tools that arbitrate differently. Pen is the interesting one. */
export type DrawingTool = 'pen' | 'pan' | 'eraser';

/** A point in whatever space the host feeds in. The arbiter never converts
 * coordinates - the host hands it viewport pixels and applies the resulting
 * commands after converting to Fabric scene space itself. Keeping the
 * transform out of here is what keeps this module Fabric-free. */
export interface ArbiterPoint {
  x: number;
  y: number;
  /** Event timestamp in ms. Supplied by the host (never read from a clock
   * here) so tests can drive time deterministically. */
  t: number;
}

export interface PointerSample extends ArbiterPoint {
  id: PointerId;
}

/** How the arbiter currently reads the player's intent. Surfaced to the HUD
 * so a phone tester can see the classification without DevTools. */
export type GestureClass =
  | 'idle'
  /** One pointer down, inside the grace window, buffering - nothing drawn yet. */
  | 'pending'
  | 'drawing'
  | 'pinch'
  | 'pan'
  | 'erasing'
  /** A multi-touch gesture has ended but fingers are still down. Nothing may
   * start until the screen is clear again. */
  | 'blocked';

export type ArbiterCommand =
  /** Commit the buffered stroke, beginning at the true first touch point. */
  | { type: 'strokeBegin'; point: ArbiterPoint }
  | { type: 'strokeExtend'; point: ArbiterPoint }
  | { type: 'strokeEnd' }
  /** The pending buffer was thrown away before anything was drawn. Nothing to
   * undo - this is the stray mark that never happened. */
  | { type: 'strokeDiscard'; reason: 'secondPointer' | 'cancel' | 'reset' }
  /** A stroke that HAD been committed must be abandoned without finalizing. */
  | { type: 'strokeAbort'; reason: 'cancel' | 'reset' }
  /** Pinch: scale about `focal`, then translate by `panBy`. Both come from the
   * same two-finger move, and the host applies them in that order. */
  | { type: 'transform'; scaleBy: number; focal: ArbiterPoint; panBy: { x: number; y: number } }
  | { type: 'pan'; by: { x: number; y: number } }
  | { type: 'eraseAt'; point: ArbiterPoint };

export interface ArbiterConfig {
  /** How long the first finger is buffered before its stroke commits.
   *
   * 60ms sits above the observed 30-80ms two-finger spread's lower half
   * without being perceptible as lag: the stroke is replayed from the true
   * origin, so the only thing the player can notice is ink appearing 60ms
   * late, not ink appearing in the wrong place. Tunable from the spike HUD
   * so the real-device gate can settle the number on actual hardware rather
   * than from a desk. */
  graceMs: number;
  /** Below this two-finger distance a pinch's scale factor is ignored - two
   * fingers touching almost the same spot produce a wild ratio from a pixel
   * of jitter. Pan still applies. */
  minPinchDistancePx: number;
}

export const DEFAULT_ARBITER_CONFIG: ArbiterConfig = {
  graceMs: 60,
  minPinchDistancePx: 24,
};

interface LivePointer {
  id: PointerId;
  x: number;
  y: number;
}

export interface ArbiterMetrics {
  /** Strokes prevented by the grace window. Every one of these is a stray
   * mark the player would have seen on a naive implementation. */
  discardedBySecondPointer: number;
  strokesCommitted: number;
  pinchGestures: number;
  /** Committed strokes that a second pointer interrupted very shortly after
   * commitment - see `suspectStray` below. */
  suspectedStrays: number;
}

/** A committed stroke this brief, interrupted this fast by a second finger,
 * is almost certainly a pinch whose grace window was too short. It is not
 * proof, so the HUD reports it as "suspected" alongside a manual tally the
 * tester controls - a heuristic that silently claimed zero strays would be
 * worse than no heuristic at all. */
const SUSPECT_STRAY_MAX_DURATION_MS = 140;
const SUSPECT_STRAY_MAX_POINTS = 3;

export class GestureArbiter {
  private config: ArbiterConfig;
  private pointers = new Map<PointerId, LivePointer>();
  private state: GestureClass = 'idle';
  private tool: DrawingTool = 'pen';

  /** Buffered first-finger samples awaiting commit-or-discard. */
  private buffer: ArbiterPoint[] = [];
  private graceDeadline = 0;
  /** The pointer that owns the current stroke/pan. A second finger's moves
   * must never extend a stroke the first finger started. */
  private activePointer: PointerId | null = null;

  private strokeStartedAt = 0;
  private strokePointCount = 0;

  private pinchDistance = 0;
  private pinchMidpoint: { x: number; y: number } = { x: 0, y: 0 };
  /** At least one finger has moved since the last transform was emitted. */
  private pinchDirty = false;

  private metrics: ArbiterMetrics = {
    discardedBySecondPointer: 0,
    strokesCommitted: 0,
    pinchGestures: 0,
    suspectedStrays: 0,
  };

  constructor(config: Partial<ArbiterConfig> = {}) {
    this.config = { ...DEFAULT_ARBITER_CONFIG, ...config };
  }

  getState(): GestureClass {
    return this.state;
  }

  getPointerCount(): number {
    return this.pointers.size;
  }

  getMetrics(): ArbiterMetrics {
    return { ...this.metrics };
  }

  getTool(): DrawingTool {
    return this.tool;
  }

  /** Switching tools mid-gesture abandons whatever is in flight rather than
   * letting a pen stroke finish under eraser rules. */
  setTool(tool: DrawingTool): ArbiterCommand[] {
    if (tool === this.tool) return [];
    const commands = this.abandonInFlight('reset');
    this.tool = tool;
    this.state = this.pointers.size > 0 ? 'blocked' : 'idle';
    return commands;
  }

  setConfig(config: Partial<ArbiterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  pointerDown(sample: PointerSample): ArbiterCommand[] {
    // A duplicate down for a live id is a browser quirk, not a new finger.
    // Treating it as one would corrupt the pinch baseline.
    if (this.pointers.has(sample.id)) return [];

    this.pointers.set(sample.id, { id: sample.id, x: sample.x, y: sample.y });

    // Any pointer landing while blocked keeps us blocked - the screen has to
    // clear completely before a new gesture can be classified.
    if (this.state === 'blocked') return [];

    if (this.pointers.size >= 2) return this.beginPinch(sample);

    switch (this.tool) {
      case 'eraser':
        this.state = 'erasing';
        this.activePointer = sample.id;
        return [{ type: 'eraseAt', point: toPoint(sample) }];
      case 'pan':
        this.state = 'pan';
        this.activePointer = sample.id;
        return [];
      case 'pen':
        this.state = 'pending';
        this.activePointer = sample.id;
        this.buffer = [toPoint(sample)];
        this.graceDeadline = sample.t + this.config.graceMs;
        return [];
    }
  }

  pointerMove(sample: PointerSample): ArbiterCommand[] {
    const live = this.pointers.get(sample.id);
    // Out-of-order or post-up move for an unknown pointer: ignore rather than
    // resurrect it. Safari emits these around interruptions.
    if (!live) return [];
    // Captured before `live` is updated - the pan delta is measured against
    // where this pointer was, so the two must not be read in the other order.
    const previous = { x: live.x, y: live.y };
    live.x = sample.x;
    live.y = sample.y;

    switch (this.state) {
      case 'pinch':
        // Deliberately does NOT emit here. Two fingers never move in the same
        // pointer event, so recomputing scale after each one turns a pure
        // two-finger pan into zoom-out-then-zoom-back-in. The net factor is
        // 1, but the intermediate frame is a visible wobble. Instead the move
        // is absorbed into the baseline and the host's per-frame tick() emits
        // one transform from both fingers' settled positions.
        this.pinchDirty = true;
        return [];

      case 'pan':
        if (sample.id !== this.activePointer) return [];
        return [{ type: 'pan', by: { x: sample.x - previous.x, y: sample.y - previous.y } }];

      case 'pending': {
        if (sample.id !== this.activePointer) return [];
        this.buffer.push(toPoint(sample));
        // The move itself is what usually carries us past the deadline; the
        // host's tick() covers the finger-held-still case.
        if (sample.t >= this.graceDeadline) return this.commitBuffer();
        return [];
      }

      case 'drawing':
        if (sample.id !== this.activePointer) return [];
        this.strokePointCount += 1;
        return [{ type: 'strokeExtend', point: toPoint(sample) }];

      default:
        return [];
    }
  }

  pointerUp(sample: PointerSample): ArbiterCommand[] {
    if (!this.pointers.has(sample.id)) return [];
    this.pointers.delete(sample.id);

    switch (this.state) {
      case 'pending': {
        if (sample.id !== this.activePointer) return [];
        // A tap shorter than the grace window is still a deliberate mark -
        // commit it so the player gets their dot, rather than silently
        // eating a touch they meant.
        const commands = this.commitBuffer();
        commands.push(...this.endStroke());
        return commands;
      }

      case 'drawing': {
        if (sample.id !== this.activePointer) return [];
        return this.endStroke();
      }

      case 'pinch':
      case 'blocked': {
        // One finger lifting out of a pinch must NOT hand control to the
        // finger still on the glass - that is its own stray-mark source,
        // and a common one when a player pinches then relaxes a thumb.
        this.state = this.pointers.size === 0 ? 'idle' : 'blocked';
        if (this.pointers.size === 0) this.activePointer = null;
        return [];
      }

      case 'pan':
      case 'erasing': {
        if (this.pointers.size === 0) {
          this.state = 'idle';
          this.activePointer = null;
        }
        return [];
      }

      default:
        if (this.pointers.size === 0) this.state = 'idle';
        return [];
    }
  }

  /** pointercancel / lostpointercapture. The browser has taken the gesture
   * away (system edge-swipe, palm rejection, call banner). */
  pointerCancel(sample: PointerSample): ArbiterCommand[] {
    if (!this.pointers.has(sample.id)) return [];
    this.pointers.delete(sample.id);

    const commands: ArbiterCommand[] = [];
    if (this.state === 'pending' && sample.id === this.activePointer) {
      this.buffer = [];
      commands.push({ type: 'strokeDiscard', reason: 'cancel' });
    } else if (this.state === 'drawing' && sample.id === this.activePointer) {
      // Abandoned, not finalized. A cancelled stroke is one the browser
      // decided was not really a stroke; committing it is how stray marks
      // get in through the back door. Undo/redo is unaffected because
      // nothing was ever added to the canvas.
      this.metrics.strokesCommitted -= 1;
      commands.push({ type: 'strokeAbort', reason: 'cancel' });
    }

    if (this.pointers.size === 0) {
      this.state = 'idle';
      this.activePointer = null;
    } else {
      this.state = 'blocked';
    }
    return commands;
  }

  /** Host-driven clock, expected once per animation frame. Does two jobs:
   * commits a buffered stroke when the finger has held still long enough to
   * produce no further move events, and flushes the frame's accumulated
   * pinch into a single transform. */
  tick(now: number): ArbiterCommand[] {
    if (this.state === 'pinch') {
      if (!this.pinchDirty) return [];
      this.pinchDirty = false;
      return this.flushPinch();
    }
    if (this.state !== 'pending') return [];
    if (now < this.graceDeadline) return [];
    return this.commitBuffer();
  }

  /** Orientation change, overlay close, unmount, visibility loss. Drops every
   * pointer and abandons anything in flight. */
  reset(): ArbiterCommand[] {
    const commands = this.abandonInFlight('reset');
    this.pointers.clear();
    this.state = 'idle';
    this.activePointer = null;
    this.buffer = [];
    this.pinchDirty = false;
    return commands;
  }

  // --- internals ---------------------------------------------------------

  private beginPinch(sample: PointerSample): ArbiterCommand[] {
    const commands: ArbiterCommand[] = [];

    if (this.state === 'pending') {
      // The whole reason this module exists: the second finger arrived inside
      // the grace window, so the first finger's buffer was never a stroke.
      this.buffer = [];
      this.metrics.discardedBySecondPointer += 1;
      commands.push({ type: 'strokeDiscard', reason: 'secondPointer' });
    } else if (this.state === 'drawing') {
      // Past the grace window the stroke is real and the player drew it, so
      // it is finalized rather than thrown away - but if it was brief enough
      // to be a slow-landing pinch, flag it so the gate can see the grace
      // window may need widening on this device.
      if (this.isSuspectStray(sample.t)) this.metrics.suspectedStrays += 1;
      commands.push(...this.endStroke());
    }

    this.state = 'pinch';
    this.activePointer = null;
    this.pinchDirty = false;
    this.metrics.pinchGestures += 1;
    this.syncPinchBaseline();
    return commands;
  }

  private isSuspectStray(now: number): boolean {
    return (
      now - this.strokeStartedAt <= SUSPECT_STRAY_MAX_DURATION_MS &&
      this.strokePointCount <= SUSPECT_STRAY_MAX_POINTS
    );
  }

  private syncPinchBaseline(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private flushPinch(): ArbiterCommand[] {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return [];

    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const usable = this.pinchDistance >= this.config.minPinchDistancePx && distance > 0;
    const scaleBy = usable ? distance / this.pinchDistance : 1;
    const panBy = { x: midpoint.x - this.pinchMidpoint.x, y: midpoint.y - this.pinchMidpoint.y };

    this.pinchDistance = distance;
    this.pinchMidpoint = midpoint;

    if (scaleBy === 1 && panBy.x === 0 && panBy.y === 0) return [];
    return [{ type: 'transform', scaleBy, focal: { ...midpoint, t: 0 }, panBy }];
  }

  /** Replays the buffer into the brush: begin at the true first touch, then
   * every sample recorded since. */
  private commitBuffer(): ArbiterCommand[] {
    if (this.buffer.length === 0) return [];
    const [first, ...rest] = this.buffer;
    const commands: ArbiterCommand[] = [{ type: 'strokeBegin', point: first }];
    for (const point of rest) commands.push({ type: 'strokeExtend', point });

    this.state = 'drawing';
    this.strokeStartedAt = first.t;
    this.strokePointCount = this.buffer.length;
    this.metrics.strokesCommitted += 1;
    this.buffer = [];
    return commands;
  }

  private endStroke(): ArbiterCommand[] {
    this.state = this.pointers.size === 0 ? 'idle' : 'blocked';
    if (this.pointers.size === 0) this.activePointer = null;
    return [{ type: 'strokeEnd' }];
  }

  private abandonInFlight(reason: 'cancel' | 'reset'): ArbiterCommand[] {
    if (this.state === 'pending' && this.buffer.length > 0) {
      this.buffer = [];
      return [{ type: 'strokeDiscard', reason }];
    }
    if (this.state === 'drawing') {
      this.metrics.strokesCommitted -= 1;
      return [{ type: 'strokeAbort', reason }];
    }
    return [];
  }
}

function toPoint(sample: PointerSample): ArbiterPoint {
  return { x: sample.x, y: sample.y, t: sample.t };
}
