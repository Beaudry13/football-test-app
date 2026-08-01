import { Circle, Ellipse, Group, Line, Path, Rect, Textbox, Triangle, type FabricObject, type XY } from 'fabric';
import { pointsToSmoothPathData } from './curveUtils';
import { DEFAULT_STYLE, type AnnotationStyle } from './types';

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

export function createLine(start: XY, end: XY, style: AnnotationStyle): Line {
  return new Line([start.x, start.y, end.x, end.y], {
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    strokeLineCap: 'round',
    // Read by the endpoint-drag hit-test in AnnotationCanvas.tsx - lets a
    // placed line be reshaped by dragging either end, instead of only via
    // the default resize/rotate bounding-box handles.
    hasEditableEndpoints: true,
    segStart: { x: start.x, y: start.y },
    segEnd: { x: end.x, y: end.y },
  });
}

/** An arrow is a line grouped with a triangular head pointing from start to end. */
export function createArrow(start: XY, end: XY, style: AnnotationStyle): Group {
  const angleDeg = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
  const headSize = Math.max(10, style.strokeWidth * 4);

  const shaft = new Line([start.x, start.y, end.x, end.y], {
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    strokeDashArray: strokeDashArray(style),
    strokeLineCap: 'round',
  });

  const head = new Triangle({
    left: end.x,
    top: end.y,
    originX: 'center',
    originY: 'center',
    width: headSize,
    height: headSize,
    fill: style.color,
    angle: angleDeg + 90,
  });

  const group = new Group([shaft, head]);
  group.set({
    isArrow: true,
    hasEditableEndpoints: true,
    segStart: { x: start.x, y: start.y },
    segEnd: { x: end.x, y: end.y },
  });
  return group;
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
    // arrow: [shaft line, head triangle] - the shaft carries the real style.
    const shaft = (obj as Group).getObjects()[0] as FabricObject | undefined;
    const dashArray = shaft?.strokeDashArray;
    return {
      color: (shaft?.stroke as string) || DEFAULT_STYLE.color,
      strokeWidth: (shaft?.strokeWidth as number) ?? DEFAULT_STYLE.strokeWidth,
      dashed: Array.isArray(dashArray) && dashArray.length > 0,
      fillOpacity: DEFAULT_STYLE.fillOpacity,
    };
  }
  if (obj.type === 'textbox') {
    const fontSize = (obj as Textbox).fontSize ?? 16;
    return {
      color: (obj.fill as string) || DEFAULT_STYLE.color,
      // Reverses createTextbox's fontSize = max(16, strokeWidth * 6), so the
      // Width slider doubles as a font-size control for text labels.
      strokeWidth: Math.max(1, Math.round(fontSize / 6)),
      dashed: false,
      fillOpacity: DEFAULT_STYLE.fillOpacity,
    };
  }
  const dashArray = obj.strokeDashArray;
  return {
    color: (obj.stroke as string) || DEFAULT_STYLE.color,
    strokeWidth: (obj.strokeWidth as number) ?? DEFAULT_STYLE.strokeWidth,
    dashed: Array.isArray(dashArray) && dashArray.length > 0,
    fillOpacity:
      ((obj as unknown as { annotationFillOpacity?: number }).annotationFillOpacity) ?? DEFAULT_STYLE.fillOpacity,
  };
}

/** Applies an edited style to an already-placed shape (as opposed to the
 * style used when a *new* shape is first drawn). */
export function applyStyleToObject(obj: FabricObject, style: AnnotationStyle): void {
  const dashArray = strokeDashArray(style);

  if (obj.type === 'group') {
    const [shaft, head] = (obj as Group).getObjects();
    shaft?.set({ stroke: style.color, strokeWidth: style.strokeWidth, strokeDashArray: dashArray });
    head?.set({ fill: style.color });
    return;
  }

  if (obj.type === 'textbox') {
    (obj as Textbox).set({ fill: style.color, fontSize: Math.max(16, style.strokeWidth * 6) });
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
