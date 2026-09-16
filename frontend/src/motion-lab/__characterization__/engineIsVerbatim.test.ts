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

const ENGINE_FILES = ['field', 'geometry', 'formation', 'timeline', 'interactions', 'ball', 'orientation', 'perspective', 'play']

describe('engine source', () => {
  it.each(ENGINE_FILES)('%s.ts is byte-identical to the preserved prototype', (name) => {
    expect(read(resolve(ENGINE, `${name}.ts`))).toBe(read(resolve(PROTOTYPE, `${name}.ts`)))
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
