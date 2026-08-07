import { describe, expect, it } from 'vitest';
import {
  COORDINATE_MAX_WIDTH,
  addStroke,
  checkSource,
  clearStrokes,
  createDocument,
  createStrokeId,
  estimatePayloadBytes,
  hasDrawnAnswer,
  nextOrder,
  removeStroke,
  strokesForLayer,
  validateDocument,
} from './drawingDocument';
import { PLAYER_STROKE_COLOR, type DrawingSourceImage, type DrawingStroke } from './types';

const SOURCE: DrawingSourceImage = {
  image_id: 'img-42',
  image_version: 'v1',
  natural_width: 2000,
  natural_height: 1000,
};

function stroke(id: string, overrides: Partial<DrawingStroke> = {}): Omit<DrawingStroke, 'order'> {
  return {
    id,
    tool: 'pen',
    layer: 'player',
    points: [0, 0, 10, 10],
    color: PLAYER_STROKE_COLOR,
    width: 6,
    ...overrides,
  };
}

describe('createDocument', () => {
  it('pins the coordinate space and preserves the image aspect ratio', () => {
    const doc = createDocument({ source: SOURCE });
    expect(doc.coordinate_width).toBe(COORDINATE_MAX_WIDTH);
    expect(doc.coordinate_height).toBe(COORDINATE_MAX_WIDTH / 2);
  });

  it('never sizes the coordinate space above the image resolution', () => {
    // Upscaling past the photo's own pixels buys no precision, only payload.
    const doc = createDocument({ source: { ...SOURCE, natural_width: 600, natural_height: 400 } });
    expect(doc.coordinate_width).toBe(600);
    expect(doc.coordinate_height).toBe(400);
  });

  it('carries the full source reference so the image version is recoverable', () => {
    const doc = createDocument({ source: SOURCE });
    expect(doc.source).toEqual(SOURCE);
  });

  it('survives a degenerate image with no usable dimensions', () => {
    const doc = createDocument({ source: { ...SOURCE, natural_width: 0, natural_height: 0 } });
    expect(doc.coordinate_width).toBeGreaterThan(0);
    expect(doc.coordinate_height).toBeGreaterThan(0);
  });
});

describe('answer presence', () => {
  it('treats a document with no strokes as no answer', () => {
    expect(hasDrawnAnswer(createDocument({ source: SOURCE }))).toBe(false);
  });

  it('treats a single stroke as an answer', () => {
    const doc = addStroke(createDocument({ source: SOURCE }), stroke('a'));
    expect(hasDrawnAnswer(doc)).toBe(true);
  });

  it('treats null/undefined as no answer', () => {
    expect(hasDrawnAnswer(null)).toBe(false);
    expect(hasDrawnAnswer(undefined)).toBe(false);
  });
});

describe('stroke operations', () => {
  it('assigns increasing order values', () => {
    let doc = createDocument({ source: SOURCE });
    doc = addStroke(doc, stroke('a'));
    doc = addStroke(doc, stroke('b'));
    expect(doc.strokes.map((s) => s.order)).toEqual([0, 1]);
    expect(nextOrder(doc)).toBe(2);
  });

  it('keeps order monotonic after a middle stroke is erased', () => {
    let doc = createDocument({ source: SOURCE });
    doc = addStroke(doc, stroke('a'));
    doc = addStroke(doc, stroke('b'));
    doc = removeStroke(doc, 'a');
    doc = addStroke(doc, stroke('c'));
    // 'c' must land on top of 'b', not reuse the erased stroke's slot.
    expect(doc.strokes.map((s) => s.order)).toEqual([1, 2]);
  });

  it('does not mutate the input document', () => {
    const doc = createDocument({ source: SOURCE });
    const next = addStroke(doc, stroke('a'));
    expect(doc.strokes).toHaveLength(0);
    expect(next.strokes).toHaveLength(1);
  });

  it('returns the same reference when erasing an id that is not present', () => {
    const doc = addStroke(createDocument({ source: SOURCE }), stroke('a'));
    expect(removeStroke(doc, 'nope')).toBe(doc);
  });

  it('clears only the requested layer, leaving the coach version intact', () => {
    let doc = createDocument({ source: SOURCE });
    doc = addStroke(doc, stroke('coach-1', { layer: 'coach' }));
    doc = addStroke(doc, stroke('player-1'));
    const cleared = clearStrokes(doc, 'player');

    expect(strokesForLayer(cleared, 'player')).toHaveLength(0);
    expect(strokesForLayer(cleared, 'coach')).toHaveLength(1);
  });

  it('generates unique stroke ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createStrokeId()));
    expect(ids.size).toBe(500);
  });
});

