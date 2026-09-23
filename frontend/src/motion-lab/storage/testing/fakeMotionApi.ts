// TESTS ONLY. An in-memory stand-in for the Motion Lab API with the server's
// rules - an older client refused, revisions, 409 on a stale base, 404 for a
// missing play - plus the hooks a test needs to hold a request in flight or
// make it fail.
//
// THE VERSION RULE IS THE SERVER'S, NOT A CONVENIENCE. Without it this fake
// accepted any schema_version, and an editor that saved every play as v1 -
// refused by the real server for every play stored at v2 - passed every test.

import { ApiError } from '../../../api/client'
import type { MotionLookRow, MotionPlayRow } from '../../../api/motionLab'
import type { DraftStore, MotionApi } from '../apiPlayRepository'

type Call = { kind: 'create' | 'save' | 'get' | 'delete' | 'createLook' | 'deleteLook'; id?: number; body?: unknown }

export function fakeMotionServer() {
  const plays = new Map<number, MotionPlayRow>()
  const looks = new Map<number, MotionLookRow>()
  let nextId = 100
  let clock = Date.parse('2026-09-16T12:00:00Z')
  const calls: Call[] = []
  /** Set to make the next request fail this way (then it resets). */
  let failNext: null | (() => never) = null
  /** When true, requests wait until release() is called. */
  let holding = false
  const held: (() => void)[] = []

  const stamp = () => new Date((clock += 1000)).toISOString()
  const gate = async () => {
    if (holding) await new Promise<void>((resolve) => held.push(resolve))
    if (failNext) {
      const fail = failNext
      failNext = null
      fail()
    }
  }

  const api: MotionApi = {
    async createMotionPlay(input) {
      calls.push({ kind: 'create', body: input })
      await gate()
      const now = stamp()
      const row: MotionPlayRow = {
        id: nextId++,
        name: input.name,
        document: structuredClone(input.document),
        schema_version: input.schema_version,
        revision: 1,
        folder_id: input.folder_id ?? null,
        copied_from_play_id: null,
        created_by_coach_id: 1,
        created_at: now,
        updated_at: now,
      }
      plays.set(row.id, row)
      return structuredClone(row)
    },
    async saveMotionPlay(id, input) {
      calls.push({ kind: 'save', id, body: input })
      await gate()
      const row = plays.get(id)
      if (!row) throw new ApiError('Play not found', 404)
      // backend/app/routes/motion_lab.py save_play, in its order: an older
      // client first, then a stale base. A save records the version it was
      // written at, as the server does.
      if (input.schema_version < row.schema_version) {
        throw new ApiError(
          `This play was saved by a newer Motion Lab (v${row.schema_version}); this tab writes v${input.schema_version}. Reload before editing.`,
          409,
          undefined,
          'schema_outdated',
        )
      }
      if (row.revision !== input.base_revision) throw new ApiError('This play was changed somewhere else.', 409, undefined, 'revision_conflict')
      Object.assign(row, {
        name: input.name,
        document: structuredClone(input.document),
        schema_version: input.schema_version,
        revision: row.revision + 1,
        updated_at: stamp(),
      })
      return structuredClone(row)
    },
    async getMotionPlay(id) {
      calls.push({ kind: 'get', id })
      await gate()
      const row = plays.get(id)
      if (!row) throw new ApiError('Play not found', 404)
      return structuredClone(row)
    },
    async deleteMotionPlay(id) {
      calls.push({ kind: 'delete', id })
      await gate()
      if (!plays.delete(id)) throw new ApiError('Play not found', 404)
    },
    async createMotionLook(input) {
      calls.push({ kind: 'createLook', body: input })
      await gate()
      const now = stamp()
      const row: MotionLookRow = { id: nextId++, name: input.name, document: structuredClone(input.document), schema_version: input.schema_version, revision: 1, created_by_coach_id: 1, created_at: now, updated_at: now }
      looks.set(row.id, row)
      return structuredClone(row)
    },
    async deleteMotionLook(id) {
      calls.push({ kind: 'deleteLook', id })
      await gate()
      looks.delete(id)
    },
  }

  return {
    api,
    plays,
    looks,
    calls,
    /** Rows as GET /plays would return them, newest first. */
    playRows: () => [...plays.values()].map((row) => structuredClone(row)).reverse(),
    lookRows: () => [...looks.values()].map((row) => structuredClone(row)).reverse(),
    /** Someone else saves this play (bumps the revision). */
    editElsewhere(id: number, name: string) {
      const row = plays.get(id)!
      Object.assign(row, { name, revision: row.revision + 1, updated_at: stamp() })
    },
    failNextWith(error: ApiError) {
      failNext = () => {
        throw error
      }
    },
    hold() {
      holding = true
    },
    release() {
      holding = false
      held.splice(0).forEach((resolve) => resolve())
    },
  }
}

export function memoryDraftStore(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

/** Let pending promise callbacks run. */
export const settle = async (times = 5) => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
