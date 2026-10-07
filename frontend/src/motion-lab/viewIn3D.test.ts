import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MotionPlayRow } from '../api/motionLab'
import { CONTRACT, CONTRACT_VERSION, PLAY, PLAY_ERROR, READY, toViewerPayload, viewIn3D } from './viewIn3D'

/**
 * VIEW IN 3D, the handshake (V6). The viewer asks for a play by id, once per
 * page load (a request id); each request is answered once, only to the viewer's
 * own origin, with the row fetched from the server at that moment, wrapped in the
 * versioned contract. Anything else in the message stream is ignored, a newer
 * View in 3D takes the window over, and the handoff ends when the window closes.
 */

const VIEWER = 'http://localhost:5190/?characters=athlete'
const ORIGIN = 'http://localhost:5190'
const row = (revision: number, id = 42) =>
  ({
    id,
    name: 'Ace',
    schema_version: 3,
    revision,
    updated_at: `2026-10-07T12:00:0${revision}Z`,
    folder_id: null,
    copied_from_play_id: null,
    created_by_coach_id: 1,
    created_at: '2026-10-07T11:00:00Z',
    document: { players: [{ id: 'O0', presnapStance: 'OL_2_POINT' }], ball: null, ballThen: null, engagements: [], situation: {}, filter: 'all' },
  }) as unknown as MotionPlayRow

let listeners: ((e: MessageEvent) => void)[]
let watchers: (() => void)[]
let viewer: { postMessage: ReturnType<typeof vi.fn>; closed: boolean }
let opened: string[]
const deps = (fetchRow = vi.fn(async (id: number) => row(7, id))) => ({
  open: (url: string) => (opened.push(url), viewer as unknown as Window),
  fetchRow,
  addListener: (fn: (e: MessageEvent) => void) => void listeners.push(fn),
  removeListener: (fn: (e: MessageEvent) => void) => void (listeners = listeners.filter((l) => l !== fn)),
  every: (_ms: number, fn: () => void) => (watchers.push(fn), () => void (watchers = watchers.filter((w) => w !== fn))),
})
const ask = (requestId: unknown = 'r1', playId: unknown = 42, origin = ORIGIN, source: unknown = viewer) =>
  listeners.slice().forEach((l) => l({ data: { type: READY, requestId, playId }, origin, source } as MessageEvent))
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  listeners = []
  watchers = []
  viewer = { postMessage: vi.fn(), closed: false }
  opened = []
})

describe('the contract payload', () => {
  it('carries the row identity from its columns and the document untouched', () => {
    const r = row(7)
    const payload = toViewerPayload(r)
    expect(payload).toEqual({
      contract: CONTRACT,
      version: CONTRACT_VERSION,
      play: { id: 42, revision: 7, name: 'Ace', schemaVersion: 3, updatedAt: '2026-10-07T12:00:07Z' },
      document: r.document,
    })
    expect(payload.document).toBe(r.document)
    expect(CONTRACT).toBe('peira-motion-lab-3d')
    expect(CONTRACT_VERSION).toBe(1)
  })
})

describe('handing the saved play to the viewer', () => {
  it('opens the viewer naming the source and the play, and fetches nothing until asked', () => {
    const d = deps()
    expect(viewIn3D(VIEWER, 42, d)).toBe(true)
    expect(opened).toEqual(['http://localhost:5190/?characters=athlete&source=peira&play=42'])
    expect(d.fetchRow).not.toHaveBeenCalled()
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('answers a request with the saved row in the contract, to the viewer origin only', async () => {
    viewIn3D(VIEWER, 42, deps())
    ask('r1')
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY, requestId: 'r1', payload: toViewerPayload(row(7)) }, ORIGIN)
  })

  it('answers each request once, however often the viewer asks', async () => {
    const d = deps()
    viewIn3D(VIEWER, 42, d)
    ask('r1')
    ask('r1')
    ask('r1')
    await flush()
    expect(d.fetchRow).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
  })

  it('answers a refreshed viewer (a new request) with the save as it is NOW', async () => {
    const fetchRow = vi.fn().mockResolvedValueOnce(row(7)).mockResolvedValueOnce(row(8))
    viewIn3D(VIEWER, 42, deps(fetchRow))
    ask('first-load')
    await flush()
    ask('after-refresh')
    await flush()
    expect(fetchRow).toHaveBeenCalledTimes(2)
    const sent = viewer.postMessage.mock.calls.map(([m]) => [m.requestId, m.payload.play.revision])
    expect(sent).toEqual([
      ['first-load', 7],
      ['after-refresh', 8],
    ])
  })

  it.each([
    ['another origin', () => ask('r1', 42, 'http://evil.example')],
    ['another window', () => ask('r1', 42, ORIGIN, {})],
    ['another play', () => ask('r1', 43)],
    ['a request without an id', () => ask(null)],
    ['an empty request id', () => ask('')],
    ['another message', () => listeners.slice().forEach((l) => l({ data: { type: 'something-else', requestId: 'r1', playId: 42 }, origin: ORIGIN, source: viewer } as unknown as MessageEvent))],
    ['no message at all', () => listeners.slice().forEach((l) => l({ data: null, origin: ORIGIN, source: viewer } as unknown as MessageEvent))],
  ])('ignores %s', async (_what, send) => {
    const d = deps()
    viewIn3D(VIEWER, 42, d)
    send()
    await flush()
    expect(d.fetchRow).not.toHaveBeenCalled()
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('a newer View in 3D takes the window over: the earlier play is never sent to it again', async () => {
    const first = deps()
    const second = deps()
    viewIn3D(VIEWER, 42, first)
    viewIn3D(VIEWER, 43, second)
    expect(listeners).toHaveLength(1)
    ask('r2', 42)
    ask('r3', 43)
    await flush()
    expect(first.fetchRow).not.toHaveBeenCalled()
    expect(second.fetchRow).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage.mock.calls.map(([m]) => m.payload.play.id)).toEqual([43])
  })

  it('says so, to that request, when the saved play cannot be fetched', async () => {
    viewIn3D(VIEWER, 42, deps(vi.fn().mockRejectedValue(new Error('Not found'))))
    ask('r1')
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY_ERROR, requestId: 'r1', message: 'Not found' }, ORIGIN)
  })

  it('stops listening once the viewer window is closed', () => {
    viewIn3D(VIEWER, 42, deps())
    expect(listeners).toHaveLength(1)
    viewer.closed = true
    watchers.slice().forEach((w) => w())
    expect(listeners).toHaveLength(0)
    expect(watchers).toHaveLength(0)
  })

  it('says so when the window cannot be opened', () => {
    expect(viewIn3D(VIEWER, 42, { ...deps(), open: () => null })).toBe(false)
  })
})
