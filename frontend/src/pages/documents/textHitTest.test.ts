import { describe, expect, it } from 'vitest';
import { RUN_PADDING, TAP_RADIUS, hitTest, paddedRect, regionAt } from './textHitTest';
import type { TextRun } from './textHitTest';

function run(text: string, x: number, y: number, width: number, height: number): TextRun {
  return { text, x, y, width, height };
}

/** A prose line: wide runs, tightly stacked. Measured at 23-27px median width
 *  and 77-89% crowded on real playbook install sheets. */
const proseLines = [
  run('FRONT RESPONSIBILITIES:', 0.1, 0.2, 0.25, 0.012),
  run('Vs Trips check to Cover 3', 0.1, 0.215, 0.3, 0.012),
  run('Front: Over G', 0.1, 0.23, 0.15, 0.012),
];

/** A formation diagram: one-character labels scattered across a field.
 *  Median 9-11px wide, but only 6-30% crowded. */
const diagramLabels = [
  run('X', 0.2, 0.5, 0.008, 0.01),
  run('M', 0.5, 0.45, 0.008, 0.01),
  run('SS', 0.75, 0.4, 0.012, 0.01),
];

describe('hitTest: point-in-box', () => {
  it('selects the run the tap landed inside', () => {
    expect(hitTest(proseLines, 0.2, 0.222)?.text).toBe('Vs Trips check to Cover 3');
  });

  it('selects a tiny diagram label tapped directly', () => {
    expect(hitTest(diagramLabels, 0.203, 0.505)?.text).toBe('X');
  });

  it('prefers the smaller run when boxes overlap', () => {
    // A smaller box inside a bigger one is the more specific target.
    const overlapping = [
      run('WHOLE LINE', 0.1, 0.2, 0.4, 0.02),
      run('COVER 3', 0.25, 0.203, 0.06, 0.014),
    ];
    expect(hitTest(overlapping, 0.27, 0.208)?.text).toBe('COVER 3');
  });
});

describe('hitTest: nearest-run fallback', () => {
  it('selects a tiny label tapped slightly off', () => {
    // THE case the radius exists for: a 9px label on a 1000px canvas is
    // nearly impossible to hit dead-on, and diagram labels are isolated
    // enough that the nearest one is unambiguous.
    const nearMiss = hitTest(diagramLabels, 0.5 + 0.006, 0.45 + 0.004);
    expect(nearMiss?.text).toBe('M');
  });

  it('picks the closest when two are within radius', () => {
    const pair = [run('A', 0.5, 0.5, 0.005, 0.005), run('B', 0.515, 0.5, 0.005, 0.005)];
    expect(hitTest(pair, 0.507, 0.502)?.text).toBe('A');
    expect(hitTest(pair, 0.513, 0.502)?.text).toBe('B');
  });

  it('returns nothing when the tap is on empty page', () => {
    // Empty page is a real answer, not a failure: it is how a coach starts a
    // drag over a diagram instead of selecting text.
    expect(hitTest(diagramLabels, 0.05, 0.05)).toBeNull();
  });

  it('does not reach past the radius', () => {
    expect(hitTest(diagramLabels, 0.2 + TAP_RADIUS * 2, 0.5)).toBeNull();
  });

  it('never lets the fallback steal a hit from a run that was actually hit', () => {
    // The ordering that makes ONE policy work for both page types. In dense
    // prose a radius would reach the line above or below; because a direct
    // hit always wins first, it never gets the chance.
    const inside = hitTest(proseLines, 0.2, 0.2205);
    expect(inside?.text).toBe('Vs Trips check to Cover 3');
  });

  it('works with no runs at all', () => {
    // A scanned page has an empty text layer, and the editor must behave
    // identically - drag stays first-class.
    expect(hitTest([], 0.5, 0.5)).toBeNull();
  });
});

describe('paddedRect', () => {
  it('grows the box outward on every side', () => {
    const rect = paddedRect(run('COVER 3', 0.2, 0.3, 0.1, 0.02));
    // A mask flush to the glyph box can leave a hairline of ink after
    // rounding, and a mask that leaks a sliver of the answer has failed.
    expect(rect.x).toBeCloseTo(0.2 - RUN_PADDING, 6);
    expect(rect.width).toBeCloseTo(0.1 + RUN_PADDING * 2, 6);
  });

  it('never pushes a region off the page', () => {
    const rect = paddedRect(run('EDGE', 0, 0, 1, 1));
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(1);
  });
});

describe('regionAt', () => {
  const regions = [
    { id: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } },
    { id: 2, rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.05 } },
  ];

  it('finds the region under the point', () => {
    expect(regionAt(regions, 0.15, 0.12)?.id).toBe(1);
  });

  it('returns null on empty page', () => {
    expect(regionAt(regions, 0.9, 0.9)).toBeNull();
  });

  it('prefers the smaller region when two overlap', () => {
    const nested = [
      { id: 1, rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 } },
      { id: 2, rect: { x: 0.15, y: 0.12, width: 0.05, height: 0.03 } },
    ];
    expect(regionAt(nested, 0.17, 0.13)?.id).toBe(2);
  });
});
