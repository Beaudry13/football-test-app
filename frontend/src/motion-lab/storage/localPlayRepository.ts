// P1 PERSISTENCE: THE BROWSER. The prototype's storage.ts, behind the
// PlayRepository boundary, with its format unchanged.
//
// SAME KEYS, SAME ENVELOPE, SAME SANITIZING as the standalone prototype:
//   peira.motionlab.plays        { v, items: Play[] }
//   peira.motionlab.looks        { v, items: Look[] }
//   peira.motionlab.currentPlay  play id
// so a prototype export can be read back as-is, and nothing saved in P1
// needs converting before P2 imports it.
//
// BROWSER STORAGE BELONGS TO ONE ORIGIN. Plays saved by the standalone
// prototype live under http://localhost:5180 and are invisible here; PEIRA's
// origin starts empty. That is deliberate, not a migration that failed - see
// docs/MOTION-LAB-BASELINE.md. No import is built in P1.
//
// The only change from storage.ts is that the Storage object is passed in
// rather than read from the global, so tests can hand it a store that fills
// up or throws. Everything read back is sanitized, so a stale or hand-edited
// entry can never crash the editor or invent intent.

import { sanitizeLook, sanitizePlay, SCHEMA_VERSION } from '../engine/play'
import type { PlayRepository } from './playRepository'

export const PLAYS_KEY = 'peira.motionlab.plays'
export const LOOKS_KEY = 'peira.motionlab.looks'
export const CURRENT_KEY = 'peira.motionlab.currentPlay'
const PROBE_KEY = 'peira.motionlab.probe'

interface Envelope<T> {
  v: number
  items: T[]
}

/**
 * `store` is resolved lazily: in some privacy modes merely touching
 * `window.localStorage` throws, and that must degrade to "not saved", never
 * to a blank screen.
 */
export function createLocalPlayRepository(store: () => Storage = () => window.localStorage): PlayRepository {
  function read<T>(key: string, fix: (raw: unknown) => T | null): T[] {
    try {
      const text = store().getItem(key)
      if (!text) return []
      const parsed = JSON.parse(text) as Partial<Envelope<unknown>> | unknown[]
      const items = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Envelope<unknown>).items) ? (parsed as Envelope<unknown>).items : []
      return items.map(fix).filter((x): x is T => !!x)
    } catch {
      return []
    }
  }

  function write<T>(key: string, items: T[]): boolean {
    try {
      const env: Envelope<T> = { v: SCHEMA_VERSION, items }
      store().setItem(key, JSON.stringify(env))
      return true
    } catch {
      return false
    }
  }

  const repository: PlayRepository = {
    available() {
      try {
        store().setItem(PROBE_KEY, '1')
        store().removeItem(PROBE_KEY)
        return true
      } catch {
        return false
      }
    },

    listPlays() {
      return read(PLAYS_KEY, sanitizePlay).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    savePlay(play) {
      const rest = repository.listPlays().filter((p) => p.id !== play.id)
      return write(PLAYS_KEY, [play, ...rest])
    },
    deletePlay(id) {
      return write(PLAYS_KEY, repository.listPlays().filter((p) => p.id !== id))
    },

    listLooks() {
      return read(LOOKS_KEY, sanitizeLook).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    saveLook(look) {
      const rest = repository.listLooks().filter((l) => l.id !== look.id)
      return write(LOOKS_KEY, [look, ...rest])
    },
    deleteLook(id) {
      return write(LOOKS_KEY, repository.listLooks().filter((l) => l.id !== id))
    },

    currentPlayId() {
      try {
        return store().getItem(CURRENT_KEY)
      } catch {
        return null
      }
    },
    setCurrentPlayId(id) {
      try {
        if (id) store().setItem(CURRENT_KEY, id)
        else store().removeItem(CURRENT_KEY)
      } catch {
        /* nothing to do: the play is still in memory */
      }
    },
  }
  return repository
}
