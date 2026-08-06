import { describe, expect, it } from 'vitest';
import {
  FABRIC_CANVAS_LAYERS,
  MAX_BACKING_PIXELS_PER_LAYER,
  MAX_RENDER_SCALE,
  MIN_RENDER_SCALE,
  estimateCanvasBytes,
  fitScale,
  formatBytes,
  resolveRenderScale,
} from './renderScale';

/** A phone-sized board: iPhone 14 viewport minus the toolbar. */
const PHONE = { viewportWidth: 390, viewportHeight: 700 };
/** A desktop coach reviewing on a large window. */
const DESKTOP = { viewportWidth: 1400, viewportHeight: 900 };

describe('resolveRenderScale', () => {
  it('caps a high-DPR phone below devicePixelRatio', () => {
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 3 });
    expect(result.scale).toBe(MAX_RENDER_SCALE);
    expect(result.backingWidth).toBeLessThan(390 * 3);
  });

  it('lands at 1.5x on a DPR-2 phone, matching the prior spike', () => {
    expect(resolveRenderScale({ ...PHONE, devicePixelRatio: 2 }).scale).toBe(1.5);
  });

  it('sizes the backing store from the viewport, not the image', () => {
    // The canvas is a window onto the scene. A 4000px photo on a 390px phone
    // still only needs 390 CSS px of canvas; zoom changes the transform, not
    // the allocation.
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 2 });
    expect(result.backingWidth).toBe(Math.round(390 * 1.5));
    expect(result.backingHeight).toBe(Math.round(700 * 1.5));
  });

  it('does not upscale a DPR-1 desktop display past its own pixels', () => {
    expect(resolveRenderScale({ ...DESKTOP, devicePixelRatio: 1 }).scale).toBe(1);
  });

  it('never drops below the legibility floor for a low-DPR display', () => {
    expect(resolveRenderScale({ ...PHONE, devicePixelRatio: 0.25 }).scale).toBe(MIN_RENDER_SCALE);
  });

  it('keeps a phone board far inside the memory budget', () => {
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 3 });
    expect(result.backingWidth * result.backingHeight).toBeLessThan(MAX_BACKING_PIXELS_PER_LAYER);
    expect(result.cappedByMemory).toBe(false);
    // ~7MB across both layers on a modern phone - comfortable.
    expect(result.estimatedBytes).toBeLessThan(10 * 1024 * 1024);
  });

  it('lets the memory budget override the legibility floor on a huge window', () => {
    // A coach maximising a 5K display: soft is survivable, a killed tab is not.
    const result = resolveRenderScale({
      viewportWidth: 5120,
      viewportHeight: 2880,
      devicePixelRatio: 2,
    });
    expect(result.scale).toBeLessThan(MIN_RENDER_SCALE);
    expect(result.backingWidth * result.backingHeight).toBeLessThanOrEqual(MAX_BACKING_PIXELS_PER_LAYER * 1.01);
    expect(result.cappedByMemory).toBe(true);
  });

  it('honours a HUD override so the gate can sweep scales on real hardware', () => {
    expect(resolveRenderScale({ ...PHONE, devicePixelRatio: 3, requestedScale: 1 }).scale).toBe(1);
  });

  it('clamps an override that would blow the budget', () => {
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 2, requestedScale: 12 });
    expect(result.scale).toBeLessThanOrEqual(MAX_RENDER_SCALE);
  });

  it('falls back to 1x when devicePixelRatio is missing or nonsense', () => {
    expect(resolveRenderScale({ ...PHONE, devicePixelRatio: Number.NaN }).scale).toBe(1);
    expect(resolveRenderScale({ ...PHONE, devicePixelRatio: 0 }).scale).toBe(1);
  });

  it('estimates memory for both Fabric canvases, not one', () => {
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 2 });
    const oneLayer = result.backingWidth * result.backingHeight * 4;
    expect(result.estimatedBytes).toBe(oneLayer * FABRIC_CANVAS_LAYERS);
  });

  it('keeps the CSS-to-backing ratio identical on both axes', () => {
    // Unequal ratios are what stretch the image. Guarded here because the
    // symptom (a slightly squashed photo) is easy to miss by eye.
    const result = resolveRenderScale({ ...PHONE, devicePixelRatio: 2 });
    expect(result.backingWidth / PHONE.viewportWidth).toBeCloseTo(
      result.backingHeight / PHONE.viewportHeight,
      5,
    );
  });
});

describe('estimateCanvasBytes', () => {
  it('counts 4 bytes per pixel across both layers', () => {
    expect(estimateCanvasBytes(1000, 1000)).toBe(1000 * 1000 * 4 * 2);
  });
});

describe('formatBytes', () => {
  it('formats across magnitudes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('fitScale', () => {
  it('fits a wide image into a square window by width', () => {
    expect(fitScale(1400, 700, 700, 700)).toBe(0.5);
  });

  it('fits a tall image into a square window by height', () => {
    expect(fitScale(700, 1400, 700, 700)).toBe(0.5);
  });

  it('produces a fit that leaves the image fully inside the window', () => {
    const zoom = fitScale(1400, 875, 390, 700);
    expect(1400 * zoom).toBeLessThanOrEqual(390 + 0.001);
    expect(875 * zoom).toBeLessThanOrEqual(700 + 0.001);
  });

  it('is safe against a zero-sized coordinate space', () => {
    expect(fitScale(0, 0, 700, 700)).toBe(1);
  });
});
