/// <reference types="node" />
// The reference above is deliberately file-scoped rather than adding "node"
// to tsconfig.app.json's `types`, which would put filesystem globals in scope
// for all browser code to satisfy one test. Vite's `?raw` import would avoid
// Node entirely but returns a stub here: vitest.config.ts sets `css: false`,
// which short-circuits every CSS import before `?raw` is honoured.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolvePath(here, path), 'utf-8');

const INDEX_CSS = read('../index.css');
const TOKENS_CSS = read('./tokens.css');
const NOTEBOOK_CSS = read('./notebook.module.css');
const ANNOTATION_TOOLBAR_CSS = read('../components/annotation/AnnotationToolbar.module.css');
const PLAY_PAGE_CSS = read('../pages/play/PlayPage.module.css');

/** Static contrast and token-scope audit for buttons.
 *
 * Two real bugs shipped before this existed, both making a button's label
 * unreadable, and neither producing any error:
 *
 *  1. `.btnDanger` set `color: var(--nb-warning-text)`. The --nb-* properties
 *     are declared on `.page`; ConfirmDialog renders inside a Modal that
 *     portals to document.body, OUTSIDE .page. A var() naming an undefined
 *     property invalidates its whole declaration, so `color` was dropped
 *     entirely and the button inherited near-white - over a background that
 *     had fallen through to index.css's light player palette. 1.06:1.
 *
 *  2. `.toolButton` set a background but no color. A <button> does not
 *     inherit color; the UA stylesheet gives it near-black. On the dark coach
 *     surface every annotation glyph disappeared.
 *
 * Neither is catchable by rendering: vitest runs with `css: false`, so jsdom
 * never loads these stylesheets and every computed colour would come back
 * empty. So this parses the CSS directly and resolves the var() chains the
 * way a browser would - in both scopes, because "which scope" IS the bug.
 */

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared in one block. Comments are stripped first -
 * tokens.css's header discusses ":root" in prose, and matching that instead
 * of the real declaration silently yields an empty table. */
function parseBlock(css: string, opener: RegExp): Record<string, string> {
  const clean = stripComments(css);
  const match = clean.match(opener);
  if (!match?.index) return {};
  const start = match.index + match[0].length;
  const block = clean.slice(start, clean.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const light = parseBlock(INDEX_CSS, /:root\s*\{/); // player theme, global :root
const tokens = parseBlock(TOKENS_CSS, /:root\s*\{/); // canonical tokens, global
/* Matched on .coachTokens, NOT on .page, and the difference is the whole
   point of this line. The coach aliases now live in a block selected by
   `.page, .coachTokens` - shared so that a coach surface which is not a page
   (the annotation workspace; the Modal backdrop, which portals out of .page)
   can opt into the same tokens. An opener of /\.page\s*\{/ silently stops
   matching that block and finds the later layout-only `.page {` rule instead,
   which declares no custom properties at all: COACH becomes an empty table,
   every coach var() resolves to null, and the suite reports a contrast
   failure for a button measured at 7.8:1 in a real browser. Match the token
   scope by its own name so the two cannot drift apart again. */
const page = parseBlock(NOTEBOOK_CSS, /\.coachTokens\s*\{/); // coach aliases, scoped

/** Inside the coach token scope (`.page` or `.coachTokens`): its aliases and
 * local re-declarations win. */
const COACH = [page, tokens, light];
/** Portalled to document.body: `.page` is not an ancestor, so only the two
 * global :root blocks apply. This is the scope the bug lived in. */
const PORTAL = [light, tokens];

function resolveVar(value: string | undefined, scope: Record<string, string>[], depth = 0): string | null {
  if (!value || depth > 10) return null;
  const trimmed = value.trim();
  const m = trimmed.match(/^var\((--[\w-]+)(?:\s*,\s*([\s\S]+))?\)$/);
  if (!m) return trimmed;
  const table = scope.find((t) => m[1] in t);
  if (table) return resolveVar(table[m[1]], scope, depth + 1);
  // Undefined property and no fallback: the browser discards the whole
  // declaration. Modelled as null so a test can assert on exactly that.
  return m[2] ? resolveVar(m[2], scope, depth + 1) : null;
}

type Rgba = [number, number, number, number];

function toRgba(color: string | null): Rgba | null {
  if (!color) return null;
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1).length === 3 ? [...c.slice(1)].map((x) => x + x).join('') : c.slice(1);
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1];
  }
  const n = c.match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  const alpha = n.length > 3 ? (c.includes('%') ? Number(n[3]) / 100 : Number(n[3])) : 1;
  return [Number(n[0]), Number(n[1]), Number(n[2]), alpha];
}

/** Flattens a translucent colour onto what sits behind it. Skipping this is
 * how a perfectly legible translucent-white button reads as 1.18:1. */
function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (u: number) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r / 255) + 0.7152 * f(g / 255) + 0.0722 * f(b / 255);
}

function contrastRatio(fg: Rgba, bg: Rgba): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG AA for normal-size text. Every button label here is under the
 * large-text threshold, so 3:1 is not available to any of them. */
const AA_NORMAL = 4.5;

