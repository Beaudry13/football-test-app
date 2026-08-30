/** WHERE THE SOURCE IMAGE SITS IN THE COACH'S VIEWER.
 *
 * The viewer is a second, separate rendering path from the player's board -
 * a StaticCanvas sized to the document space with viewportTransform
 * [scale, 0, 0, scale, 0, 0], so scene (0,0) is the canvas corner. It had the
 * same defect the board did, and it mattered more: the strokes carry absolute
 * coordinate-space points and were always drawn correctly, so a displaced
 * image meant the coach saw the player's marks over the WRONG part of the
 * picture. Right marks, wrong picture, is worse than either alone.
 *
 * These assert geometry rather than the two literals that produce it, and they
 * assert the STROKES are left alone - the fix must not move them.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
  bounds() {
    const w = this.width * this.scaleX;
    const h = this.height * this.scaleY;
    const left = this.originX === 'center' ? this.left - w / 2 : this.left;
    const top = this.originY === 'center' ? this.top - h / 2 : this.top;
    return { left, top, right: left + w, bottom: top + h };
  }
}

const fakeImage = new FakeImage();
const added: unknown[] = [];
let canvasOptions: Record<string, unknown> = {};
let viewport: number[] = [];

vi.mock('fabric', () => {
  class StaticCanvas {
    constructor(_el: unknown, opts: Record<string, unknown>) {
      canvasOptions = opts;
    }
    setViewportTransform(v: number[]) { viewport = v; }
    add(o: unknown) { added.push(o); }
    renderAll() {}
    dispose() { return Promise.resolve(); }
  }
  class Polyline {
    points: unknown;
    opts: unknown;
    constructor(points: unknown, opts: unknown) {
      this.points = points;
      this.opts = opts;
    }
  }
  return {
    StaticCanvas,
    Polyline,
    FabricImage: { fromURL: vi.fn(async () => fakeImage) },
  };
});

import { DrawingViewer } from './DrawingViewer';
import { createDocument } from './drawingDocument';
import type { DrawingDocument } from './types';

function docFor(w: number, h: number): DrawingDocument {
  const base = createDocument({
    source: { image_id: '1', image_version: null, natural_width: w, natural_height: h },
    now: '2026-08-29T00:00:00.000Z',
  });
  return {
    ...base,
    strokes: [
      {
        id: 's1', tool: 'pen', color: '#00E5FF', layer: 'player', order: 0, width: 6,
        points: [10, 20, 300, 400],
      },
    ],
  } as DrawingDocument;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  added.length = 0;
  canvasOptions = {};
  viewport = [];
  Object.assign(fakeImage, {
    width: 2400, height: 1350,
    originX: 'center', originY: 'center',
    left: 0, top: 0, scaleX: 1, scaleY: 1,
  });
});

describe("the coach viewer's source image", () => {
  it('starts at the scene origin, not centred on it', async () => {
    // THE REGRESSION. Centred, the image spanned [-700, +700] and the coach
    // saw only its bottom-right quadrant while the strokes stayed put.
    const doc = docFor(2400, 1350);
    render(<DrawingViewer imageUrl="/uploads/play.jpg" document={doc} alt="drawing" />);
    await flush();

    const bounds = fakeImage.bounds();
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
  });

  it('covers the document space the canvas and strokes both use', async () => {
    const doc = docFor(2400, 1350);
    render(<DrawingViewer imageUrl="/uploads/play.jpg" document={doc} alt="drawing" />);
    await flush();

    const bounds = fakeImage.bounds();
    expect(bounds.right).toBe(doc.coordinate_width);
    // coordinate_height is rounded from the aspect, so within a pixel.
    expect(Math.abs(bounds.bottom - doc.coordinate_height)).toBeLessThanOrEqual(1);
  });

  it('agrees with the canvas box, so image and strokes share one frame', async () => {
    const doc = docFor(2400, 1350);
    render(<DrawingViewer imageUrl="/uploads/play.jpg" document={doc} alt="drawing" />);
    await flush();

    // The canvas IS the document space times the view scale, and the viewport
    // is anchored at the scene origin - so an image starting at (0,0) fills it.
    const scale = viewport[0];
    expect(canvasOptions.width).toBeCloseTo(doc.coordinate_width * scale, 3);
    expect(fakeImage.bounds().left).toBe(0);
    expect(viewport[4]).toBe(0);
    expect(viewport[5]).toBe(0);
  });

  it('leaves the strokes exactly as stored', async () => {
    // The fix moves the IMAGE. A stroke that also moved would mean the coach
    // and the player disagree again, in the other direction.
    const doc = docFor(2400, 1350);
    render(<DrawingViewer imageUrl="/uploads/play.jpg" document={doc} alt="drawing" />);
    await flush();

    const polyline = added.find((o) => (o as { points?: unknown }).points) as {
      points: { x: number; y: number }[];
    };
    expect(polyline.points).toEqual([
      { x: 10, y: 20 },
      { x: 300, y: 400 },
    ]);
  });

  it.each([
    ['landscape', 2400, 1350],
    ['portrait', 1000, 1600],
    ['square', 1200, 1200],
  ])('anchors a %s image at the origin', async (_shape, w, h) => {
    Object.assign(fakeImage, { width: w, height: h });
    const doc = docFor(w, h);
    render(<DrawingViewer imageUrl="/uploads/shape.jpg" document={doc} alt="drawing" />);
    await flush();

    const bounds = fakeImage.bounds();
    expect(bounds.left).toBe(0);
    expect(bounds.top).toBe(0);
    expect(bounds.right).toBe(doc.coordinate_width);
    expect(Math.abs(bounds.bottom - doc.coordinate_height)).toBeLessThanOrEqual(1);
  });
});
