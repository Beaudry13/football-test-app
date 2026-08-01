import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_WIDTH, MAX_CANVAS_WIDTH_LEGACY, resolveCanvasWidth } from './canvasSizing';

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
