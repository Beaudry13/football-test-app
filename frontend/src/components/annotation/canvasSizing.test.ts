import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_WIDTH,
  MAX_CANVAS_WIDTH_LEGACY,
  resolveCanvasWidth,
  resolveTrueCapWidth,
} from './canvasSizing';

describe('resolveCanvasWidth', () => {
  it('uses a pinned width from a prior save, regardless of annotation count', () => {
    expect(resolveCanvasWidth(1234, true)).toBe(1234);
    expect(resolveCanvasWidth(1234, false)).toBe(1234);
  });

  it('gives a brand-new image (no pin, no annotations yet) the bigger cap', () => {
    expect(resolveCanvasWidth(null, false)).toBe(MAX_CANVAS_WIDTH);
  });

  it('falls back to the legacy cap for an image with existing annotations but no pin', () => {
    // This is the case that matters most: an image annotated before the
    // canvas_width column existed. Using the new cap here would silently
    // shift every already-saved shape's coordinates.
    expect(resolveCanvasWidth(null, true)).toBe(MAX_CANVAS_WIDTH_LEGACY);
  });
});

describe('resolveTrueCapWidth', () => {
  it('uses the stored cap unchanged when the photo is at least as wide as it', () => {
    expect(resolveTrueCapWidth(1400, 2048)).toBe(1400);
    expect(resolveTrueCapWidth(1400, 1400)).toBe(1400);
  });

  it('falls back to the photo\'s real (smaller) width when the stored cap overstates it', () => {
    // This is the real-world bug case: a 695x397 photo saved with canvas_width 1400 because the
    // editor's own achieved-vs-requested width mismatch was never corrected before this fix.
    // Shapes were actually authored in 695-wide space, so that's what rendering must use too.
    expect(resolveTrueCapWidth(1400, 695)).toBe(695);
  });

  it('never exceeds the stored cap, even for a very large natural width', () => {
    expect(resolveTrueCapWidth(900, 4032)).toBe(900);
  });
});
