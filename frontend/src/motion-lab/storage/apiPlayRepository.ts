// MOTION LAB ON PEIRA'S SERVER - the P2 PlayRepository.
//
// THE CONSTRAINT. The validated editor talks to storage synchronously: it
// saves and immediately lists, and it flushes on tab hide. Rewriting it to
// await a network would change the prototype's autosave behaviour, so this
// module keeps the editor's contract and puts the network behind it.
//
// THE SAVE LIFECYCLE, and why it is the smallest safe one:
//
//   editor edit -> editor's own 400 ms debounce -> repository.savePlay(play)
//     1. the cache takes the play at once, so every read the editor makes
//        afterwards sees it (the synchronous contract);
//     2. a DRAFT copy goes to localStorage - the only local safety net, and it
//        exists only while a save is unconfirmed;
//     3. at most ONE request per play is in flight. An edit arriving meanwhile
//        just marks the play pending; when the request returns, the LATEST
//        version is sent next. Rapid edits therefore coalesce to at most one
//        request in flight plus one queued, never a burst;
//     4. the request names the revision it was made from. The server answers
//        with the new revision, which the next save names;
//     5. success with nothing newer pending clears the draft.
//
//   A 409 (changed somewhere else) or a 404 (deleted somewhere else) stops
//   sending for that play and asks the coach - see resolveWithLatest /
//   resolveKeepMine. Nothing is overwritten and nothing is silently dropped.
//   A network failure or 5xx retries with backoff and says "Not saved -
//   retrying"; the draft survives a closed tab and is re-sent (or raised as a
//   conflict, if the server moved meanwhile) the next time Motion Lab opens.
//   A 413/422 is a permanent refusal and is shown, not retried.
//
// WHAT THIS IS NOT: an offline-first sync engine. There is no operation log,
// no merge, no background replication - one cache, one pending version per
// play, one draft per unconfirmed play.
//
// ONE SESSION PER COACH PER APP LIFETIME (getMotionLabSession). Leaving the
// editor for the Library and coming back reuses the same session, so a save
// still retrying is not duplicated by a second session that would then read
// its own earlier save as someone else's change.

import { ApiError } from '../../api/client'
import * as motionApi from '../../api/motionLab'
import type { MotionLookRow, MotionPlayDocument, MotionPlayRow } from '../../api/motionLab'
import { newId, sanitizeLook, sanitizePlay, SCHEMA_VERSION, type Look, type Play } from '../engine/play'
import type { PlayRepository } from './playRepository'

export type PlaySaveState = 'saved' | 'saving' | 'retrying' | 'conflict' | 'deleted-elsewhere' | 'failed'

export type MotionApi = Pick<
  typeof motionApi,
  'createMotionPlay' | 'saveMotionPlay' | 'getMotionPlay' | 'deleteMotionPlay' | 'createMotionLook' | 'deleteMotionLook'
>

/** Backoff after a network failure or 5xx, in ms; the last value repeats. */
export const RETRY_DELAYS = [2000, 5000, 10000, 30000]

export interface DraftStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  keys(): string[]
}

/** localStorage, never allowed to throw into the editor. */
export const browserDraftStore: DraftStore = {
  get: (key) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key, value) => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* no draft this time - the save itself is unaffected */
    }
  },
  remove: (key) => {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* nothing to do */
    }
  },
  keys: () => {
    try {
      return Object.keys(window.localStorage)
    } catch {
      return []
    }
  },
}

const DRAFT_PREFIX = 'peira.motionlab.draft.v1'

interface Draft {
  clientId: string
  serverId: number | null
  baseRevision: number | null
  folderId: number | null
  play: Play
}

interface Entry {
  clientId: string
  play: Play
  serverId: number | null
  revision: number | null
  folderId: number | null
  pending: boolean
  inflight: boolean
  conflict: 'changed' | 'deleted' | null
  failure: string | null
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
  deleteQueued: boolean
}

// ---- conversions --------------------------------------------------------

export const clientIdForPlay = (serverId: number) => `mp${serverId}`
export const clientIdForLook = (serverId: number) => `ml${serverId}`

