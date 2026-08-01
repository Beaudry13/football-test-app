import { describe, expect, it } from 'vitest';
import { pointsToSmoothPathData } from './curveUtils';

describe('pointsToSmoothPathData', () => {
  it('returns an empty string for fewer than two points', () => {
    expect(pointsToSmoothPathData([])).toBe('');
    expect(pointsToSmoothPathData([{ x: 1, y: 1 }])).toBe('');
  });

  it('draws a straight line segment for exactly two points', () => {
    expect(pointsToSmoothPathData([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe('M 0 0 L 10 20');
  });

  it('starts at the first point and ends at the last for three or more points', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }, { x: 30, y: 5 }];

    const path = pointsToSmoothPathData(points);

    expect(path.startsWith('M 0 0')).toBe(true);
    expect(path.endsWith('30 5')).toBe(true);
  });

  it('emits one cubic bezier segment per point-to-point span', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];

    const path = pointsToSmoothPathData(points);

    expect(path.match(/C /g)).toHaveLength(points.length - 1);
  });

  it('degenerates to a flat curve for collinear points (control points stay on the line)', () => {
    const points = [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 5 }];

    const path = pointsToSmoothPathData(points);
    const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const yCoordinates = numbers.filter((_, i) => i % 2 === 1);

    expect(yCoordinates.every((y) => Math.abs(y - 5) < 1e-9)).toBe(true);
  });
});