function ratio(fgToken: string, bgToken: string | null, scope: Record<string, string>[], behind: string): number {
  const surface = toRgba(resolveVar(behind, scope));
  if (!surface) throw new Error(`could not resolve backdrop ${behind}`);
  let bg = bgToken ? toRgba(resolveVar(bgToken, scope)) : surface;
  if (!bg) throw new Error(`could not resolve background ${bgToken}`);
  if (bg[3] < 1) bg = composite(bg, surface);
  let fg = toRgba(resolveVar(fgToken, scope));
  if (!fg) throw new Error(`could not resolve foreground ${fgToken}`);
  if (fg[3] < 1) fg = composite(fg, bg);
  return contrastRatio(fg, bg);
}

describe('button contrast', () => {
  const cases: [name: string, fg: string, bg: string | null, scope: Record<string, string>[], behind: string][] = [
    // The regression. Both tokens must resolve OUTSIDE .page.
    ['ConfirmDialog delete (portalled)', 'var(--peira-danger)', 'var(--peira-danger-bg)', PORTAL, 'var(--peira-surface)'],
    ['ConfirmDialog cancel (portalled)', 'var(--peira-text)', null, PORTAL, 'var(--peira-surface)'],
    ['Annotation tool button', 'var(--color-text)', 'var(--color-surface)', COACH, 'var(--peira-bg)'],
    ['Annotation tool button, active', 'var(--color-primary-contrast)', 'var(--color-primary)', COACH, 'var(--peira-bg)'],
    ['Coach btnPrimary', 'var(--color-accent-contrast)', 'var(--nb-accent)', COACH, 'var(--peira-bg)'],
    ['Coach btnSecondary', 'var(--peira-text)', null, COACH, 'var(--peira-bg)'],
    ['Coach btnSm', 'var(--peira-text)', null, COACH, 'var(--peira-bg)'],
    ['Player btn-primary', 'var(--color-primary-contrast)', 'var(--color-primary)', PORTAL, 'var(--color-bg)'],
    ['Player btn-secondary', 'var(--color-text)', 'var(--color-surface)', PORTAL, 'var(--color-bg)'],
    ['Player btn-danger', 'var(--color-danger)', 'var(--color-surface)', PORTAL, 'var(--color-bg)'],
    ['Player btn-danger, hover', 'var(--color-danger)', 'var(--color-danger-bg)', PORTAL, 'var(--color-bg)'],
    ['Player name button', 'var(--color-text)', 'var(--color-surface)', PORTAL, 'var(--color-bg)'],
    ['Player name button, active', 'var(--color-text)', 'var(--color-primary-bg)', PORTAL, 'var(--color-bg)'],
  ];

  it.each(cases)('%s clears WCAG AA', (_name, fg, bg, scope, behind) => {
    expect(ratio(fg, bg, scope, behind)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('token scope', () => {
  /** Classes ConfirmDialog applies. It renders through the portalled Modal,
   * so anything these rules reference must exist on a global :root. */
  const PORTALLED_CLASSES = ['btnSm', 'btnDanger'];

  it.each(PORTALLED_CLASSES)('.%s resolves every colour outside .page', (className) => {
    const clean = stripComments(NOTEBOOK_CSS);
    const rules = [...clean.matchAll(/\.([\w-]+)([^{}]*)\{([^{}]*)\}/g)].filter((m) => m[1] === className);
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      for (const [, prop, value] of rule[3].matchAll(/(color|background|background-color|border-color)\s*:\s*([^;]+)/g)) {
        if (value.trim() === 'transparent' || value.trim() === 'none') continue;
        expect(
          resolveVar(value, PORTAL),
          `.${className} { ${prop}: ${value.trim()} } does not resolve outside .page. ` +
            `--nb-* properties are declared on .page only, and a var() naming an undefined ` +
            `property invalidates the whole declaration - the button silently loses this ` +
            `property. Use the canonical --peira-* / --color-* token instead.`,
        ).not.toBeNull();
      }
    }
  });
});

describe('buttons declare their own text colour', () => {
  /** A <button> does not inherit `color`; the UA stylesheet sets it to
   * near-black. Any button class that paints a background must therefore
   * also state a colour, or it depends on the surface happening to be light. */
  const BUTTON_LIKE = /(^|[^\w-])(btn|button|toolButton|nameButton)/i;

  const sources: [string, string][] = [
    ['index.css', INDEX_CSS],
    ['styles/notebook.module.css', NOTEBOOK_CSS],
    ['components/annotation/AnnotationToolbar.module.css', ANNOTATION_TOOLBAR_CSS],
    ['pages/play/PlayPage.module.css', PLAY_PAGE_CSS],
  ];

  it.each(sources)('%s: every button class that sets a background also sets a color', (_file, css) => {
    const clean = stripComments(css);
    const setsBackground = new Set<string>();
    const setsColor = new Set<string>();

    for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const [, , name] of selector.matchAll(/(^|[\s.,:#>~+])\.?([\w-]+)/g)) {
        if (!BUTTON_LIKE.test(name)) continue;
        const bg = body.match(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+)/);
        if (bg && !/transparent|none|inherit/.test(bg[1])) setsBackground.add(name);
        if (/(?:^|[\s;])color\s*:/.test(body)) setsColor.add(name);
      }
    }

    const missing = [...setsBackground].filter((c) => !setsColor.has(c));
    expect(
      missing,
      `these button classes paint a background but never declare a text colour, so they ` +
        `render with the browser's near-black default: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