/** The authored intent the server stores; id, name and times are columns. */
export function toDocument(play: Play): MotionPlayDocument {
  return {
    players: play.players,
    ball: play.ball,
    ballThen: play.ballThen,
    engagements: play.engagements,
    situation: play.situation,
    filter: play.filter,
  }
}

/** A server row as the editor's Play - through the model's own sanitizer, as
 *  every stored play always has been. */
export function playFromRow(row: MotionPlayRow): Play | null {
  return sanitizePlay({
    ...row.document,
    v: row.schema_version,
    id: clientIdForPlay(row.id),
    name: row.name,
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.updated_at),
  })
}

export function lookFromRow(row: MotionLookRow): Look | null {
  return sanitizeLook({
    ...row.document,
    v: row.schema_version,
    id: clientIdForLook(row.id),
    name: row.name,
    updatedAt: Date.parse(row.updated_at),
  })
}

/** What a save would change: name and authored document, not timestamps. */
const intentKey = (play: Play) => JSON.stringify({ name: play.name, document: toDocument(play) })

// ---- the session --------------------------------------------------------

export interface MotionLabSession {
  repository: PlayRepository
  subscribe(listener: () => void): () => void
  stateOf(clientId: string): { state: PlaySaveState; message: string | null }
  serverIdOf(clientId: string): number | null
  folderIdOf(clientId: string): number | null
  clientIdOf(serverId: number): string | null
  /** Replace unchanged cached plays/looks with the server's list. Local work
   *  that is pending, in flight or in conflict is kept, never overwritten. */
  refresh(plays: MotionPlayRow[], looks: MotionLookRow[]): void
  /** Messages worth telling the coach once (recovered drafts, failed deletes). */
  takeNotices(): string[]
  /** The coach chose the server's version: drop local edits to this play. */
  resolveWithLatest(clientId: string): Promise<void>
  /** The coach chose to keep their version: it becomes a new play, and the
   *  original returns to the server's version. Returns the new play's id. */
  resolveKeepMine(clientId: string): Promise<string>
  /** Ignore saves to these plays until endDiscard - while the editor is being
   *  remounted after a resolution, its unmount flush must not resurrect the
   *  version the coach just chose not to keep. */
  beginDiscard(clientIds: string[]): void
  endDiscard(): void
  retryNow(): void
  pendingCount(): number
}

