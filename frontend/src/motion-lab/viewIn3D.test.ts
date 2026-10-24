import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MotionPlayRow } from '../api/motionLab'
import { answerViewer, CONTRACT, CONTRACT_VERSION, draftPayload, PLAY, PLAY_ERROR, READY, toViewerPayload, viewerUrlFor } from './viewIn3D'

/**
 * PREVIEW 3D, the handshake. The viewer (framed inside Motion Lab) asks for a
 * play - a saved one by id, or the unsaved draft - once per page load (a
 * request id); each request is answered once, only to the viewer's own origin,
 * with the play as it is at that moment, wrapped in the versioned contract.
 * Anything else in the message stream is ignored.
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
let viewer: { postMessage: ReturnType<typeof vi.fn> }
const deps = {
  addListener: (fn: (e: MessageEvent) => void) => void listeners.push(fn),
  removeListener: (fn: (e: MessageEvent) => void) => void (listeners = listeners.filter((l) => l !== fn)),
}
const ask = (requestId: unknown = 'r1', playId: unknown = 42, origin = ORIGIN, source: unknown = viewer) =>
  listeners.slice().forEach((l) => l({ data: { type: READY, requestId, playId }, origin, source } as MessageEvent))
const flush = () => new Promise((r) => setTimeout(r, 0))
const answer = (target: number | 'draft', load: () => Promise<unknown>) =>
  answerViewer(viewer as unknown as Window, ORIGIN, target, load as never, deps)

beforeEach(() => {
  listeners = []
  viewer = { postMessage: vi.fn() }
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

  it('an unsaved play says it is a draft: no id, no revision', () => {
    const document = row(1).document
    expect(draftPayload('New play', document, 3, '2026-10-22T10:00:00Z')).toEqual({
      contract: CONTRACT,
      version: CONTRACT_VERSION,
      play: { id: null, revision: null, name: 'New play', schemaVersion: 3, updatedAt: '2026-10-22T10:00:00Z', draft: true },
      document,
    })
  })
})

describe("the viewer's address", () => {
  it('names the source and the play - a saved id or the draft - and keeps the viewer settings', () => {
    expect(viewerUrlFor(VIEWER, 42)).toBe('http://localhost:5190/?characters=athlete&source=peira&play=42')
    expect(viewerUrlFor(VIEWER, 'draft', { embed: true })).toBe('http://localhost:5190/?characters=athlete&source=peira&play=draft&embed=1')
  })
})

describe('answering the viewer', () => {
  it('loads nothing until asked', () => {
    const load = vi.fn(async () => toViewerPayload(row(7)))
    answer(42, load)
    expect(load).not.toHaveBeenCalled()
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('answers a request with the play in the contract, to the viewer origin only', async () => {
    answer(42, async () => toViewerPayload(row(7)))
    ask('r1')
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY, requestId: 'r1', payload: toViewerPayload(row(7)) }, ORIGIN)
  })

  it('answers the draft when the viewer asks for the draft', async () => {
    const draft = draftPayload('New play', row(1).document, 3)
    answer('draft', async () => draft)
    ask('r1', 'draft')
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY, requestId: 'r1', payload: draft }, ORIGIN)
  })

  it('answers each request once, however often the viewer asks', async () => {
    const load = vi.fn(async () => toViewerPayload(row(7)))
    answer(42, load)
    ask('r1')
    ask('r1')
    ask('r1')
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
  })

  it('answers a refreshed viewer (a new request) with the play as it is NOW', async () => {
    const load = vi.fn().mockResolvedValueOnce(toViewerPayload(row(7))).mockResolvedValueOnce(toViewerPayload(row(8)))
    answer(42, load)
    ask('first-load')
    await flush()
    ask('after-refresh')
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
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
    ['the draft, when a saved play was opened', () => ask('r1', 'draft')],
    ['a request without an id', () => ask(null)],
    ['an empty request id', () => ask('')],
    ['an overlong request id', () => ask('x'.repeat(101))],
    ['another message', () => listeners.slice().forEach((l) => l({ data: { type: 'something-else', requestId: 'r1', playId: 42 }, origin: ORIGIN, source: viewer } as unknown as MessageEvent))],
    ['no message at all', () => listeners.slice().forEach((l) => l({ data: null, origin: ORIGIN, source: viewer } as unknown as MessageEvent))],
  ])('ignores %s', async (_what, send) => {
    const load = vi.fn(async () => toViewerPayload(row(7)))
    answer(42, load)
    send()
    await flush()
    expect(load).not.toHaveBeenCalled()
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('says so, to that request, when the play cannot be loaded', async () => {
    answer(42, () => Promise.reject(new Error('Not found')))
    ask('r1')
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY_ERROR, requestId: 'r1', message: 'Not found' }, ORIGIN)
  })

  it('stops listening when stopped (the preview closed)', () => {
    const stop = answer(42, async () => toViewerPayload(row(7)))
    expect(listeners).toHaveLength(1)
    stop()
    expect(listeners).toHaveLength(0)
  })
})
