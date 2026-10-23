import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import * as authModule from '../auth/AuthContext'
import { resetMotionLabSessions, toDocument } from './storage/apiPlayRepository'
import { fakeMotionServer, settle } from './storage/testing/fakeMotionApi'
import { dragPlayer, installPointerStubs } from './testing/pointerStubs'
import { gapPlays } from './__characterization__/fixtures'
import { newPlay } from './engine/play'

const server = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('./storage/testing/fakeMotionApi').fakeMotionServer> }))
vi.mock('../api/motionLab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/motionLab')>()
  return {
    ...actual,
    listMotionPlays: () => Promise.resolve(server.current.playRows()),
    listMotionLooks: () => Promise.resolve(server.current.lookRows()),
    createMotionPlay: (...args: Parameters<typeof actual.createMotionPlay>) => server.current.api.createMotionPlay(...args),
    saveMotionPlay: (...args: Parameters<typeof actual.saveMotionPlay>) => server.current.api.saveMotionPlay(...args),
    getMotionPlay: (...args: Parameters<typeof actual.getMotionPlay>) => server.current.api.getMotionPlay(...args),
    deleteMotionPlay: (...args: Parameters<typeof actual.deleteMotionPlay>) => server.current.api.deleteMotionPlay(...args),
  }
})
// A configured viewer - the build-time VITE_MOTION_LAB_3D_URL.
vi.mock('./viewIn3D', async (importOriginal) => ({ ...(await importOriginal<typeof import('./viewIn3D')>()), VIEWER_3D_URL: 'http://localhost:5190/' }))
import MotionLabEditorPage from './MotionLabEditorPage'

/**
 * PREVIEW 3D, INSIDE MOTION LAB. The viewer opens over the editor - the same
 * play, no new tab, no pop-up - and "Back to Motion Lab" (or Escape) returns to
 * the editor exactly as it was. A saved play is handed over as saved, after
 * its last edit has landed; the unsaved play as the draft on screen. Nothing
 * is created or saved to preview it, and the coach is never told to try again.
 */

installPointerStubs()

const OWNER = { id: 1, organization_id: 7, is_platform_owner: true }
const ORIGIN = 'http://localhost:5190'
const writes = () => server.current.calls.filter((c) => c.kind === 'create' || c.kind === 'save')

async function openAt(path: string) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/motion-lab/plays/:playId" element={<MotionLabEditorPage />} />
        <Route path="/motion-lab" element={<MotionLabEditorPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(document.querySelector('.motion-lab-root svg.board')).not.toBeNull())
  await act(async () => settle())
}

const frame = () => document.querySelector<HTMLIFrameElement>('iframe.preview-3d-frame')
/** The viewer, framed, asks for its play; resolves with what Motion Lab answered. */
async function viewerAsks(playId: number | 'draft', requestId = 'r1') {
  const viewer = frame()!.contentWindow!
  const post = vi.spyOn(viewer, 'postMessage').mockImplementation(() => {})
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: viewer, origin: ORIGIN, data: { type: 'peira-3d:ready', requestId, playId } }))
  })
  await waitFor(() => expect(post).toHaveBeenCalled(), { timeout: 3000 })
  const [message, target] = post.mock.calls[0] as [{ type: string; requestId: string; payload: { play: Record<string, unknown>; document: { players: { id: string; y: number }[] } } }, string]
  return { message, target }
}

beforeEach(() => {
  server.current = fakeMotionServer()
  resetMotionLabSessions()
  localStorage.clear()
})
afterEach(async () => {
  window.dispatchEvent(new Event('online'))
  await act(async () => settle(10))
  vi.restoreAllMocks()
})

