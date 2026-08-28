import { describe, it, expect } from 'vitest';
import { placeBesideRegion, overlaps, type Box, type Size } from './placeBesideRegion';

/** A page roughly the shape the real workspace renders: portrait letter. */
const PAGE: Size = { width: 1000, height: 1294 };
const PANEL: Size = { width: 300, height: 240 };

describe('placeBesideRegion', () => {
  it('puts the panel to the right of a region with room after it', () => {
    const region: Box = { x: 100, y: 300, width: 200, height: 40 };
    const p = placeBesideRegion(region, PANEL, PAGE);

    expect(p.side).toBe('right');
    expect(p.left).toBe(312);
    expect(p.top).toBe(300);
  });

  it('flips to the left when the region is against the right edge', () => {
    const region: Box = { x: 820, y: 300, width: 160, height: 40 };
    const p = placeBesideRegion(region, PANEL, PAGE);

    expect(p.side).toBe('left');
    expect(p.left).toBe(508);
    expect(p.left + PANEL.width).toBeLessThanOrEqual(region.x);
  });

  it('stays on the right when the region is against the left edge', () => {
    const region: Box = { x: 0, y: 300, width: 120, height: 40 };
    const p = placeBesideRegion(region, PANEL, PAGE);

    expect(p.side).toBe('right');
    expect(p.left).toBeGreaterThanOrEqual(region.x + region.width);
  });

  it('drops below a region too wide for either side', () => {
    const region: Box = { x: 20, y: 200, width: 960, height: 80 };
    const p = placeBesideRegion(region, PANEL, PAGE);

    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(region.y + region.height);
  });

  it('goes above a full-width region near the bottom, where below has no room', () => {
    const region: Box = { x: 20, y: 1150, width: 960, height: 80 };
    const p = placeBesideRegion(region, PANEL, PAGE);

    expect(p.side).toBe('above');
    expect(p.top + PANEL.height).toBeLessThanOrEqual(region.y);
  });

  describe('never leaves the page, wherever the region is', () => {
    // The four edges the coach actually hits, plus the corners between them.
    const cases: Array<[string, Box]> = [
      ['top edge', { x: 400, y: 0, width: 150, height: 30 }],
      ['bottom edge', { x: 400, y: 1264, width: 150, height: 30 }],
      ['left edge', { x: 0, y: 600, width: 150, height: 30 }],
      ['right edge', { x: 850, y: 600, width: 150, height: 30 }],
      ['top-left corner', { x: 0, y: 0, width: 90, height: 24 }],
      ['top-right corner', { x: 910, y: 0, width: 90, height: 24 }],
      ['bottom-left corner', { x: 0, y: 1270, width: 90, height: 24 }],
      ['bottom-right corner', { x: 910, y: 1270, width: 90, height: 24 }],
      ['full-width banner', { x: 0, y: 40, width: 1000, height: 60 }],
      ['tiny tapped word', { x: 512, y: 733, width: 64, height: 14 }],
    ];

    it.each(cases)('%s', (_name, region) => {
      const p = placeBesideRegion(region, PANEL, PAGE);

      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.left + PANEL.width).toBeLessThanOrEqual(PAGE.width);
      expect(p.top + PANEL.height).toBeLessThanOrEqual(PAGE.height);
    });

    it.each(cases)('%s does not cover the region', (_name, region) => {
      const p = placeBesideRegion(region, PANEL, PAGE);
      expect(overlaps(p, PANEL, region)).toBe(false);
    });
  });

  it('pins to the top-left rather than going negative when the panel exceeds the page', () => {
    // A narrow phone-sized page with a desktop-sized panel. Not a layout we
    // ship, but the arithmetic must not produce a panel positioned off-screen.
    const tiny: Size = { width: 200, height: 200 };
    const p = placeBesideRegion({ x: 10, y: 10, width: 40, height: 40 }, PANEL, tiny);

    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});
