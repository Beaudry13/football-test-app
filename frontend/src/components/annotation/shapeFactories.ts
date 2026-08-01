import { Ellipse, Group, Line, Path, Rect, Textbox, Triangle, type XY } from 'fabric';
import { pointsToSmoothPathData } from './curveUtils';
import type { AnnotationStyle } from './types';

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

  return new Group([shaft, head]);
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