describe('Preview 3D inside Motion Lab', () => {
  it('shows the saved play over the editor, framed - no new window - and Back returns to it unchanged', async () => {
    const [a] = gapPlays()
    void server.current.api.createMotionPlay({ name: a.name, document: toDocument(a), schema_version: 1 })
    await settle()
    const opened = vi.spyOn(window, 'open')
    await openAt('/motion-lab/plays/100')
    const before = writes().length

    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D' }))
    const dialog = screen.getByRole('dialog', { name: `${a.name} in 3D` })
    expect(dialog.textContent).toContain(a.name)
    expect(dialog.textContent).not.toContain('Unsaved')
    const src = new URL(frame()!.src)
    expect(src.origin).toBe(ORIGIN)
    expect(Object.fromEntries(src.searchParams)).toEqual({ source: 'peira', play: '100', embed: '1' })
    expect(opened).not.toHaveBeenCalled()
    // The way back is the first thing the keyboard reaches.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '← Back to Motion Lab' }))

    const { message, target } = await viewerAsks(100)
    expect(target).toBe(ORIGIN)
    expect(message).toMatchObject({ type: 'peira-motion-lab:play', requestId: 'r1' })
    expect(message.payload.play).toMatchObject({ id: 100, revision: 1, name: a.name })

    fireEvent.click(screen.getByRole('button', { name: '← Back to Motion Lab' }))
    expect(screen.queryByRole('dialog', { name: `${a.name} in 3D` })).toBeNull()
    expect(document.querySelector('.motion-lab-root .play-name')!.textContent).toBe(a.name)
    expect(writes()).toHaveLength(before)
  })

  it('previews the unsaved play as it is on screen, saving nothing, labelled Unsaved', async () => {
    const DEFAULT = newPlay()
    await openAt('/motion-lab')
    dragPlayer(DEFAULT, 'O8', 0, 3)

    // Straight after the drag, inside the quiet period: the draft still carries it.
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D' }))
    expect(screen.getByRole('dialog').textContent).toContain('Unsaved')
    expect(new URL(frame()!.src).searchParams.get('play')).toBe('draft')

    const { message } = await viewerAsks('draft')
    expect(message.payload.play).toMatchObject({ id: null, revision: null, draft: true, name: 'New play' })
    const o8 = message.payload.document.players.find((p) => p.id === 'O8')!
    expect(o8.y).toBeCloseTo(DEFAULT.players.find((p) => p.id === 'O8')!.y + 3, 6)
    expect(writes()).toHaveLength(0)

    // Escape closes it too.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(writes()).toHaveLength(0)
  })

  it('a saved play edited a moment ago is handed over once that edit has saved - never a step behind', async () => {
    const [a] = gapPlays()
    void server.current.api.createMotionPlay({ name: a.name, document: toDocument(a), schema_version: 1 })
    await settle()
    await openAt('/motion-lab/plays/100')
    dragPlayer(a, 'O8', 0, -2)
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D' }))

    const { message } = await viewerAsks(100)
    expect(message.type).toBe('peira-motion-lab:play')
    expect(message.payload.play).toMatchObject({ id: 100, revision: 2 })
    const o8 = message.payload.document.players.find((p) => p.id === 'O8')!
    expect(o8.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
    // No notice, no "try again".
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('answers only its own viewer, at the viewer origin, for the play it opened', async () => {
    await openAt('/motion-lab')
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D' }))
    const viewer = frame()!.contentWindow!
    const post = vi.spyOn(viewer, 'postMessage').mockImplementation(() => {})
    const send = (init: MessageEventInit) => window.dispatchEvent(new MessageEvent('message', init))
    await act(async () => {
      send({ source: viewer, origin: 'http://evil.test', data: { type: 'peira-3d:ready', requestId: 'x', playId: 'draft' } })
      send({ source: window, origin: ORIGIN, data: { type: 'peira-3d:ready', requestId: 'y', playId: 'draft' } })
      send({ source: viewer, origin: ORIGIN, data: { type: 'peira-3d:ready', requestId: 'z', playId: 100 } })
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('2D | 3D from Teach', () => {
  it('Teach a moment offers the same play in 3D, and "Back to Teach" returns to the teaching screen', async () => {
    await openAt('/motion-lab')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Teach a moment/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Teach' }))
    fireEvent.click(screen.getByRole('button', { name: '3D' }))
    expect(screen.queryByRole('dialog', { name: 'Teach New play' })).toBeNull()
    expect(new URL(frame()!.src).searchParams.get('play')).toBe('draft')
    fireEvent.click(screen.getByRole('button', { name: '← Back to Teach' }))
    expect(screen.getByRole('dialog', { name: 'Teach New play' })).toBeInTheDocument()
  })
})
