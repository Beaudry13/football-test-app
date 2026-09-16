/// <reference types="node" />
// File-scoped Node types, matching styles/buttonContrast.test.ts: these
// fixtures are read from disk by tests only, and "node" must not enter the
// browser build's global types.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Look, Play } from '../engine/play'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The browser pane's Motion Lab localStorage, exported byte-for-byte in P0
 * (development/test plays, owner-confirmed). Read from the P0 record itself
 * rather than copied, so the fixture cannot drift from what was preserved.
 */
const PANE_BACKUP = resolve(here, '../../../../prototypes/motion-lab-baseline/localstorage/browser-pane-20260916T114345.json')
const GAP_FIXTURES = resolve(here, 'fixtures/gap-plays.json')
const GOLDEN_DIR = resolve(here, 'golden')

interface Backup {
  entries: Record<string, string>
}

function paneStore(): Backup['entries'] {
  return (JSON.parse(readFileSync(PANE_BACKUP, 'utf-8')) as Backup).entries
}

/** The raw stored plays, exactly as the prototype wrote them. */
export function panePlays(): Play[] {
  return (JSON.parse(paneStore()['peira.motionlab.plays']) as { items: Play[] }).items
}

export function paneLooks(): Look[] {
  return (JSON.parse(paneStore()['peira.motionlab.looks']) as { items: Look[] }).items
}

export function gapPlays(): Play[] {
  return JSON.parse(readFileSync(GAP_FIXTURES, 'utf-8')) as Play[]
}

export function writeGapPlays(plays: Play[]): void {
  mkdirSync(dirname(GAP_FIXTURES), { recursive: true })
  writeFileSync(GAP_FIXTURES, `${JSON.stringify(plays, null, 2)}\n`)
}

const goldenPath = (id: string) => resolve(GOLDEN_DIR, `${id}.json`)

export function hasGolden(id: string): boolean {
  return existsSync(goldenPath(id))
}

export function readGolden(id: string): unknown {
  return JSON.parse(readFileSync(goldenPath(id), 'utf-8'))
}

export function writeGolden(id: string, record: unknown): void {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  writeFileSync(goldenPath(id), `${JSON.stringify(record)}\n`)
}

/**
 * Goldens are (re)written ONLY when this is set, and only ever from the
 * preserved prototype's engine - see characterization.test.ts.
 */
export const WRITE_GOLDEN = process.env.MOTION_LAB_WRITE_GOLDEN === '1'
