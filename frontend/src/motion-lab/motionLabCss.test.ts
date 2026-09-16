/// <reference types="node" />
// File-scoped Node types, matching styles/buttonContrast.test.ts. The CSS is
// read from disk because vitest.config.ts sets `css: false`.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * MOTION LAB'S STYLES CANNOT REACH THE REST OF PEIRA.
 *
 * A stylesheet a route imports stays loaded for the whole session, so an
 * unscoped rule does not stay inside Motion Lab - it restyles every PEIRA page
 * visited afterwards. The prototype's styles.css had exactly those rules
 * (:root, *, body, bare button). This pins that motionLab.css cannot match
 * anything outside .motion-lab-root, and that scoping changed selectors only.
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(here, p), 'utf-8').replace(/\r\n/g, '\n')
const SCOPED = read('./motionLab.css')
const PROTOTYPE = read('../../../prototypes/motion-lab/src/styles.css')
const ROOT = '.motion-lab-root'

interface Rule {
  prelude: string
  body: string
}

/** Top-level rules; an @keyframes block is one rule with its body intact. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open === -1) break
    let depth = 0
    let end = open
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}' && --depth === 0) break
    }
    out.push({ prelude: text.slice(i, open).trim(), body: text.slice(open + 1, end).trim() })
    i = end + 1
  }
  return out
}

const declarations = (body: string) =>
  body
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)

describe('motionLab.css scoping', () => {
  const scoped = rules(SCOPED)

  it('every selector is .motion-lab-root or inside it', () => {
    const offenders: string[] = []
    for (const r of scoped) {
      if (r.prelude.startsWith('@keyframes')) continue
      for (const selector of r.prelude.split(',').map((s) => s.trim())) {
        if (selector !== ROOT && !selector.startsWith(`${ROOT} `)) offenders.push(selector)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has no document-level selectors left', () => {
    const selectors = scoped.filter((r) => !r.prelude.startsWith('@')).flatMap((r) => r.prelude.split(',').map((s) => s.trim()))
    expect(selectors.filter((s) => /(^|\s)(:root|html|body)(\s|$|[.:[#])/.test(s))).toEqual([])
  })

  it('declares its custom properties only on the root', () => {
    const where = scoped.filter((r) => /(^|;)\s*--[\w-]+\s*:/.test(r.body)).map((r) => r.prelude)
    expect(where).toEqual([ROOT])
  })

  it('names its keyframes motion-lab-* and only animates with those', () => {
    const names = scoped.filter((r) => r.prelude.startsWith('@keyframes')).map((r) => r.prelude.split(/\s+/)[1])
    expect(names).toEqual(['motion-lab-toast-in', 'motion-lab-catch-pulse'])
    const used = [...SCOPED.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1])
    expect(used.every((n) => names.includes(n))).toBe(true)
  })

  it('changes selectors only: every rule keeps the prototype\'s declarations, in order', () => {
    const proto = rules(PROTOTYPE)
    expect(scoped).toHaveLength(proto.length)
    proto.forEach((p, i) => {
      const s = scoped[i]
      let expected = declarations(p.body)
      if (p.prelude === 'body') expected = ['position: fixed', 'inset: 0', ...expected]
      const rename = (d: string) => d.replace(/\btoast-in\b/, 'motion-lab-toast-in').replace(/\bcatch-pulse\b/, 'motion-lab-catch-pulse')
      if (p.prelude.startsWith('@keyframes')) {
        expect(s.body.replace(/\s+/g, ' ')).toBe(p.body.replace(/\s+/g, ' '))
      } else {
        expect(declarations(s.body), `${p.prelude} -> ${s.prelude}`).toEqual(expected.map(rename))
      }
    })
  })
})

describe('a PEIRA element next to a loaded Motion Lab stylesheet', () => {
  afterEach(() => {
    document.head.querySelectorAll('style[data-test]').forEach((s) => s.remove())
    document.body.innerHTML = ''
  })

  function peiraButton() {
    const button = document.createElement('button')
    button.className = 'btn primary active'
    document.body.appendChild(button)
    return button
  }

  function load(css: string) {
    const style = document.createElement('style')
    style.dataset.test = ''
    style.textContent = css
    document.head.appendChild(style)
  }

  const observed = (el: Element) => {
    const cs = getComputedStyle(el)
    return { borderRadius: cs.borderRadius, padding: cs.padding, cursor: cs.cursor, whiteSpace: cs.whiteSpace }
  }

  it('control: the UNSCOPED prototype stylesheet does restyle it (so this test can see a leak)', () => {
    const before = observed(peiraButton())
    load(PROTOTYPE)
    expect(observed(document.querySelector('button')!)).not.toEqual(before)
  })

  it('the scoped stylesheet leaves it exactly as it was', () => {
    const before = observed(peiraButton())
    load(SCOPED)
    expect(observed(document.querySelector('button')!)).toEqual(before)
  })

  it('while the same markup inside the root is styled', () => {
    load(SCOPED)
    const root = document.createElement('div')
    root.className = 'motion-lab-root'
    const inside = document.createElement('button')
    root.appendChild(inside)
    document.body.appendChild(root)
    const outside = peiraButton()
    expect(observed(inside)).not.toEqual(observed(outside))
  })
})
