import { Circle, Ellipse, Group, Line, Path, Rect, Textbox, Triangle, type FabricObject, type XY } from 'fabric';
import { pointsToSmoothPathData } from './curveUtils';
import { DEFAULT_STYLE, type AnnotationStyle, type LineCap } from './types';

function withAlpha(hex: string, alpha: number): string {
  const bigint = parseInt(hex.replace('#', ''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function strokeDashArray(style: AnnotationStyle): number[] | undefined {
  return style.dashed ? [style.strokeWidth * 2, style.strokeWidth * 2] : undefined;
}

export function makeId(): string {
  return crypto.randomUUID();
}

/** Tags an object as having draggable endpoints, recording where they are
 * *and* the object's left/top at that moment - a plain whole-body move
 * (dragging the shape, not an endpoint) only ever translates it (no rotate/
 * scale control is offered on these), so segStart/segEnd plus the left/top
 * delta since tagging is enough to recover the *current* absolute endpoints
 * without touching the object's own transform math. See currentSegment(). */
function tagSegment(obj: FabricObject, start: XY, end: XY): void {
  obj.set({
    hasEditableEndpoints: true,
    segStart: { x: start.x, y: start.y },
    segEnd: { x: end.x, y: end.y },
    segRefLeft: obj.left,
    segRefTop: obj.top,
  });
}

/** The current absolute start/end of a tagged object, compensating for any
 * whole-body move since it was last tagged (see tagSegment). */
export function currentSegment(obj: FabricObject): { start: XY; end: XY } {
  const segStart = obj.get('segStart') as XY;
  const segEnd = obj.get('segEnd') as XY;
  const refLeft = (obj.get('segRefLeft') as number) ?? obj.left ?? 0;
  const refTop = (obj.get('segRefTop') as number) ?? obj.top ?? 0;
  const dx = (obj.left ?? refLeft) - refLeft;
  const dy = (obj.top ?? refTop) - refTop;
  return {
    start: { x: segStart.x + dx, y: segStart.y + dy },
    end: { x: segEnd.x + dx, y: segEnd.y + dy },
  };
}

/** One end decoration, drawn at `at` and oriented so it points *away* from
 * the rest of the segment (`outwardDeg`). Tagged with its own kind so a later
 * recolor can tell an open circle (stroke-only) from a filled one. */
function buildCap(kind: LineCap, at: XY, outwardDeg: number, style: AnnotationStyle): FabricObject | null {
  if (kind === 'none') return null;
  const sw = style.strokeWidth;
  let cap: FabricObject;

  if (kind === 'arrow') {
    const size = Math.max(10, sw * 4);
    cap = new Triangle({
      left: at.x,
      top: at.y,
      originX: 'center',
      originY: 'center',
      width: size,
      height: size,
      fill: style.color,
      // Triangle's apex points up at angle 0, so +90 turns it along outwardDeg.
      angle: outwardDeg + 90,
    });
  } else if (kind === 'filled-circle' || kind === 'open-circle') {
    cap = new Circle({
      left: at.x,
      top: at.y,
      originX: 'center',
      originY: 'center',
      radius: Math.max(4, sw * 1.8),
      fill: kind === 'filled-circle' ? style.color : '#ffffff',
      stroke: style.color,
      strokeWidth: sw,
    });
  } else {
    // T-bar: a short bar perpendicular to the segment, centred on the end.
    const half = Math.max(6, sw * 2.5);
    const rad = ((outwardDeg + 90) * Math.PI) / 180;
    const dx = Math.cos(rad) * half;
    const dy = Math.sin(rad) * half;
    cap = new Line([at.x - dx, at.y - dy, at.x + dx, at.y + dy], {
      stroke: style.color,
      strokeWidth: sw,
      strokeLineCap: 'butt',
    });
  }

  cap.set('capKind', kind);
  return cap;
}

/** A straight segment with independently configurable end decorations.
 * Returns a bare Line when both ends are plain (the shape all pre-cap saved
 * annotations already have) and a Group of shaft + caps otherwise. */
export function createSegment(start: XY, end: XY, style: AnnotationStyle): FabricObject {
  const angleDeg = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;

  const shaft = new Line([start.x, start.y, end.x, end.y], {
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    strokeLineCap: 'round',
  });

  const caps = [
    buildCap(style.startCap, start, angleDeg + 180, style),
    buildCap(style.endCap, end, angleDeg, style),
  ].filter((cap): cap is FabricObject => cap !== null);

  // hasControls/hasBorders: false - a segment is reshaped by dragging either
  // endpoint (see AnnotationCanvas.tsx's endpoint-drag hit-test), not by the
  // default resize/rotate bounding-box handles, which don't make sense for
  // "stretch one end of a line" and were confusing in practice.
  const shared = {
    hasControls: false,
    hasBorders: false,
    startCap: style.startCap,
    endCap: style.endCap,
    // Kept in sync for the benefit of annotations saved before caps existed,
    // which identify an arrow by this flag alone (see capsFromObject).
    isArrow: style.endCap === 'arrow',
  };

  const segment: FabricObject = caps.length === 0 ? shaft : new Group([shaft, ...caps]);
  segment.set(shared);
  tagSegment(segment, start, end);
  return segment;
}

export function createLine(start: XY, end: XY, style: AnnotationStyle): FabricObject {
  return createSegment(start, end, style);
}

/** The Arrow tool's preset: whatever start cap is selected, ending in a head. */
export function createArrow(start: XY, end: XY, style: AnnotationStyle): FabricObject {
  return createSegment(start, end, { ...style, endCap: 'arrow' });
}

/** A segment's two end styles. Annotations saved before caps existed carry
 * neither field - those are a plain line, or an arrow if the old isArrow flag
 * is set. */
export function capsFromObject(obj: FabricObject): { startCap: LineCap; endCap: LineCap } {
  const startCap = obj.get('startCap') as LineCap | undefined;
  const endCap = obj.get('endCap') as LineCap | undefined;
  if (startCap || endCap) {
    return { startCap: startCap ?? 'none', endCap: endCap ?? 'none' };
  }
  return { startCap: 'none', endCap: obj.get('isArrow') === true ? 'arrow' : 'none' };
}

/** Small circle shown at a line/arrow's endpoint while it's being dragged -
 * purely a visual cue, not itself interactive (hit-testing for the drag is
 * proximity-based, handled directly in AnnotationCanvas.tsx). */
export function createEndpointMarker(point: XY): Circle {
  return new Circle({
    left: point.x,
    top: point.y,
    originX: 'center',
    originY: 'center',
    radius: 6,
    fill: '#ffffff',
    stroke: '#1d4ed8',
    strokeWidth: 2,
    selectable: false,
    evented: false,
    excludeFromExport: true,
  });
}

export function createRectangle(style: AnnotationStyle): Rect {
  return new Rect({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    fill: withAlpha(style.color, style.fillOpacity),
    // Fabric's `fill` is a plain rgba() string, not reversible back to a 0-1
    // opacity - stored separately so an already-placed shape's fill opacity
    // can be read back into the toolbar when it's selected for editing.
    annotationFillOpacity: style.fillOpacity,
  });
}

export function createCircle(style: AnnotationStyle): Ellipse {
  return new Ellipse({
    left: 0,
    top: 0,
    rx: 0,
    ry: 0,
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    fill: withAlpha(style.color, style.fillOpacity),
    annotationFillOpacity: style.fillOpacity,
  });
}

/** Reads an already-placed shape's current style back out, so selecting it
 * shows its real color/width/dashed/fill-opacity in the toolbar instead of
 * whatever style is queued up for the next *new* shape. */
export function styleFromObject(obj: FabricObject): AnnotationStyle {
  if (obj.type === 'group') {
    // Capped segment: [shaft line, ...caps] - the shaft carries the real style.
    const shaft = (obj as Group).getObjects()[0] as FabricObject | undefined;
    const dashArray = shaft?.strokeDashArray;
    return {
      color: (shaft?.stroke as string) || DEFAULT_STYLE.color,
      strokeWidth: (shaft?.strokeWidth as number) ?? DEFAULT_STYLE.strokeWidth,
      dashed: Array.isArray(dashArray) && dashArray.length > 0,
      fillOpacity: DEFAULT_STYLE.fillOpacity,
      bold: DEFAULT_STYLE.bold,
      ...capsFromObject(obj),
    };
  }
  if (obj.type === 'textbox') {
    const textbox = obj as Textbox;
    const fontSize = textbox.fontSize ?? 16;
    return {
      color: (obj.fill as string) || DEFAULT_STYLE.color,
      // Reverses createTextbox's fontSize = max(16, strokeWidth * 6), so the
      // Width slider doubles as a font-size control for text labels.
      strokeWidth: Math.max(1, Math.round(fontSize / 6)),
      dashed: false,
      fillOpacity: DEFAULT_STYLE.fillOpacity,
      bold: textbox.fontWeight === 'bold' || Number(textbox.fontWeight) >= 600,
      startCap: 'none',
      endCap: 'none',
    };
  }
  const dashArray = obj.strokeDashArray;
  return {
    color: (obj.stroke as string) || DEFAULT_STYLE.color,
    strokeWidth: (obj.strokeWidth as number) ?? DEFAULT_STYLE.strokeWidth,
    dashed: Array.isArray(dashArray) && dashArray.length > 0,
    fillOpacity:
      ((obj as unknown as { annotationFillOpacity?: number }).annotationFillOpacity) ?? DEFAULT_STYLE.fillOpacity,
    bold: DEFAULT_STYLE.bold,
    ...capsFromObject(obj),
  };
}

/** Applies an edited style to an already-placed shape (as opposed to the
 * style used when a *new* shape is first drawn). */
export function applyStyleToObject(obj: FabricObject, style: AnnotationStyle): void {
  const dashArray = strokeDashArray(style);

  if (obj.type === 'group') {
    const [shaft, ...caps] = (obj as Group).getObjects();
    shaft?.set({ stroke: style.color, strokeWidth: style.strokeWidth, strokeDashArray: dashArray });
    caps.forEach((cap) => {
      // Which properties carry the colour depends on the cap's shape: an open
      // circle and a T-bar are stroke-only, an arrowhead is fill-only.
      switch (cap.get('capKind') as LineCap) {
        case 'open-circle':
        case 'tbar':
          cap.set({ stroke: style.color, strokeWidth: style.strokeWidth });
          break;
        case 'filled-circle':
          cap.set({ fill: style.color, stroke: style.color, strokeWidth: style.strokeWidth });
          break;
        default:
          cap.set({ fill: style.color });
      }
    });
    return;
  }

  if (obj.type === 'textbox') {
    (obj as Textbox).set({
      fill: style.color,
      fontSize: Math.max(16, style.strokeWidth * 6),
      fontWeight: style.bold ? 700 : 400,
    });
    return;
  }

  const isFillable = obj.type === 'rect' || obj.type === 'ellipse';
  obj.set({
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: dashArray,
    ...(isFillable
      ? { fill: withAlpha(style.color, style.fillOpacity), annotationFillOpacity: style.fillOpacity }
      : {}),
  });
}

export function createTextbox(point: XY, style: AnnotationStyle): Textbox {
  return new Textbox('Label', {
    left: point.x,
    top: point.y,
    fill: style.color,
    fontSize: Math.max(16, style.strokeWidth * 6),
    fontWeight: style.bold ? 700 : 400,
    fontFamily: 'Segoe UI, sans-serif',
    width: 140,
  });
}

export function createSmoothPath(points: XY[], style: AnnotationStyle): Path {
  return new Path(pointsToSmoothPathData(points), {
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    fill: '',
  });
}
