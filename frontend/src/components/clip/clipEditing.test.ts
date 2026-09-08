import { describe, expect, it } from 'vitest';
import {
  MIN_CROP_PX,
  MIN_TRIM_MS,
  fullFrameCrop,
  fullTrim,
  isFullDuration,
  isFullFrame,
  needsReencode,
  normaliseCrop,
  normaliseTrim,
  remapDecisionPoint,
} from './clipEditing';

/** The rules behind Trim & crop, tested without a browser.
 *
 * TWO OF THESE MATTER MORE THAN THE REST.
 *
 * `needsReencode` is the passthrough gate: a coach who changes nothing must
 * get their original recording back untouched, with no second encode and no
 * generation loss. If that ever returns true for an untouched clip, every
 * coach silently starts paying for a re-encode they did not ask for.
 *
 * `normaliseCrop` protects the encoder. H.264 subsamples chroma 2x2, so an odd
 * width or height is a real failure - and the obvious fix, rounding up, is the
 * one that pushes a rectangle past the edge of the frame it was measured
 * against. It rounds INWARD for that reason, and the bounds tests below are
 * what hold it there.
 */

const W = 1920;
const H = 1080;

describe('crop', () => {
  it('defaults to the whole frame', () => {
    const crop = fullFrameCrop(W, H);
    expect(crop).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(isFullFrame(crop, W, H)).toBe(true);
  });

  it('keeps a straightforward crop exactly as given', () => {
    expect(normaliseCrop({ x: 384, y: 162, w: 1344, h: 810 }, W, H)).toEqual({
      x: 384,
      y: 162,
      w: 1344,
      h: 810,
    });
  });

  it.each([
    ['left', { x: 300, y: 0, w: 1620, h: H }],
    ['right', { x: 0, y: 0, w: 1620, h: H }],
    ['top', { x: 0, y: 200, w: W, h: 880 }],
    ['bottom', { x: 0, y: 0, w: W, h: 880 }],
  ])('accepts a %s-edge crop', (_edge, rect) => {
    const out = normaliseCrop(rect, W, H);
    expect(out.w % 2).toBe(0);
    expect(out.h % 2).toBe(0);
    expect(out.x + out.w).toBeLessThanOrEqual(W);
    expect(out.y + out.h).toBeLessThanOrEqual(H);
  });

  it('accepts a corner crop', () => {
    const out = normaliseCrop({ x: 200, y: 150, w: 900, h: 600 }, W, H);
    expect(out).toEqual({ x: 200, y: 150, w: 900, h: 600 });
  });

  it('a repositioned crop of the same size stays inside the frame', () => {
    // Moving the box right up against the edge must not spill over it.
    const out = normaliseCrop({ x: 1500, y: 900, w: 600, h: 400 }, W, H);
    expect(out.x + out.w).toBeLessThanOrEqual(W);
    expect(out.y + out.h).toBeLessThanOrEqual(H);
  });

  describe('even dimensions - the encoder requirement', () => {
    it.each([
      [{ x: 0, y: 0, w: 1001, h: 667 }],
      [{ x: 3, y: 7, w: 999, h: 501 }],
      [{ x: 101, y: 203, w: 305, h: 407 }],
    ])('snaps %o to even width and height', (rect) => {
      const out = normaliseCrop(rect, W, H);
      expect(out.w % 2).toBe(0);
      expect(out.h % 2).toBe(0);
      expect(out.x % 2).toBe(0);
      expect(out.y % 2).toBe(0);
    });

    it('rounds INWARD, never outward past the source edge', () => {
      // The trap: rounding 1919 up to 1920 from x=1 puts the right edge at
      // 1921, one pixel outside a frame that is only 1920 wide.
      const out = normaliseCrop({ x: 1, y: 1, w: 1919, h: 1079 }, W, H);
      expect(out.x + out.w).toBeLessThanOrEqual(W);
      expect(out.y + out.h).toBeLessThanOrEqual(H);
    });

    it('an odd source frame still yields an even crop inside it', () => {
      const out = normaliseCrop({ x: 0, y: 0, w: 1281, h: 721 }, 1281, 721);
      expect(out.w % 2).toBe(0);
      expect(out.h % 2).toBe(0);
      expect(out.x + out.w).toBeLessThanOrEqual(1281);
      expect(out.y + out.h).toBeLessThanOrEqual(721);
    });
  });

  describe('bounds', () => {
    it('clamps a negative origin to the frame', () => {
      const out = normaliseCrop({ x: -500, y: -300, w: 800, h: 600 }, W, H);
      expect(out.x).toBe(0);
      expect(out.y).toBe(0);
    });

    it('clamps a crop wider than the source', () => {
      const out = normaliseCrop({ x: 0, y: 0, w: 9999, h: 9999 }, W, H);
      expect(out.w).toBe(W);
      expect(out.h).toBe(H);
    });

    it('never returns a crop below the minimum size', () => {
      const out = normaliseCrop({ x: 10, y: 10, w: 1, h: 1 }, W, H);
      expect(out.w).toBeGreaterThanOrEqual(MIN_CROP_PX);
      expect(out.h).toBeGreaterThanOrEqual(MIN_CROP_PX);
    });

    it('an origin past the far edge is pulled back so a crop still fits', () => {
      const out = normaliseCrop({ x: 5000, y: 5000, w: 200, h: 200 }, W, H);
      expect(out.x + out.w).toBeLessThanOrEqual(W);
      expect(out.y + out.h).toBeLessThanOrEqual(H);
    });
  });
});

