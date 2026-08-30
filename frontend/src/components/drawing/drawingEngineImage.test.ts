/** WHERE THE SOURCE IMAGE SITS IN THE SCENE.
 *
 * The whole engine measures a scene that runs [0, coordinate_width] x
 * [0, coordinate_height]: containFit fits that box, resetView centres it, the
 * zoom floor is derived from it, and every stored stroke is expressed in it.
 * The image has to occupy exactly that box or the fit frames the wrong place.
 *
 * It did not. Fabric returns an image whose origin is its CENTRE, so
 * `left: 0, top: 0` put the middle of the picture at the scene origin and the
 * image spanned [-700, +700] x [-394, +394] for a 1400x788 document - which is
 * why a player saw only its bottom-right quadrant, pinned to the top-left of
 * the board.
 *
 * These assert the resulting GEOMETRY rather than the two literals that
 * produce it, so the test still fails if a later change moves the image by
 * some other means.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** A stand-in for the Fabric image: records what the engine sets on it and can
 *  report the bounds those settings imply. Fabric itself needs a real canvas,
 *  which jsdom cannot give us - and the thing under test is the geometry the
 *  engine ASKS for, not Fabric's ability to paint it. */
class FakeImage {
  width = 2400;
  height = 1350;
  originX = 'center';
  originY = 'center';
  left = 0;
  top = 0;
  scaleX = 1;
  scaleY = 1;
  set(props: Record<string, unknown>) {
    Object.assign(this, props);
    return this;
  }
  /** The box this image covers in scene units, given its origin. */
  bounds() {
    const w = this.width * this.scaleX;
    const h = this.height * this.scaleY;
    const left = this.originX === 'center' ? this.left - w / 2 : this.left;
    const top = this.originY === 'center' ? this.top - h / 2 : this.top;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h };
  }
}

const fakeImage = new FakeImage();

vi.mock('fabric', () => {
  class Canvas {
    getWidth() { return 0; }
    getHeight() { return 0; }
    getZoom() { return 1; }
    add() {} remove() {} sendObjectToBack() {} requestRenderAll() {}
    setDimensions() {} setViewportTransform() {} on() {} off() {} dispose() {}
    viewportTransform = [1, 0, 0, 1, 0, 0];
    freeDrawingBrush = undefined;
  }
  return {
    Canvas,
    StaticCanvas: Canvas,
    PencilBrush: class { constructor() {} },
    Polyline: class { constructor() {} },
    FabricImage: { fromURL: vi.fn(async () => fakeImage) },
    Point: class {
      x: number;
      y: number;
      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    },
  };
});

import { DrawingEngine } from './drawingEngine';
import { createDocument } from './drawingDocument';

const DOC = createDocument({
  source: { image_id: '1', image_version: null, natural_width: 2400, natural_height: 1350 },
  now: '2026-08-29T00:00:00.000Z',
});

function build() {
  const element = document.createElement('canvas');
  return new DrawingEngine(element, DOC, { onDocumentChange: () => {} });
}

beforeEach(() => {
  Object.assign(fakeImage, {
    width: 2400, height: 1350,
    originX: 'center', originY: 'center',
    left: 0, top: 0, scaleX: 1, scaleY: 1,
  });
});

describe('the source image occupies the document coordinate space', () => {
  it('starts at the scene origin, not centred on it', async () => {
    // THE REGRESSION. With a centre origin these were -700 / -393.75, and the
    // fit - which is correct - framed a box the image was not in.
    const engine = build();
    await engine.setSourceImage('/uploads/play.jpg');

    const bounds = fakeImage.bounds();
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
  });

  it('covers exactly the document space, so the fit frames the whole image', () => {
    const engine = build();
    return engine.setSourceImage('/uploads/play.jpg').then(() => {
      const bounds = fakeImage.bounds();
      // Within a pixel, not exact: coordinate_height is Math.round()ed from
      // the aspect, so a 2400x1350 image covers 787.5 of a declared 788.
      expect(bounds.right).toBe(DOC.coordinate_width);
      expect(Math.abs(bounds.bottom - DOC.coordinate_height)).toBeLessThanOrEqual(1);
    });
  });

  it('scales uniformly, so the picture is never stretched', async () => {
    const engine = build();
    await engine.setSourceImage('/uploads/play.jpg');

    expect(fakeImage.scaleX).toBe(fakeImage.scaleY);
    // 1400 / 2400 for this document.
    expect(fakeImage.scaleX).toBeCloseTo(DOC.coordinate_width / 2400, 6);
  });

  it('anchors by the top-left corner explicitly rather than relying on a default', async () => {
    // Stated in the code because `left`/`top` mean different things depending
    // on it - the two coordinates above are meaningless without this.
    const engine = build();
    await engine.setSourceImage('/uploads/play.jpg');

    expect(fakeImage.originX).toBe('left');
    expect(fakeImage.originY).toBe('top');
  });

  it('keeps a portrait image inside the same box', async () => {
    Object.assign(fakeImage, { width: 1000, height: 1600 });
    const portrait = createDocument({
      source: { image_id: '2', image_version: null, natural_width: 1000, natural_height: 1600 },
      now: '2026-08-29T00:00:00.000Z',
    });
    const element = document.createElement('canvas');
    const engine = new DrawingEngine(element, portrait, { onDocumentChange: () => {} });
    await engine.setSourceImage('/uploads/tall.jpg');

    const bounds = fakeImage.bounds();
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(portrait.coordinate_width);
    expect(Math.abs(bounds.bottom - portrait.coordinate_height)).toBeLessThanOrEqual(1);
  });

  it('keeps a square image inside the same box', async () => {
    Object.assign(fakeImage, { width: 1200, height: 1200 });
    const square = createDocument({
      source: { image_id: '3', image_version: null, natural_width: 1200, natural_height: 1200 },
      now: '2026-08-29T00:00:00.000Z',
    });
    const element = document.createElement('canvas');
    const engine = new DrawingEngine(element, square, { onDocumentChange: () => {} });
    await engine.setSourceImage('/uploads/square.jpg');

    const bounds = fakeImage.bounds();
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(square.coordinate_width);
    expect(Math.abs(bounds.bottom - square.coordinate_height)).toBeLessThanOrEqual(1);
  });
});
