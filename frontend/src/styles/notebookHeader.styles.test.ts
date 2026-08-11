import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Guards the shared sticky header's opacity and layering.
 *
 * WHY A STYLESHEET TEST. The header once used `rgba(20, 20, 20, 0.7)` with a
 * backdrop blur. Quiz cards, folder controls and Duplicate/Delete buttons
 * scrolled underneath and stayed legible THROUGH the navigation. jsdom does
 * not apply CSS-module styles, so a rendered-component test cannot see a
 * colour at all - the stylesheet is where the bug lived and where it has to
 * be caught.
 *
 * These assertions are deliberately about the two things that actually broke:
 * the header must be opaque, and it must not outrank the overlays that are
 * supposed to sit above it.
 */

const CSS = readFileSync(join(__dirname, 'notebook.module.css'), 'utf8');

function ruleBody(selector: string): string {
  // Matches `.header {` but not `.headerActions {`, then takes the body.
  const pattern = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`);
  const match = CSS.match(pattern);
  if (!match) throw new Error(`rule ${selector} not found in notebook.module.css`);
  // Comments stripped before anything is asserted. The rule EXPLAINS why the
  // backdrop filter was removed, and a naive scan reads that explanation as
  // the declaration it documents - a check that fails on its own comment is a
  // check the next person deletes.
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('shared sticky header', () => {
  const header = ruleBody('.header');
  const mask = ruleBody('.header::before');

  it('has a fully opaque background', () => {
    const background = header.match(/background:\s*([^;]+);/)?.[1] ?? '';
    expect(background).toBeTruthy();
    // The exact failure: a translucent header lets page content read through.
    expect(background).not.toMatch(/rgba\s*\(/);
    expect(background).not.toMatch(/transparent/);
    expect(background).not.toMatch(/hsla\s*\(/);
  });

  it('does not rely on a backdrop filter to hide content', () => {
    // Blur softens what shows through; it does not stop it showing through.
    expect(header).not.toMatch(/backdrop-filter/);
  });

  it('stays sticky', () => {
    expect(header).toMatch(/position:\s*sticky/);
    expect(header).toMatch(/top:/);
  });

  it('keeps a z-index below every overlay', () => {
    const z = Number(header.match(/z-index:\s*(-?\d+)/)?.[1]);
    expect(z).toBe(10);
    // Help menu 40, modals and the tour 100, drawing board 1000. Raising the
    // header to "fix" a paint bug would put it over its own dropdowns.
    expect(z).toBeLessThan(40);
  });

  it('masks the gap around the floating pill', () => {
    // The pill is inset from the viewport, so its margins were bare gaps that
    // content scrolled through with nothing covering it.
    expect(mask).toMatch(/position:\s*absolute/);
    expect(mask).toMatch(/background:/);
    expect(mask).not.toMatch(/rgba\s*\(/);
    // Negative insets are what carry it out over those margins.
    expect(mask).toMatch(/top:\s*calc\(-1/);
    expect(mask).toMatch(/left:\s*calc\(-1/);
    expect(mask).toMatch(/right:\s*calc\(-1/);
    // Behind the pill, but still inside the header's stacking context.
    expect(mask).toMatch(/z-index:\s*-1/);
    // It must never swallow clicks meant for the page beneath.
    expect(mask).toMatch(/pointer-events:\s*none/);
  });

  it('covers exactly the header offsets, so no strip is left bare', () => {
    const top = header.match(/top:\s*var\(--space-(\d)\)/)?.[1];
    const margin = header.match(/margin:\s*var\(--space-\d\)\s*var\(--space-(\d)\)/)?.[1];
    // The mask's negative insets must match the header's own offsets, or a
    // band of content stays visible beside or above the pill.
    expect(mask).toMatch(new RegExp(`top:\\s*calc\\(-1 \\* var\\(--space-${top}\\)\\)`));
    expect(mask).toMatch(new RegExp(`left:\\s*calc\\(-1 \\* var\\(--space-${margin}\\)\\)`));
    expect(mask).toMatch(new RegExp(`right:\\s*calc\\(-1 \\* var\\(--space-${margin}\\)\\)`));
  });
});
