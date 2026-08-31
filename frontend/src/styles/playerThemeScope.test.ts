/// <reference types="node" />
// File-scoped, matching buttonContrast.test.ts: adding "node" to
// tsconfig.app.json's `types` would put filesystem globals in scope for all
// browser code to satisfy one test.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolvePath(here, p), 'utf-8');

const INDEX_CSS = read('../index.css');
const PLAYER_CSS = read('./player.module.css');
const NOTEBOOK_CSS = read('./notebook.module.css');

/** THE GUARD THAT MAKES A DARK PLAYER THEME SAFE TO SHIP.
 *
 * The player palette used to BE `index.css`'s global `:root`, which is also
 * the fallback every unscoped surface in the app resolves against. Repainting
 * it dark would have silently repainted coach surfaces, login, register and
 * the public home page - the failure class recorded in CLAUDE.md "Things that
 * will bite you" #1.
 *
 * `.playerTheme` (styles/player.module.css) now owns the player quiz palette,
 * and `:root` keeps the base. These tests protect the property that makes
 * that separation worth having: **every themed colour the player flow reads
 * must be declared on the scope**, because anything that is not declared
 * there silently falls through to the base palette and will simply stay light
 * when the rest of the player experience goes dark.
 *
 * That failure is invisible - no error, no warning, just one cream control on
 * a dark screen - which is exactly why it is asserted rather than eyeballed.
 */

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared by the first block matching `opener`. */
function declaredIn(css: string, opener: RegExp): Set<string> {
  const clean = stripComments(css);
  const m = clean.match(opener);
  if (!m?.index) return new Set();
  const start = m.index + m[0].length;
  const block = clean.slice(start, clean.indexOf('}', start));
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
}

const base = declaredIn(INDEX_CSS, /:root\s*\{/);
// The palette is declared on the CONDITIONAL ROOT, not on the marker class -
// see the long note in player.module.css. `body` is an ancestor of the player
// wrapper, so a palette living on the wrapper is invisible to it.
const playerScope = declaredIn(PLAYER_CSS, /:root:has\(\.playerTheme\)\s*\{/);

/** Structural, not thematic: the same typeface and the same corner radii are
 *  wanted by every theme, so they stay on `:root` on purpose. */
const STRUCTURAL = new Set(['--font-sans', '--radius-sm', '--radius-md']);

describe('the player theme is an explicit scope', () => {
  it('declares every themed colour the base palette defines', () => {
    const themed = [...base].filter((t) => !STRUCTURAL.has(t));
    const missing = themed.filter((t) => !playerScope.has(t));
    expect(missing).toEqual([]);
  });

  it('leaves structural tokens on the base rather than duplicating them', () => {
    // Duplicating every root variable into the scope would move the ambiguity
    // rather than remove it. Radii and the typeface are not theme decisions.
    for (const t of STRUCTURAL) {
      expect(base.has(t)).toBe(true);
      expect(playerScope.has(t)).toBe(false);
    }
  });

  it('repaints the body behind the player wrapper', () => {
    // The wrapper does not cover the viewport, and overscroll on a touch
    // device exposes whatever is behind it. Without this the base colour
    // shows through the moment the two palettes diverge.
    expect(stripComments(PLAYER_CSS)).toMatch(/:root:has\(\.playerTheme\)\s+body/);
  });
});

describe('every colour the player flow reads is on the scope', () => {
  /** Every custom property referenced by CSS under pages/play/. */
  function playerFlowTokens(): Set<string> {
    const dir = resolvePath(here, '../pages/play');
    const found = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.css')) continue;
      const css = stripComments(readFileSync(resolvePath(dir, f), 'utf-8'));
      for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) found.add(m[1]);
    }
    return found;
  }

  it('declares every base-palette token the player CSS consumes', () => {
    // Only tokens the BASE defines are checked: the player flow also reads
    // --peira-* names, which tokens.css declares globally and which are not
    // this scope's business.
    const consumed = [...playerFlowTokens()].filter((t) => base.has(t) && !STRUCTURAL.has(t));
    expect(consumed.length).toBeGreaterThan(0);
    const unscoped = consumed.filter((t) => !playerScope.has(t));
    expect(unscoped).toEqual([]);
  });
});

describe('the coach theme stays a separate scope', () => {
  it('does not declare the player scope', () => {
    expect(NOTEBOOK_CSS).not.toContain('playerTheme');
  });

  it('still overrides the base tokens it shares with the player theme', () => {
    // `.page` / `.coachTokens` shadowing these is what keeps coach surfaces
    // reading coach values rather than whatever the base happens to hold.
    const coach = declaredIn(NOTEBOOK_CSS, /\.page,\s*\n?\.coachTokens\s*\{/);
    for (const t of ['--color-bg', '--color-surface', '--color-border', '--color-text']) {
      expect(coach.has(t)).toBe(true);
    }
  });
});