export function createMotionLabSession(options: {
  plays: MotionPlayRow[]
  looks: MotionLookRow[]
  /** Scopes drafts to one organization and coach on a shared browser. */
  draftScope: string
  api?: MotionApi
  drafts?: DraftStore
}): MotionLabSession {
  const client: MotionApi = options.api ?? motionApi
  const drafts = options.drafts ?? browserDraftStore
  const scopePrefix = `${DRAFT_PREFIX}:${options.draftScope}:`

  const entries = new Map<string, Entry>()
  const byServer = new Map<number, string>()
  const looks = new Map<string, { look: Look; serverId: number | null; deleteAfterCreate: boolean }>()
  const listeners = new Set<() => void>()
  const discarding = new Set<string>()
  let notices: string[] = []
  let current: string | null = null

  const emit = () => listeners.forEach((listener) => listener())

  const draftKey = (entry: Entry) =>
    `${scopePrefix}${entry.serverId !== null ? `p${entry.serverId}` : entry.clientId}`

  function writeDraft(entry: Entry) {
    const draft: Draft = {
      clientId: entry.clientId,
      serverId: entry.serverId,
      baseRevision: entry.revision,
      folderId: entry.folderId,
      play: entry.play,
    }
    drafts.set(draftKey(entry), JSON.stringify(draft))
  }

  function clearDrafts(entry: Entry) {
    drafts.remove(`${scopePrefix}${entry.clientId}`)
    if (entry.serverId !== null) drafts.remove(`${scopePrefix}p${entry.serverId}`)
  }

  function addEntry(play: Play, serverId: number | null, revision: number | null, folderId: number | null): Entry {
    const entry: Entry = {
      clientId: play.id,
      play,
      serverId,
      revision,
      folderId,
      pending: false,
      inflight: false,
      conflict: null,
      failure: null,
      attempts: 0,
      retryTimer: null,
      deleteQueued: false,
    }
    entries.set(entry.clientId, entry)
    if (serverId !== null) byServer.set(serverId, entry.clientId)
    return entry
  }

  function removeEntry(entry: Entry) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    entries.delete(entry.clientId)
    if (entry.serverId !== null) byServer.delete(entry.serverId)
    clearDrafts(entry)
  }

  function scheduleRetry(entry: Entry) {
    entry.attempts += 1
    const delay = RETRY_DELAYS[Math.min(entry.attempts - 1, RETRY_DELAYS.length - 1)]
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      void send(entry)
    }, delay)
  }

  async function send(entry: Entry): Promise<void> {
    if (entry.inflight || entry.retryTimer || entry.conflict || entry.failure || entry.deleteQueued || !entry.pending) return
    if (!entries.has(entry.clientId)) return
    entry.inflight = true
    emit()
    const sent = entry.play
    const sentKey = intentKey(sent)
    // The version is the one THIS client's model writes - `toDocument` made
    // these bytes - never whatever the in-memory play claims. It is what the
    // server's older-tab refusal is keyed on (motion_lab.py _outdated_client).
    const body = { name: sent.name, document: toDocument(sent), schema_version: SCHEMA_VERSION }
    try {
      const row =
        entry.serverId === null
          ? await client.createMotionPlay({ ...body, folder_id: entry.folderId })
          : await client.saveMotionPlay(entry.serverId, { ...body, base_revision: entry.revision ?? 1 })
      const wasNew = entry.serverId === null
      entry.serverId = row.id
      entry.revision = row.revision
      entry.folderId = row.folder_id
      entry.attempts = 0
      if (entry.deleteQueued) return // deleted while this was out; `finally` deletes it
      byServer.set(row.id, entry.clientId)
      if (wasNew) drafts.remove(`${scopePrefix}${entry.clientId}`)
      if (intentKey(entry.play) === sentKey) {
        entry.pending = false
        clearDrafts(entry)
      } else {
        writeDraft(entry)
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        entry.conflict = 'changed'
      } else if (error instanceof ApiError && error.status === 404 && entry.serverId !== null) {
        entry.conflict = 'deleted'
      } else if (error instanceof ApiError && (error.status === 413 || error.status === 422)) {
        entry.failure = error.message
      } else {
        scheduleRetry(entry)
      }
    } finally {
      entry.inflight = false
      if (entry.deleteQueued) {
        void performDelete(entry)
      } else {
        // Anything edited while this request was out goes next.
        void send(entry)
      }
      emit()
    }
  }

  async function performDelete(entry: Entry) {
    if (entry.serverId === null) return
    try {
      await client.deleteMotionPlay(entry.serverId)
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        notices.push(`"${entry.play.name}" could not be deleted. Reopen the Library to check it.`)
        emit()
      }
    }
  }

  async function createLook(id: string) {
    const record = looks.get(id)
    if (!record) return
    try {
      const row = await client.createMotionLook({
        name: record.look.name,
        document: { players: record.look.players },
        schema_version: SCHEMA_VERSION, // as for a play: the writer's version
      })
      record.serverId = row.id
      if (record.deleteAfterCreate) await client.deleteMotionLook(row.id)
    } catch {
      notices.push(`Look "${record.look.name}" could not be saved. Try saving it again.`)
      looks.delete(id)
      emit()
    }
  }

  // ---- seed ---------------------------------------------------------------

  for (const row of options.plays) {
    const play = playFromRow(row)
    if (play) addEntry(play, row.id, row.revision, row.folder_id)
  }
  for (const row of options.looks) {
    const look = lookFromRow(row)
    if (look) looks.set(look.id, { look, serverId: row.id, deleteAfterCreate: false })
  }

  // ---- recover drafts left by an earlier page ---------------------------

  for (const key of drafts.keys()) {
    if (!key.startsWith(scopePrefix)) continue
    let draft: Draft | null = null
    try {
      draft = JSON.parse(drafts.get(key) ?? 'null') as Draft
    } catch {
      draft = null
    }
    const play = draft ? sanitizePlay(draft.play) : null
    if (!draft || !play) {
      drafts.remove(key)
      continue
    }
    const existing = draft.serverId !== null ? entries.get(byServer.get(draft.serverId) ?? '') : undefined
    if (draft.serverId !== null && !existing) {
      // Deleted on the server since. Not dropped: kept as a new play.
      drafts.remove(key)
      const recovered = addEntry({ ...play, id: newId('play_'), name: `${play.name} (recovered)` }, null, null, null)
      recovered.pending = true
      writeDraft(recovered)
      notices.push(`Unsaved changes to "${play.name}" were recovered as a new play - the original had been deleted.`)
      continue
    }
    if (existing) {
      if (intentKey(existing.play) === intentKey(play)) {
        // It did arrive (a keepalive save outlived the page). Nothing to do.
        drafts.remove(key)
        continue
      }
      existing.play = { ...play, id: existing.clientId }
      existing.pending = true
      if (draft.baseRevision !== existing.revision) {
        existing.conflict = 'changed'
        notices.push(`"${play.name}" has unsaved changes from this browser, and it was also changed somewhere else.`)
      } else {
        notices.push(`Recovered unsaved changes to "${play.name}".`)
      }
      continue
    }
    // Never reached the server at all.
    if (!entries.has(play.id)) {
      const created = addEntry(play, null, null, draft.folderId)
      created.pending = true
      notices.push(`Recovered "${play.name}", which had not been saved yet.`)
    }
  }
  for (const entry of entries.values()) if (entry.pending) void send(entry)

  const onOnline = () => session.retryNow()
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline)

  // ---- the repository the editor sees -----------------------------------

  const repository: PlayRepository = {
    available: () => true,

    listPlays: () => [...entries.values()].map((entry) => entry.play).sort((a, b) => b.updatedAt - a.updatedAt),

    savePlay(play) {
      if (discarding.has(play.id)) return true
      let entry = entries.get(play.id)
      if (!entry) {
        entry = addEntry(play, null, null, null)
        entry.pending = true
      } else {
        if (intentKey(entry.play) === intentKey(play) && !entry.pending) {
          entry.play = play
          return true
        }
        entry.play = play
        entry.pending = true
      }
      writeDraft(entry)
      void send(entry)
      emit()
      return true
    },

    deletePlay(id) {
      const entry = entries.get(id)
      if (!entry) return true
      removeEntry(entry)
      if (entry.inflight) entry.deleteQueued = true
      else void performDelete(entry)
      emit()
      return true
    },

    listLooks: () => [...looks.values()].map((record) => record.look).sort((a, b) => b.updatedAt - a.updatedAt),

    saveLook(look) {
      if (looks.has(look.id)) return true
      looks.set(look.id, { look, serverId: null, deleteAfterCreate: false })
      void createLook(look.id)
      return true
    },

    deleteLook(id) {
      const record = looks.get(id)
      if (!record) return true
      looks.delete(id)
      if (record.serverId !== null) {
        client.deleteMotionLook(record.serverId).catch(() => {
          notices.push(`Look "${record.look.name}" could not be deleted.`)
          emit()
        })
      } else {
        record.deleteAfterCreate = true
      }
      return true
    },

    currentPlayId: () => current,
    setCurrentPlayId(id) {
      current = id
      emit()
    },
  }

  const session: MotionLabSession = {
    repository,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    stateOf(clientId) {
      const entry = entries.get(clientId)
      if (!entry) return { state: 'saved', message: null }
      if (entry.conflict === 'changed') return { state: 'conflict', message: null }
      if (entry.conflict === 'deleted') return { state: 'deleted-elsewhere', message: null }
      if (entry.failure) return { state: 'failed', message: entry.failure }
      if (entry.retryTimer || entry.attempts > 0) return { state: 'retrying', message: null }
      if (entry.inflight || entry.pending) return { state: 'saving', message: null }
      return { state: 'saved', message: null }
    },

    serverIdOf: (clientId) => entries.get(clientId)?.serverId ?? null,
    folderIdOf: (clientId) => entries.get(clientId)?.folderId ?? null,
    clientIdOf: (serverId) => byServer.get(serverId) ?? null,

    refresh(playRows, lookRows) {
      const seen = new Set<number>()
      for (const row of playRows) {
        seen.add(row.id)
        const clientId = byServer.get(row.id)
        const entry = clientId ? entries.get(clientId) : undefined
        if (entry && (entry.pending || entry.inflight || entry.conflict || entry.failure)) continue
        const play = playFromRow(row)
        if (!play) continue
        if (entry) {
          entry.play = { ...play, id: entry.clientId }
          entry.revision = row.revision
          entry.folderId = row.folder_id
        } else {
          addEntry(play, row.id, row.revision, row.folder_id)
        }
      }
      for (const entry of [...entries.values()]) {
        const goneFromServer = entry.serverId !== null && !seen.has(entry.serverId)
        if (goneFromServer && !entry.pending && !entry.inflight && !entry.conflict) removeEntry(entry)
      }
      for (const [id, record] of [...looks.entries()]) if (record.serverId !== null) looks.delete(id)
      for (const row of lookRows) {
        const look = lookFromRow(row)
        if (look) looks.set(look.id, { look, serverId: row.id, deleteAfterCreate: false })
      }
      emit()
    },

    takeNotices() {
      const out = notices
      notices = []
      return out
    },

    async resolveWithLatest(clientId) {
      const entry = entries.get(clientId)
      if (!entry) return
      if (entry.conflict === 'deleted' || entry.serverId === null) {
        removeEntry(entry)
        if (current === clientId) current = null
        emit()
        return
      }
      const row = await client.getMotionPlay(entry.serverId)
      const play = playFromRow(row)
      if (!play) return
      if (entry.retryTimer) clearTimeout(entry.retryTimer)
      entry.retryTimer = null
      entry.play = { ...play, id: entry.clientId }
      entry.revision = row.revision
      entry.folderId = row.folder_id
      entry.pending = false
      entry.conflict = null
      entry.failure = null
      entry.attempts = 0
      clearDrafts(entry)
      emit()
    },

    async resolveKeepMine(clientId) {
      const entry = entries.get(clientId)
      if (!entry) throw new Error('No such play')
      const now = Date.now()
      const copy = addEntry(
        { ...entry.play, id: newId('play_'), name: `${entry.play.name} (my version)`.slice(0, 255), createdAt: now, updatedAt: now },
        null,
        null,
        entry.folderId,
      )
      copy.pending = true
      writeDraft(copy)
      current = copy.clientId
      if (entry.conflict === 'deleted') {
        removeEntry(entry)
      } else {
        try {
          await session.resolveWithLatest(clientId)
        } catch {
          // The original stays in conflict; the coach's version is safe in the copy.
        }
      }
      void send(copy)
      emit()
      return copy.clientId
    },

    beginDiscard(clientIds) {
      clientIds.forEach((id) => discarding.add(id))
    },
    endDiscard() {
      discarding.clear()
    },

    retryNow() {
      for (const entry of entries.values()) {
        if (entry.retryTimer) {
          clearTimeout(entry.retryTimer)
          entry.retryTimer = null
          void send(entry)
        }
      }
    },

    pendingCount: () => [...entries.values()].filter((entry) => entry.pending || entry.inflight).length,
  }

  return session
}

// ---- one session per coach per app lifetime ------------------------------

const sessions = new Map<string, MotionLabSession>()

/**
 * The Motion Lab session for this organization and coach, created from the
 * server's lists the first time and refreshed from them every time after.
 */
export function getMotionLabSession(scope: string, plays: MotionPlayRow[], looks: MotionLookRow[]): MotionLabSession {
  const existing = sessions.get(scope)
  if (existing) {
    existing.refresh(plays, looks)
    return existing
  }
  const session = createMotionLabSession({ plays, looks, draftScope: scope })
  sessions.set(scope, session)
  return session
}

/** Tests only. */
export function resetMotionLabSessions() {
  sessions.clear()
}
