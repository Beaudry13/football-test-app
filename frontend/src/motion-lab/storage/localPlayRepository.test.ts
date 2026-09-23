/// <reference types="node" />
// File-scoped Node types, matching styles/buttonContrast.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLocalPlayRepository, CURRENT_KEY, LOOKS_KEY, PLAYS_KEY } from './localPlayRepository'
import { lookFromPlayers, newPlay, SCHEMA_VERSION, type Play } from '../engine/play'

/** A Storage that behaves like the browser's, and can be told to fail. */
function memoryStorage(opts: { failWrites?: boolean; throwOnAccess?: boolean } = {}) {
  const data = new Map<string, string>()
  const store: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => {
      if (opts.failWrites) throw new DOMException('QuotaExceededError')
      data.set(k, String(v))
    },
  }
  const access = () => {
    if (opts.throwOnAccess) throw new DOMException('SecurityError')
    return store
  }
  return { data, access }
}

const here = dirname(fileURLToPath(import.meta.url))
const PANE_BACKUP = resolve(here, '../../../../prototypes/motion-lab-baseline/localstorage/browser-pane-20260916T114345.json')

describe('LocalPlayRepository', () => {
  it('reads the standalone prototype\'s stored data exactly as the prototype wrote it', () => {
    // The raw values from the P0 export: same keys, same envelope.
    const entries = (JSON.parse(readFileSync(PANE_BACKUP, 'utf-8')) as { entries: Record<string, string> }).entries
    const { data, access } = memoryStorage()
    for (const [k, v] of Object.entries(entries)) data.set(k, v)
    const repo = createLocalPlayRepository(access)

    const stored = (JSON.parse(entries[PLAYS_KEY]) as { items: Play[] }).items
    const plays = repo.listPlays()
    expect(plays.map((p) => p.id)).toEqual([...stored].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => p.id))
    // `v` is the READER's stamp - these fixtures were written by version 1,
    // and P3.1's model is 2 - so it is compared separately from the content
    // the prototype actually wrote.
    const expected = [...stored].sort((a, b) => b.updatedAt - a.updatedAt)
    expect(plays.map((p) => ({ ...p, v: 1 }))).toEqual(expected)
    expect(plays.every((p) => p.v === SCHEMA_VERSION)).toBe(true)
    expect(repo.listLooks().map((l) => l.name)).toEqual(['Trips Rt'])
    expect(repo.currentPlayId()).toBe(entries[CURRENT_KEY])
  })

  it('writes the prototype\'s envelope under the prototype\'s keys', () => {
    const { data, access } = memoryStorage()
    const repo = createLocalPlayRepository(access)
    const play = newPlay('Mesh')
    expect(repo.savePlay(play)).toBe(true)
    expect(JSON.parse(data.get(PLAYS_KEY)!)).toEqual({ v: SCHEMA_VERSION, items: [JSON.parse(JSON.stringify(play))] })
    const look = lookFromPlayers('Trips', play.players)
    expect(repo.saveLook(look)).toBe(true)
    expect(JSON.parse(data.get(LOOKS_KEY)!).items[0].id).toBe(look.id)
  })

  it('replaces by id, lists newest first, and deletes', () => {
    const { access } = memoryStorage()
    const repo = createLocalPlayRepository(access)
    const a = { ...newPlay('A'), updatedAt: 1 }
    const b = { ...newPlay('B'), updatedAt: 2 }
    repo.savePlay(a)
    repo.savePlay(b)
    expect(repo.listPlays().map((p) => p.name)).toEqual(['B', 'A'])
    repo.savePlay({ ...a, name: 'A renamed', updatedAt: 3 })
    expect(repo.listPlays().map((p) => p.name)).toEqual(['A renamed', 'B'])
    expect(repo.deletePlay(b.id)).toBe(true)
    expect(repo.listPlays().map((p) => p.name)).toEqual(['A renamed'])
  })

  it('drops what cannot be repaired instead of crashing or inventing intent', () => {
    const { data, access } = memoryStorage()
    const good = newPlay('Good')
    data.set(PLAYS_KEY, JSON.stringify({ v: 1, items: [good, { name: 'no players' }, 42, null] }))
    data.set(LOOKS_KEY, '{not json')
    const repo = createLocalPlayRepository(access)
    expect(repo.listPlays().map((p) => p.id)).toEqual([good.id])
    expect(repo.listLooks()).toEqual([])
  })

  it('remembers and forgets the open play', () => {
    const { access } = memoryStorage()
    const repo = createLocalPlayRepository(access)
    repo.setCurrentPlayId('play_x')
    expect(repo.currentPlayId()).toBe('play_x')
    repo.setCurrentPlayId(null)
    expect(repo.currentPlayId()).toBeNull()
  })

  it('reports a full store as "not saved" rather than throwing', () => {
    const { access } = memoryStorage({ failWrites: true })
    const repo = createLocalPlayRepository(access)
    expect(repo.available()).toBe(false)
    expect(repo.savePlay(newPlay())).toBe(false)
    expect(() => repo.setCurrentPlayId('x')).not.toThrow()
  })

  it('degrades when merely touching storage throws (privacy modes)', () => {
    const { access } = memoryStorage({ throwOnAccess: true })
    const repo = createLocalPlayRepository(access)
    expect(repo.available()).toBe(false)
    expect(repo.listPlays()).toEqual([])
    expect(repo.savePlay(newPlay())).toBe(false)
    expect(repo.currentPlayId()).toBeNull()
  })
})