describe('source image pinning', () => {
  it('accepts an unchanged image', () => {
    const doc = createDocument({ source: SOURCE });
    expect(checkSource(doc, SOURCE)).toBe('none');
  });

  it('detects a different image record', () => {
    const doc = createDocument({ source: SOURCE });
    expect(checkSource(doc, { ...SOURCE, image_id: 'img-99' })).toBe('different-image');
  });

  it('detects the coach replacing the image content in place', () => {
    // The scenario that silently invalidates answers: same question, same
    // image row, new photo uploaded over it.
    const doc = createDocument({ source: SOURCE });
    expect(checkSource(doc, { ...SOURCE, image_version: 'v2' })).toBe('different-version');
  });

  it('detects a dimension change even when versions are unknown', () => {
    const doc = createDocument({ source: { ...SOURCE, image_version: null } });
    expect(checkSource(doc, { ...SOURCE, image_version: null, natural_width: 1600 })).toBe('different-dimensions');
  });

  it('does not flag a legacy document that never recorded a version', () => {
    const doc = createDocument({ source: { ...SOURCE, image_version: null } });
    expect(checkSource(doc, SOURCE)).toBe('none');
  });
});

describe('validateDocument', () => {
  it('accepts a document it just created', () => {
    expect(validateDocument(createDocument({ source: SOURCE }))).toEqual([]);
  });

  it('rejects non-objects', () => {
    expect(validateDocument(null).length).toBeGreaterThan(0);
    expect(validateDocument('{}').length).toBeGreaterThan(0);
  });

  it('rejects a foreign format', () => {
    const doc = { ...createDocument({ source: SOURCE }), format: 'something.else' };
    expect(validateDocument(doc)).toContain('unexpected format: something.else');
  });

  it('flags a document written by a newer client', () => {
    const doc = { ...createDocument({ source: SOURCE }), version: 99 };
    expect(validateDocument(doc).join(' ')).toMatch(/newer than this client/);
  });

  it('flags a stroke with an odd number of coordinates', () => {
    const doc = createDocument({ source: SOURCE });
    doc.strokes.push({ ...stroke('a'), order: 0, points: [1, 2, 3] });
    expect(validateDocument(doc).join(' ')).toMatch(/odd point count/);
  });

  it('flags an empty stroke', () => {
    const doc = createDocument({ source: SOURCE });
    doc.strokes.push({ ...stroke('a'), order: 0, points: [] });
    expect(validateDocument(doc).join(' ')).toMatch(/at least one point/);
  });
});

describe('estimatePayloadBytes', () => {
  it('grows with stroke count', () => {
    let doc = createDocument({ source: SOURCE });
    const small = estimatePayloadBytes(doc);
    for (let i = 0; i < 50; i += 1) doc = addStroke(doc, stroke(`s${i}`));
    expect(estimatePayloadBytes(doc)).toBeGreaterThan(small);
  });

  it('stays in a plausible range against real serialization', () => {
    let doc = createDocument({ source: SOURCE });
    for (let i = 0; i < 40; i += 1) {
      doc = addStroke(doc, stroke(`s${i}`, { points: Array.from({ length: 200 }, (_, n) => n * 1.5) }));
    }
    const actual = JSON.stringify(doc).length;
    const estimated = estimatePayloadBytes(doc);
    // Only ever used for threshold decisions, so being within 2x of reality
    // is the bar - but it must not be off by an order of magnitude.
    expect(estimated).toBeGreaterThan(actual / 2);
    expect(estimated).toBeLessThan(actual * 2);
  });
});
