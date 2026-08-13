/**
 * The join code must always fit inside its card.
 *
 * WHY THIS TEST READS CSS TEXT INSTEAD OF MEASURING A RENDER
 * ----------------------------------------------------------
 * jsdom has no layout engine: every getBoundingClientRect() is 0x0 and no
 * container query ever resolves, so a rendering test here would pass whatever
 * the stylesheet said. The real geometry was verified in a browser across
 * 1920x1080, 1366x768, 1280x720, 1024x700 and 375x812 with the widest codes
 * the join alphabet can produce. What THIS test protects is the invariant
 * those measurements rest on, which is the thing that actually regressed.
 *
 * THE BUG IT EXISTS TO CATCH
 * ---------------------------
 * The code was sized `clamp(3rem, 13vw, 8rem)`. 13vw is 13% of the SCREEN,
 * while the card is a grid track measured in rem - two unrelated quantities,
 * so the bigger the display the worse the mismatch. On a 1920x1080 projector
 * that produced 128px type and 647px of text inside a 328px card: 319px of
 * overflow, painted straight over the roster, and invisible as a scrollbar
 * only because .stage sets overflow-x: hidden. It reached production.
 *
 * The fix sizes the code in `cqi` - a share of the card's own content box - so
 * the fit no longer depends on the viewport at all. These assertions fail if
 * anyone reintroduces viewport sizing, removes the container, or widens the
 * type past what the widest six characters can occupy.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CSS = readFileSync(join(__dirname, 'Competition.module.css'), 'utf8');

/** The body of a single top-level rule, by selector. */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `${selector} should exist in Competition.module.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('\n}', open);
  return CSS.slice(open + 1, close);
}

/**
 * Measured in the browser, in the shipped font at weight 800: the glyph
 * advance of the widest six characters the join alphabet can produce.
 *
 * JOIN_ALPHABET is "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", so W is available and
 * WWWWWW is a code a coach can genuinely be handed. For reference the others
 * measured MWMWMW 6.006em, MMMMMM 5.660em, ZLMU88 4.206em, 888888 3.873em.
 */
const WIDEST_SIX_CHARS_EM = 6.4552;

describe('the join code always fits its card', () => {
  const code = rule('.code');
  const panel = rule('.codePanel');

  it('sizes the code from its CONTAINER, never from the viewport', () => {
    // THE REGRESSION. `vw` here is what shipped the overflow to production.
    expect(code).not.toMatch(/font-size:[^;]*\bvw\b/);
    expect(code).toMatch(/font-size:\s*[\d.]+cqi/);
  });

  it('declares the card as the container those units resolve against', () => {
    // Without this, cqi silently falls back to the viewport - the same bug
    // wearing different units.
    expect(panel).toMatch(/container-type:\s*inline-size/);
  });

  it('keeps a fallback for engines without container query units', () => {
    // Declared before the cqi rule, so an engine that drops the second still
    // gets something that fits the narrowest card.
    const sizes = [...code.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    expect(sizes[0]).not.toContain('cqi');
    expect(sizes[sizes.length - 1]).toContain('cqi');
  });

  it('never asks for more width than six of the widest characters can use', () => {
    const size = Number(/font-size:\s*([\d.]+)cqi/.exec(code)?.[1]);
    const spacing = Number(/letter-spacing:\s*([\d.]+)em/.exec(code)?.[1]);
    expect(Number.isFinite(size)).toBe(true);
    expect(Number.isFinite(spacing)).toBe(true);

    // CSS adds letter-spacing after EVERY character including the last; the
    // rule reclaims that trailing gap with a negative margin, so six
    // characters cost five gaps.
    const trailingReclaimed = /margin-inline-end:\s*-([\d.]+)em/.test(code);
    expect(trailingReclaimed).toBe(true);
    const emsNeeded = WIDEST_SIX_CHARS_EM + 5 * spacing;

    // Percentage of the card one em may occupy before WWWWWW overflows.
    const maxCqi = 100 / emsNeeded;
    expect(size).toBeLessThanOrEqual(maxCqi);

    // And it must not be so timid that the code stops being the lobby's hero.
    expect(size).toBeGreaterThan(maxCqi * 0.9);
  });

  it('lets the left column scale with the room rather than pinning it', () => {
    // A fixed rem cap made the hero the same pixel width on a 13" laptop and a
    // lecture-hall projector, which is what forced the type to chase the
    // viewport in the first place.
    const twoColumn = /\.hostGrid \{\s*grid-template-columns:([^;]+);/.exec(CSS);
    expect(twoColumn?.[1]).toContain('%');
  });
});
