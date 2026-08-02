import { describe, expect, it } from 'vitest';
import { clampScale, distance, midpoint, zoomAroundPoint, MIN_SCALE, MAX_SCALE } from './pinchZoomMath';

describe('clampScale', () => {
  it('passes through a value already in range', () => {
    expect(clampScale(2)).toBe(2);
  });

  it('clamps below the minimum', () => {
    expect(clampScale(0.3)).toBe(MIN_SCALE);
  });

  it('clamps above the maximum', () => {
    expect(clampScale(10)).toBe(MAX_SCALE);
  });

  it('respects custom bounds', () => {
    expect(clampScale(5, 1, 3)).toBe(3);
    expect(clampScale(0, 1, 3)).toBe(1);
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the content point under the focal point fixed when zooming in from 1x', () => {
    const state = { scale: 1, x: 0, y: 0 };
    const focal = { x: 100, y: 50 };

    const next = zoomAroundPoint(state, focal, 2);

    // The content point that was under (100,50) at 1x must still be under (100,50) at 2x.
    const contentBefore = { x: (focal.x - state.x) / state.scale, y: (focal.y - state.y) / state.scale };
    const contentAfter = { x: (focal.x - next.x) / next.scale, y: (focal.y - next.y) / next.scale };
    expect(contentAfter.x).toBeCloseTo(contentBefore.x);
    expect(contentAfter.y).toBeCloseTo(contentBefore.y);
    expect(next.scale).toBe(2);
  });

  it('zooming to the same scale is a no-op on translation', () => {
    const state = { scale: 2, x: -30, y: 15 };
    const next = zoomAroundPoint(state, { x: 100, y: 100 }, 2);
    expect(next).toEqual(state);
  });

  it('clamps the requested scale', () => {
    const state = { scale: 1, x: 0, y: 0 };
    const next = zoomAroundPoint(state, { x: 0, y: 0 }, 999);
    expect(next.scale).toBe(MAX_SCALE);
  });

  it('keeps the content point under the focal point fixed when zooming back out', () => {
    const state = { scale: 2.5, x: -140, y: -80 };
    const focal = { x: 60, y: 90 };

    const next = zoomAroundPoint(state, focal, 1);

    const contentBefore = { x: (focal.x - state.x) / state.scale, y: (focal.y - state.y) / state.scale };
    const contentAfter = { x: (focal.x - next.x) / next.scale, y: (focal.y - next.y) / next.scale };
    expect(contentAfter.x).toBeCloseTo(contentBefore.x);
    expect(contentAfter.y).toBeCloseTo(contentBefore.y);
    expect(next.scale).toBe(1);
  });
});

describe('distance', () => {
  it('computes euclidean distance between two points', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('midpoint', () => {
  it('computes the midpoint between two points', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});
