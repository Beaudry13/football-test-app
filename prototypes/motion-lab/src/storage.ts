// Browser-local persistence for the prototype. localStorage, one versioned
// envelope per collection, everything sanitized on the way back in so a
// stale or hand-edited entry can never crash the app or invent intent.
// No backend, no accounts, no sync - this is a single machine's notebook.

import { sanitizeLook, sanitizePlay, SCHEMA_VERSION, type Look, type Play } from './play'

const PLAYS_KEY = 'peira.motionlab.plays'
const LOOKS_KEY = 'peira.motionlab.looks'
const CURRENT_KEY = 'peira.motionlab.currentPlay'

interface Envelope<T> {
  v: number
  items: T[]
}

function read<T>(key: string, fix: (raw: unknown) => T | null): T[] {
  try {
    const text = localStorage.getItem(key)
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
    localStorage.setItem(key, JSON.stringify(env))
    return true
  } catch {
    return false
  }
}

export const storage = {
  available(): boolean {
    try {
      localStorage.setItem('peira.motionlab.probe', '1')
      localStorage.removeItem('peira.motionlab.probe')
      return true
    } catch {
      return false
    }
  },

  listPlays(): Play[] {
    return read(PLAYS_KEY, sanitizePlay).sort((a, b) => b.updatedAt - a.updatedAt)
  },
  getPlay(id: string): Play | null {
    return this.listPlays().find((p) => p.id === id) ?? null
  },
  savePlay(play: Play): boolean {
    const rest = this.listPlays().filter((p) => p.id !== play.id)
    return write(PLAYS_KEY, [play, ...rest])
  },
  deletePlay(id: string): boolean {
    return write(PLAYS_KEY, this.listPlays().filter((p) => p.id !== id))
  },

  listLooks(): Look[] {
    return read(LOOKS_KEY, sanitizeLook).sort((a, b) => b.updatedAt - a.updatedAt)
  },
  saveLook(look: Look): boolean {
    const rest = this.listLooks().filter((l) => l.id !== look.id)
    return write(LOOKS_KEY, [look, ...rest])
  },
  deleteLook(id: string): boolean {
    return write(LOOKS_KEY, this.listLooks().filter((l) => l.id !== id))
  },

  currentPlayId(): string | null {
    try {
      return localStorage.getItem(CURRENT_KEY)
    } catch {
      return null
    }
  },
  setCurrentPlayId(id: string | null) {
    try {
      if (id) localStorage.setItem(CURRENT_KEY, id)
      else localStorage.removeItem(CURRENT_KEY)
    } catch {
      /* nothing to do: the play is still in memory */
    }
  },
}
