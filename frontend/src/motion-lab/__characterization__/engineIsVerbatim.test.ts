/// <reference types="node" />
// File-scoped Node types, matching styles/buttonContrast.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { capturePlay } from './capture'
import { engineUnderTest } from './engineUnderTest'
import { prototypeEngine } from './prototypeEngine'
import { gapPlays, panePlays } from './fixtures'

/**
 * P1 RULE: THE ENGINE MOVED, IT DID NOT CHANGE.
 *
 * The goldens prove behaviour on the fixtures. This proves it for every play
 * a coach could author, by showing there is nothing different to behave
 * differently: PEIRA's engine files ARE the preserved prototype's files.
 *
 * If a later phase changes the engine on purpose, this test is where that
 * decision becomes visible - update it deliberately, with the reason, never
 * to make a diff go away.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PROTOTYPE = resolve(here, '../../../../prototypes/motion-lab/src')
const ENGINE = resolve(here, '../engine')
const VIEW = resolve(here, '../view')
// Line endings are a checkout setting (core.autocrlf), not source.
const read = (path: string) => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')

/** Seven of the nine, still byte-for-byte the prototype's. */
const VERBATIM_FILES = ['field', 'geometry', 'formation', 'timeline', 'ball', 'orientation', 'perspective']
const ALL_ENGINE_FILES = [...VERBATIM_FILES, 'interactions', 'play']

/**
 * THE ONE APPROVED DIVERGENCE (ML-UX-5, owner decision, 20 September 2026).
 *
 * `Engagement` gained a single optional field, `auto`, meaning "PEIRA chose
 * this meeting point, not the coach" - so the editor can keep an inferred
 * point on the end of a blocker's path as that path is redrawn. It had to go
 * on the STORED object: `sanitizePlay` rebuilds engagements field by field
 * and drops anything it does not name, so an editor-side flag would not have
 * survived a reload, and reload behaviour is the whole point of the field.
 *
 * These two files are NOT exempted. Their diff against the prototype is taken
 * line by line, every added line must match one of the patterns below, and
 * nothing may be removed or reworded. A second change - to these files, or
 * smuggled in under this one's name - fails here.
 */
const APPROVED_DIVERGENCE = [
  {
    file: 'interactions',
    // The field, and the comment block that explains it.
    added: [/^\s*auto\?: boolean$/, /^\s*(\/\*\*|\*\/|\*(\s.*)?)$/],
    // Purely additive: the prototype's type is untouched.
    removed: [],
  },
  {
    file: 'play',
    // Normalise it when present, leave it absent when absent, carry it
    // through, and explain why.
    added: [
      /^\s*const auto = 'auto' in x \? \{ auto: x\.auto === true \} : null$/,
      /^\s*return \{ id: .*, release, \.\.\.auto \}$/,
      /^\s*\/\/.*$/,
    ],
    // ONE prototype line may change: the engagement's return, which now also
    // spreads `auto`. Nothing else in the file may be touched.
    removed: [/^\s*return \{ id: .*, point: x\.point, release \}$/],
  },
]

/** Lines in `after` that are not in `before`, counting duplicates. */
function addedLines(before: string, after: string): string[] {
  const seen = new Map<string, number>()
  for (const line of before.split('\n')) seen.set(line, (seen.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of after.split('\n')) {
    const n = seen.get(line) ?? 0
    if (n > 0) seen.set(line, n - 1)
    else out.push(line)
  }
  return out
}

const diverges = (name: string) => read(resolve(ENGINE, `${name}.ts`)) !== read(resolve(PROTOTYPE, `${name}.ts`))

describe('engine source', () => {
  it.each(VERBATIM_FILES)('%s.ts is byte-identical to the preserved prototype', (name) => {
    expect(read(resolve(ENGINE, `${name}.ts`))).toBe(read(resolve(PROTOTYPE, `${name}.ts`)))
  })

  it('exactly two files diverge, and they are the two that were approved', () => {
    expect(ALL_ENGINE_FILES.filter(diverges).sort()).toEqual(['interactions', 'play'])
  })

  it.each(APPROVED_DIVERGENCE)('$file.ts differs only by the approved Engagement.auto contract', ({ file, added, removed }) => {
    const proto = read(resolve(PROTOTYPE, `${file}.ts`))
    const peira = read(resolve(ENGINE, `${file}.ts`))

    // Nothing the prototype says may be dropped or reworded, beyond the one
    // line each entry above names.
    for (const line of addedLines(peira, proto).filter((l) => l.trim())) {
      expect(
        removed.some((re) => re.test(line)),
        `${file}.ts removed or changed a prototype line outside the approved contract:\n  ${line}`,
      ).toBe(true)
    }

    const newLines = addedLines(proto, peira).filter((l) => l.trim())
    expect(newLines.length, `${file}.ts added nothing`).toBeGreaterThan(0)
    for (const line of newLines) {
      expect(
        added.some((re) => re.test(line)),
        `${file}.ts added a line outside the approved contract:\n  ${line}`,
      ).toBe(true)
    }
  })

  it('the divergence is a type and a default, never engine behaviour', () => {
    // `auto` is coach intent, and the editor owns every behaviour attached to
    // it. The moment an engine module READS it, the engine has gained
    // behaviour it did not have, and this stops being a paper change.
    const allowed: Record<string, RegExp[]> = {
      interactions: [/^\s*auto\?: boolean$/],
      play: [/const auto = 'auto' in x \? \{ auto: x\.auto === true \} : null$/, /, release, \.\.\.auto \}$/],
    }
    for (const name of ALL_ENGINE_FILES) {
      const lines = read(resolve(ENGINE, `${name}.ts`))
        .split('\n')
        .filter((l) => /\bauto\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const line of lines) {
        expect(
          (allowed[name] ?? []).some((re) => re.test(line)),
          `${name}.ts uses \`auto\` in engine code:\n  ${line}`,
        ).toBe(true)
      }
    }
  })
})

describe('field views', () => {
  // The only change: they now import the engine from ../engine/ instead of
  // sitting beside it.
  it.each(['FieldMarkings', 'FieldView'])('%s.tsx differs from the prototype only in its engine import paths', (name) => {
    const peira = read(resolve(VIEW, `${name}.tsx`)).replace(/from '\.\.\/engine\//g, "from './")
    expect(peira).toBe(read(resolve(PROTOTYPE, `${name}.tsx`)))
  })
})

describe('prototype and PEIRA engines agree', () => {
  it.each([...panePlays(), ...gapPlays()].map((p) => [p.name, p] as const))('%s', (_name, play) => {
    expect(capturePlay(engineUnderTest, play)).toEqual(capturePlay(prototypeEngine, play))
  })
})