describe('trim', () => {
  const DURATION = 20_000;

  it('defaults to the whole recording', () => {
    const range = fullTrim(DURATION);
    expect(range).toEqual({ startMs: 0, endMs: DURATION });
    expect(isFullDuration(range, DURATION)).toBe(true);
  });

  it('trims the start', () => {
    expect(normaliseTrim({ startMs: 3000, endMs: DURATION }, DURATION)).toEqual({
      startMs: 3000,
      endMs: DURATION,
    });
  });

  it('trims the end', () => {
    expect(normaliseTrim({ startMs: 0, endMs: 15_000 }, DURATION)).toEqual({
      startMs: 0,
      endMs: 15_000,
    });
  });

  it('trims both, and the retained span is the difference', () => {
    const out = normaliseTrim({ startMs: 3000, endMs: 15_000 }, DURATION);
    expect(out).toEqual({ startMs: 3000, endMs: 15_000 });
    expect(out.endMs - out.startMs).toBe(12_000);
  });

  it('prevents the handles from crossing', () => {
    // Dragging start past end means "start later", not "invert the clip".
    const out = normaliseTrim({ startMs: 16_000, endMs: 4000 }, DURATION);
    expect(out.endMs).toBeGreaterThan(out.startMs);
  });

  it('enforces the minimum retained duration', () => {
    const out = normaliseTrim({ startMs: 10_000, endMs: 10_100 }, DURATION);
    expect(out.endMs - out.startMs).toBeGreaterThanOrEqual(MIN_TRIM_MS);
  });

  it('gives way at the START when the end is already at the ceiling', () => {
    const out = normaliseTrim({ startMs: DURATION, endMs: DURATION }, DURATION);
    expect(out.endMs - out.startMs).toBeGreaterThanOrEqual(MIN_TRIM_MS);
    expect(out.endMs).toBeLessThanOrEqual(DURATION);
  });

  it('clamps a range past the end of the recording', () => {
    const out = normaliseTrim({ startMs: 0, endMs: 99_000 }, DURATION);
    expect(out.endMs).toBe(DURATION);
  });

  it('treats a few milliseconds short of the end as untouched', () => {
    // A recorder's reported duration and the media's own are routinely a frame
    // apart; a coach who never touched the handle must not pay for an encode.
    expect(isFullDuration({ startMs: 0, endMs: DURATION - 20 }, DURATION)).toBe(true);
    expect(isFullDuration({ startMs: 0, endMs: DURATION - 900 }, DURATION)).toBe(false);
  });
});

describe('the passthrough gate', () => {
  const DURATION = 20_000;

  it('no crop and no trim means NO re-encode', () => {
    expect(
      needsReencode(fullFrameCrop(W, H), fullTrim(DURATION), W, H, DURATION),
    ).toBe(false);
  });

  it('a crop alone requires an encode', () => {
    expect(
      needsReencode({ x: 100, y: 0, w: 1000, h: H }, fullTrim(DURATION), W, H, DURATION),
    ).toBe(true);
  });

  it('a trim alone requires an encode', () => {
    expect(
      needsReencode(fullFrameCrop(W, H), { startMs: 2000, endMs: DURATION }, W, H, DURATION),
    ).toBe(true);
  });

  it('crop and trim together still require exactly one encode decision', () => {
    expect(
      needsReencode({ x: 10, y: 10, w: 800, h: 600 }, { startMs: 1000, endMs: 9000 }, W, H, DURATION),
    ).toBe(true);
  });
});

describe('decision point', () => {
  const range = { startMs: 3000, endMs: 15_000 };

  it('no decision point needs nothing', () => {
    expect(remapDecisionPoint(null, range)).toEqual({ ok: true, value: null });
    expect(remapDecisionPoint(undefined, range)).toEqual({ ok: true, value: null });
  });

  it('a point inside the range shifts by the trim start', () => {
    expect(remapDecisionPoint(12_000, range)).toEqual({ ok: true, value: 9000 });
  });

  it('refuses a point before the retained range', () => {
    expect(remapDecisionPoint(1000, range)).toEqual({
      ok: false,
      reason: 'outside-retained-range',
    });
  });

  it('refuses a point EXACTLY at the trim start', () => {
    // It would freeze the film before a single frame has played.
    expect(remapDecisionPoint(3000, range).ok).toBe(false);
  });

  it('refuses a point EXACTLY at the trim end', () => {
    // It would never stop anything - the clip has already finished.
    expect(remapDecisionPoint(15_000, range).ok).toBe(false);
  });

  it('refuses a point after the retained range', () => {
    expect(remapDecisionPoint(17_000, range).ok).toBe(false);
  });

  it('clearing the point explicitly makes the same trim allowed', () => {
    // The coach's way out of the refusal - and it is a decision they make,
    // never one taken for them.
    expect(remapDecisionPoint(17_000, range).ok).toBe(false);
    expect(remapDecisionPoint(null, range)).toEqual({ ok: true, value: null });
  });

  it('never clamps a point into range', () => {
    const out = remapDecisionPoint(17_000, range);
    expect(out).not.toHaveProperty('value');
  });
});
