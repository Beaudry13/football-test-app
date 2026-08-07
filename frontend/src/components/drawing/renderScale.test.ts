import { describe, expect, it } from 'vitest';
import {
  FABRIC_CANVAS_LAYERS,
  MAX_BACKING_PIXELS_PER_LAYER,
  MAX_RENDER_SCALE,
  MIN_RENDER_SCALE,
  estimateCanvasBytes,
  containFit,
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

describe('containFit - the whole image, centred', () => {
  /** An iPhone-shaped board: 390 CSS wide, DPR 3 so renderScale caps at 1.5. */
  const PHONE_CSS = { w: 390, h: 700 };
  const RS = 1.5;

  /** Where the image's four corners land, in backing pixels. */
  function corners(cw: number, ch: number, cssW: number, cssH: number, rs: number) {
    const fit = containFit(cw, ch, cssW, cssH, rs);
    return {
      fit,
      left: fit.offsetX,
      top: fit.offsetY,
      right: fit.offsetX + cw * fit.zoom,
      bottom: fit.offsetY + ch * fit.zoom,
      backingW: cssW * rs,
      backingH: cssH * rs,
    };
  }

  it('fits a landscape image entirely inside the board and centres it', () => {
    // 2400x1350 capped to a 1400-wide coordinate space.
    const c = corners(1400, 788, PHONE_CSS.w, PHONE_CSS.h, RS);
    expect(c.left).toBeGreaterThanOrEqual(-0.01);
    expect(c.top).toBeGreaterThanOrEqual(-0.01);
    expect(c.right).toBeLessThanOrEqual(c.backingW + 0.01);
    expect(c.bottom).toBeLessThanOrEqual(c.backingH + 0.01);
    // Centred: equal margin on each axis.
    expect(c.left).toBeCloseTo(c.backingW - c.right, 5);
    expect(c.top).toBeCloseTo(c.backingH - c.bottom, 5);
  });

  it('fits a portrait image entirely inside the board and centres it', () => {
    const c = corners(788, 1400, PHONE_CSS.w, PHONE_CSS.h, RS);
    expect(c.left).toBeGreaterThanOrEqual(-0.01);
    expect(c.top).toBeGreaterThanOrEqual(-0.01);
    expect(c.right).toBeLessThanOrEqual(c.backingW + 0.01);
    expect(c.bottom).toBeLessThanOrEqual(c.backingH + 0.01);
    expect(c.left).toBeCloseTo(c.backingW - c.right, 5);
    expect(c.top).toBeCloseTo(c.backingH - c.bottom, 5);
  });

  it('fits a very large image entirely inside the board', () => {
    // The regression: a 6000x4000 still on a phone. The old code clamped the
    // resulting zoom up to a fixed 0.5 floor and pushed the image off-screen.
    const c = corners(6000, 4000, PHONE_CSS.w, PHONE_CSS.h, RS);
    expect(c.fit.cssZoom).toBeLessThan(0.5); // below the old MIN_ZOOM floor
    expect(c.left).toBeGreaterThanOrEqual(-0.01);
    expect(c.top).toBeGreaterThanOrEqual(-0.01);
    expect(c.right).toBeLessThanOrEqual(c.backingW + 0.01);
    expect(c.bottom).toBeLessThanOrEqual(c.backingH + 0.01);
  });

  it('never crops: the fit is the smaller axis ratio, never the larger', () => {
    const fit = containFit(1400, 788, PHONE_CSS.w, PHONE_CSS.h, RS);
    const cover = Math.max(PHONE_CSS.w / 1400, PHONE_CSS.h / 788);
    expect(fit.cssZoom).toBeLessThan(cover);
    expect(fit.cssZoom).toBeCloseTo(Math.min(PHONE_CSS.w / 1400, PHONE_CSS.h / 788), 10);
  });

  it('preserves aspect ratio - one zoom drives both axes', () => {
    const fit = containFit(1400, 788, PHONE_CSS.w, PHONE_CSS.h, RS);
    const drawnAspect = (1400 * fit.zoom) / (788 * fit.zoom);
    expect(drawnAspect).toBeCloseTo(1400 / 788, 10);
  });

  it('DPR does not change the logical fit, only the backing store', () => {
    // The unit bug in one assertion: what the player sees must be identical
    // at DPR 1 and DPR 3; only the device-pixel numbers may differ.
    const at1 = containFit(1400, 788, 390, 700, 1);
    const at3 = containFit(1400, 788, 390, 700, 1.5);

    expect(at3.cssZoom).toBeCloseTo(at1.cssZoom, 10);
    expect(at3.zoom).toBeCloseTo(at1.zoom * 1.5, 10);
    // Offsets scale with the backing store, so the image occupies the same
    // fraction of the box either way.
    expect(at3.offsetX / (390 * 1.5)).toBeCloseTo(at1.offsetX / 390, 10);
    expect(at3.offsetY / (700 * 1.5)).toBeCloseTo(at1.offsetY / 700, 10);
  });

  it('recalculates for a rotation rather than reusing the old framing', () => {
    const portrait = containFit(1400, 788, 390, 700, RS);
    const landscape = containFit(1400, 788, 700, 390, RS);

    expect(landscape.cssZoom).toBeGreaterThan(portrait.cssZoom);
    // Still fully contained after the flip.
    expect(1400 * landscape.zoom).toBeLessThanOrEqual(700 * RS + 0.01);
    expect(788 * landscape.zoom).toBeLessThanOrEqual(390 * RS + 0.01);
  });

  it('is deterministic, so Fit View restores exactly the opening transform', () => {
    const onOpen = containFit(1400, 788, 390, 700, RS);
    const onFitView = containFit(1400, 788, 390, 700, RS);
    expect(onFitView).toEqual(onOpen);
  });

  it('recomputes after a resize instead of scaling the previous transform', () => {
    const before = containFit(1400, 788, 390, 700, RS);
    // iOS collapsing its URL bar: same width, taller box.
    const after = containFit(1400, 788, 390, 760, RS);

    // Width-limited image, so a taller box must not change the zoom - only
    // re-centre it vertically.
    expect(after.cssZoom).toBeCloseTo(before.cssZoom, 10);
    expect(after.offsetX).toBeCloseTo(before.offsetX, 10);
    expect(after.offsetY).toBeGreaterThan(before.offsetY);
  });

  it('survives a zero-sized box without emitting NaN', () => {
    // A board mounted before layout settles - iOS resolves dvh late.
    const fit = containFit(1400, 788, 0, 0, RS);
    expect(Number.isFinite(fit.zoom)).toBe(true);
    expect(Number.isFinite(fit.offsetX)).toBe(true);
    expect(Number.isFinite(fit.offsetY)).toBe(true);
  });
});
