import { describe, expect, it } from 'vitest';
import { Group, type FabricObject } from 'fabric';
import {
  applyStyleToObject,
  capsFromObject,
  createArrow,
  createCircle,
  createLine,
  createRectangle,
  createSegment,
  createSmoothPath,
  createTextbox,
  currentSegment,
  styleFromObject,
} from './shapeFactories';
import { DEFAULT_STYLE, type AnnotationStyle, type LineCap } from './types';

const redSolid: AnnotationStyle = {
  color: '#e63946',
  strokeWidth: 3,
  dashed: false,
  fillOpacity: 0.25,
  bold: true,
  startCap: 'none',
  endCap: 'none',
};
const bluedashed: AnnotationStyle = {
  color: '#264653',
  strokeWidth: 8,
  dashed: true,
  fillOpacity: 0.6,
  bold: true,
  startCap: 'none',
  endCap: 'none',
};

describe('segment tracking for endpoint dragging', () => {
  it('tags a line with its endpoints for the drag hit-test', () => {
    const line = createLine({ x: 10, y: 20 }, { x: 100, y: 200 }, redSolid);
    expect(line.get('hasEditableEndpoints')).toBe(true);
    expect(line.get('segStart')).toEqual({ x: 10, y: 20 });
    expect(line.get('segEnd')).toEqual({ x: 100, y: 200 });
  });

  it('tags an arrow with its endpoints and an isArrow marker', () => {
    const arrow = createArrow({ x: 0, y: 0 }, { x: 50, y: 50 }, redSolid);
    expect(arrow.get('hasEditableEndpoints')).toBe(true);
    expect(arrow.get('isArrow')).toBe(true);
    expect(arrow.get('segStart')).toEqual({ x: 0, y: 0 });
    expect(arrow.get('segEnd')).toEqual({ x: 50, y: 50 });
  });

  it('does not tag circles or rectangles as having editable endpoints', () => {
    const circle = createCircle(redSolid);
    expect(circle.get('hasEditableEndpoints')).toBeFalsy();
  });

  it('hides the default resize/rotate handles on lines and arrows', () => {
    const line = createLine({ x: 0, y: 0 }, { x: 10, y: 10 }, redSolid);
    const arrow = createArrow({ x: 0, y: 0 }, { x: 10, y: 10 }, redSolid);
    expect(line.hasControls).toBe(false);
    expect(line.hasBorders).toBe(false);
    expect(arrow.hasControls).toBe(false);
    expect(arrow.hasBorders).toBe(false);
  });
});

describe('currentSegment', () => {
  it('returns the original endpoints when the object has not moved', () => {
    const line = createLine({ x: 10, y: 20 }, { x: 100, y: 200 }, redSolid);
    expect(currentSegment(line)).toEqual({ start: { x: 10, y: 20 }, end: { x: 100, y: 200 } });
  });

  it('shifts the endpoints by however far the object has moved as a whole', () => {
    const line = createLine({ x: 10, y: 20 }, { x: 100, y: 200 }, redSolid);
    const originalLeft = line.left!;
    const originalTop = line.top!;
    // Simulate a whole-body drag: only left/top change, nothing else.
    line.set({ left: originalLeft + 30, top: originalTop - 5 });
    expect(currentSegment(line)).toEqual({ start: { x: 40, y: 15 }, end: { x: 130, y: 195 } });
  });
});

describe('styleFromObject', () => {
  it('reads a rectangle’s color, width, dash, and fill opacity back out', () => {
    const rect = createRectangle(redSolid);
    expect(styleFromObject(rect)).toEqual(redSolid);
  });

  it('reads a circle’s style back out, including dashed', () => {
    const circle = createCircle(bluedashed);
    expect(styleFromObject(circle)).toEqual(bluedashed);
  });

  it('reads an arrow’s style from its shaft line, not the head', () => {
    const arrow = createArrow({ x: 0, y: 0 }, { x: 100, y: 100 }, bluedashed);
    const result = styleFromObject(arrow);
    expect(result.color).toBe(bluedashed.color);
    expect(result.strokeWidth).toBe(bluedashed.strokeWidth);
    expect(result.dashed).toBe(true);
  });

  it('derives a textbox’s strokeWidth from its font size', () => {
    const textbox = createTextbox({ x: 0, y: 0 }, redSolid);
    // createTextbox sets fontSize = max(16, strokeWidth * 6) = 18
    expect(textbox.fontSize).toBe(18);
    expect(styleFromObject(textbox).strokeWidth).toBe(3);
    expect(styleFromObject(textbox).color).toBe(redSolid.color);
  });

  it('falls back to defaults for a shape with no explicit style set', () => {
    const line = createLine({ x: 0, y: 0 }, { x: 1, y: 1 }, DEFAULT_STYLE);
    line.set({ stroke: undefined, strokeWidth: undefined });
    const result = styleFromObject(line);
    expect(result.color).toBe(DEFAULT_STYLE.color);
    expect(result.strokeWidth).toBe(DEFAULT_STYLE.strokeWidth);
  });
});

