import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MotionPlayRow } from '../api/motionLab'
import { PLAY, READY, viewIn3D } from './viewIn3D'

/**
 * VIEW IN 3D, the handshake (V6). The viewer asks; only then, and only to its
 * own origin, is the SAVED row sent - once. Anything else in the message
 * stream (another window, another origin, another message) is ignored.
 */

const VIEWER = 'http://localhost:5190/?characters=athlete'
const ROW = { id: 42, name: 'Ace', schema_version: 3, revision: 7, document: { players: [{ id: 'O0', presnapStance: 'OL_2_POINT' }] } } as unknown as MotionPlayRow

let listeners: ((e: MessageEvent) => void)[]
let viewer: { postMessage: ReturnType<typeof vi.fn> }
let opened: string[]
const deps = () => ({
  open: (url: string) => (opened.push(url), viewer as unknown as Window),
  fetchRow: vi.fn(async () => ROW),
  addListener: (fn: (e: MessageEvent) => void) => void listeners.push(fn),
  removeListener: (fn: (e: MessageEvent) => void) => void (listeners = listeners.filter((l) => l !== fn)),
})
const deliver = (data: unknown, origin = 'http://localhost:5190', source: unknown = viewer) =>
  listeners.slice().forEach((l) => l({ data, origin, source } as MessageEvent))
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  listeners = []
  viewer = { postMessage: vi.fn() }
  opened = []
})
afterEach(() => vi.useRealTimers())

describe('handing the saved play to the viewer', () => {
  it('opens the viewer saying where the play comes from, and fetches the saved row', () => {
    const d = deps()
    expect(viewIn3D(VIEWER, 42, d)).toBe(true)
    expect(opened).toEqual(['http://localhost:5190/?characters=athlete&source=peira'])
    expect(d.fetchRow).toHaveBeenCalledWith(42)
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('sends the row - as the server stores it, stance and all - when the viewer says it is ready, to its origin only', async () => {
    viewIn3D(VIEWER, 42, deps())
    deliver({ type: READY })
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
    expect(viewer.postMessage).toHaveBeenCalledWith({ type: PLAY, play: ROW }, 'http://localhost:5190')
  })

  it('sends it once, however often the viewer asks', async () => {
    viewIn3D(VIEWER, 42, deps())
    deliver({ type: READY })
    deliver({ type: READY })
    await flush()
    expect(viewer.postMessage).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(0)
  })

  it.each([
    ['another origin', { type: READY }, 'http://evil.example', undefined],
    ['another window', { type: READY }, 'http://localhost:5190', {}],
    ['another message', { type: 'something-else' }, 'http://localhost:5190', undefined],
    ['no message at all', null, 'http://localhost:5190', undefined],
  ])('ignores %s', async (_what, data, origin, source) => {
    viewIn3D(VIEWER, 42, deps())
    deliver(data, origin, source ?? viewer)
    await flush()
    expect(viewer.postMessage).not.toHaveBeenCalled()
  })

  it('says so when the window cannot be opened', () => {
    expect(viewIn3D(VIEWER, 42, { ...deps(), open: () => null })).toBe(false)
  })
})
