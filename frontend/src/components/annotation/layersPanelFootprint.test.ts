import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** THE IMAGE MUST NOT SHRINK AS A COACH DRAWS ON IT.
 *
 * The Layers panel is a flex item in AnnotationCanvas's column, sitting beside
 * `.canvasWrap`, which is `flex-grow: 1`. While the panel was `max-height`, it
 * GREW one row per object - and every pixel it took came out of the canvas,
 * whose ResizeObserver re-ran applyFit() against the smaller box and rewrote
 * --fit-w/--fit-h. Measured in a real browser on one 800x600 image:
 *
 *      shapes   canvas height   displayed image
 *           0             579         772 x 579
 *           1             545         727 x 545
 *           6             375         500 x 375
 *          14             115         153 x 115
 *
 * This is asserted against the STYLESHEET rather than a rendered layout
 * because jsdom performs no layout at all - it has no flexbox, so a rendering
 * test here would pass no matter what these rules said. The fixed basis is the
 * whole fix, so the fixed basis is what is guarded.
 */
const CSS = readFileSync(join(__dirname, 'LayersPanel.module.css'), 'utf8');

function panelRule(): string {
  // The base .panel rule, up to its closing brace.
  const start = CSS.indexOf('.panel {');
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('}', start));
}

describe('the Layers panel footprint', () => {
  it('is a FIXED size, so object count cannot change it', () => {
    expect(panelRule()).toMatch(/flex:\s*0\s+0\s+\S+/);
  });

  it('never sizes itself from its content', () => {
    // max-height lets the panel grow with the list; that growth was the bug.
    const rule = panelRule();
    expect(rule).not.toMatch(/max-height/);
    expect(rule).not.toMatch(/height:\s*(auto|fit-content|max-content)/);
  });

  it('scrolls its list instead of claiming more room', () => {
    expect(panelRule()).toMatch(/overflow-y:\s*auto/);
  });

  it('keeps the footprint fixed at phone widths too', () => {
    // The narrow override must also pin the size rather than cap it.
    const media = CSS.slice(CSS.indexOf('@media (max-width: 40rem)'));
    expect(media).toMatch(/flex:\s*0\s+0\s+\S+/);
    expect(media).not.toMatch(/max-height/);
  });
});