describe('applyStyleToObject', () => {
  it('updates a rectangle in place and round-trips through styleFromObject', () => {
    const rect = createRectangle(redSolid);
    applyStyleToObject(rect, bluedashed);
    expect(styleFromObject(rect)).toEqual(bluedashed);
  });

  it('updates both the shaft and head of an arrow', () => {
    const arrow = createArrow({ x: 0, y: 0 }, { x: 50, y: 50 }, redSolid);
    applyStyleToObject(arrow, bluedashed);
    // createArrow always forces endCap: 'arrow', so this is always a Group.
    const [shaft, head] = (arrow as Group).getObjects();
    expect(shaft.stroke).toBe(bluedashed.color);
    expect(shaft.strokeWidth).toBe(bluedashed.strokeWidth);
    expect(head.fill).toBe(bluedashed.color);
  });

  it('updates a textbox’s color and font size', () => {
    const textbox = createTextbox({ x: 0, y: 0 }, redSolid);
    applyStyleToObject(textbox, bluedashed);
    expect(textbox.fill).toBe(bluedashed.color);
    expect(textbox.fontSize).toBe(bluedashed.strokeWidth * 6);
  });

  it('does not touch fill on non-fillable shapes like lines', () => {
    const line = createLine({ x: 0, y: 0 }, { x: 1, y: 1 }, redSolid);
    const fillBefore = line.fill;
    applyStyleToObject(line, bluedashed);
    expect(line.stroke).toBe(bluedashed.color);
    expect(line.fill).toBe(fillBefore);
  });

  it('recolours a curve path, so a placed curve never needs redrawing to restyle', () => {
    const path = createSmoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], redSolid);
    applyStyleToObject(path, bluedashed);
    expect(path.stroke).toBe(bluedashed.color);
    expect(path.strokeWidth).toBe(bluedashed.strokeWidth);
    expect(styleFromObject(path).color).toBe(bluedashed.color);
    expect(styleFromObject(path).dashed).toBe(true);
  });

  it('recolours every cap of a segment, not just the shaft', () => {
    const segment = createSegment({ x: 0, y: 0 }, { x: 60, y: 0 }, {
      ...redSolid,
      startCap: 'open-circle',
      endCap: 'arrow',
    });
    applyStyleToObject(segment, { ...bluedashed, startCap: 'open-circle', endCap: 'arrow' });

    const [shaft, startCircle, endArrow] = (segment as Group).getObjects();
    expect(shaft.stroke).toBe(bluedashed.color);
    // An open circle is stroke-only; its white centre must survive a recolour.
    expect(startCircle.stroke).toBe(bluedashed.color);
    expect(startCircle.fill).toBe('#ffffff');
    expect(endArrow.fill).toBe(bluedashed.color);
  });

  it('toggles a textbox between bold and regular weight', () => {
    const textbox = createTextbox({ x: 0, y: 0 }, redSolid);
    expect(textbox.fontWeight).toBe(700);
    expect(styleFromObject(textbox).bold).toBe(true);

    applyStyleToObject(textbox, { ...redSolid, bold: false });
    expect(textbox.fontWeight).toBe(400);
    expect(styleFromObject(textbox).bold).toBe(false);
  });
});

describe('line end caps', () => {
  it('stays a bare line when both ends are plain', () => {
    const segment = createSegment({ x: 0, y: 0 }, { x: 50, y: 0 }, redSolid);
    expect(segment.type).toBe('line');
    expect(capsFromObject(segment)).toEqual({ startCap: 'none', endCap: 'none' });
  });

  it.each<LineCap>(['arrow', 'filled-circle', 'open-circle', 'tbar'])(
    'builds a segment with %s on both ends independently',
    (cap) => {
      const segment = createSegment({ x: 0, y: 0 }, { x: 50, y: 0 }, {
        ...redSolid,
        startCap: cap,
        endCap: cap,
      });
      const children = (segment as Group).getObjects();
      expect(children).toHaveLength(3); // shaft + two caps
      expect(children.slice(1).map((c: FabricObject) => c.get('capKind'))).toEqual([cap, cap]);
      expect(capsFromObject(segment)).toEqual({ startCap: cap, endCap: cap });
    },
  );

  it('supports different caps at each end', () => {
    const segment = createSegment({ x: 0, y: 0 }, { x: 50, y: 0 }, {
      ...redSolid,
      startCap: 'open-circle',
      endCap: 'arrow',
    });
    expect(capsFromObject(segment)).toEqual({ startCap: 'open-circle', endCap: 'arrow' });
    expect(styleFromObject(segment).startCap).toBe('open-circle');
    expect(styleFromObject(segment).endCap).toBe('arrow');
  });

  it('points each cap outward, away from the middle of the segment', () => {
    // Horizontal, left-to-right: the end arrowhead points right (+90 from
    // Triangle's default "up"), the start arrowhead points back left (-90).
    const segment = createSegment({ x: 0, y: 0 }, { x: 50, y: 0 }, {
      ...redSolid,
      startCap: 'arrow',
      endCap: 'arrow',
    });
    const [, startHead, endHead] = (segment as Group).getObjects();
    expect(endHead.angle).toBe(90);
    expect(startHead.angle).toBe(270);
  });

  it('reads an arrow saved before caps existed as an end-arrow segment', () => {
    // Pre-cap annotations carry only the old isArrow flag, no startCap/endCap.
    const legacy = createArrow({ x: 0, y: 0 }, { x: 50, y: 50 }, redSolid);
    legacy.set({ startCap: undefined, endCap: undefined });
    expect(legacy.get('isArrow')).toBe(true);
    expect(capsFromObject(legacy)).toEqual({ startCap: 'none', endCap: 'arrow' });
  });

  it('keeps endpoint tagging on a capped segment so it stays reshapeable', () => {
    const segment = createSegment({ x: 10, y: 20 }, { x: 100, y: 200 }, {
      ...redSolid,
      endCap: 'tbar',
    });
    expect(segment.get('hasEditableEndpoints')).toBe(true);
    expect(currentSegment(segment)).toEqual({ start: { x: 10, y: 20 }, end: { x: 100, y: 200 } });
  });
});
