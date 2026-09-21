import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import * as authModule from '../auth/AuthContext'
import { ApiError } from '../api/client'
import { resetMotionLabSessions, toDocument } from './storage/apiPlayRepository'
import { fakeMotionServer, settle } from './storage/testing/fakeMotionApi'
import { board, dragPlayer, installPointerStubs } from './testing/pointerStubs'
import { gapPlays } from './__characterization__/fixtures'

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
    createMotionLook: (...args: Parameters<typeof actual.createMotionLook>) => server.current.api.createMotionLook(...args),
    deleteMotionLook: (...args: Parameters<typeof actual.deleteMotionLook>) => server.current.api.deleteMotionLook(...args),
  }
})
import MotionLabEditorPage from './MotionLabEditorPage'

/**
 * THE EDITOR ON PEIRA'S SERVER, end to end in jsdom: the validated editor, the
 * Motion Lab session and this page, against a fake server with the real
 * server's rules. What is proven here is what a coach relies on - autosave
 * reaches the server, nothing pending is lost when they switch plays or leave,
 * a reload shows their work, and a conflict stops and asks.
 */

installPointerStubs()

const OWNER = { id: 1, organization_id: 7, is_platform_owner: true }
let lastPath = ''
function PathProbe() {
  lastPath = useLocation().pathname
  return null
}

function seedPlays() {
  const [a, b] = gapPlays()
  for (const play of [a, b]) {
    void server.current.api.createMotionPlay({ name: play.name, document: toDocument(play), schema_version: 1 })
  }
  return { a, b }
}

async function openEditor(id: number) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
  render(
    <MemoryRouter initialEntries={[`/motion-lab/plays/${id}`]}>
      <PathProbe />
      <Routes>
        <Route path="/motion-lab/plays/:playId" element={<MotionLabEditorPage />} />
        <Route path="/motion-lab" element={<div>library</div>} />
        <Route path="/motion-lab/folders/:folderId" element={<div>library folder</div>} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(document.querySelector('.motion-lab-root svg.board')).not.toBeNull())
  await act(async () => settle())
}

const playName = () => document.querySelector('.motion-lab-root .play-name')!.textContent
const statusText = () => screen.getByRole('status').textContent

beforeEach(async () => {
  server.current = fakeMotionServer()
  resetMotionLabSessions()
  localStorage.clear()
  lastPath = ''
})
// SESSIONS OUTLIVE THEIR TEST. resetMotionLabSessions() only forgets them;
// their retry timers keep running, and the api mock above forwards to
// whichever fake server is current when a request is made. So a retry one test
// leaves scheduled fires into the NEXT test's server, where it can take that
// test's failNextWith or write over its play 100. (Found when a new failure test
// passed alone and failed after "a failed save says so".) Send every scheduled
// retry now, into this test's own server, while it is still the current one -
// and BEFORE the mocks are restored: the retry re-renders the page, which
// needs the mocked useAuth.
afterEach(async () => {
  window.dispatchEvent(new Event('online'))
  await act(async () => settle(10))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Motion Lab editor on the server', () => {
  it('opens the play in the URL and autosaves an edit to the server from its revision', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    expect(statusText()).toBe('Saved')

    dragPlayer(a, 'O8', 0, -2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle(10)
    })
    const save = server.current.calls.find((c) => c.kind === 'save')!
    expect(save).toMatchObject({ id: 100, body: { base_revision: 1 } })
    const o8 = (server.current.plays.get(100)!.document.players as { id: string; y: number }[]).find((p) => p.id === 'O8')!
    expect(o8.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
    await waitFor(() => expect(statusText()).toBe('Saved'))
  })

  it('an edit inside the quiet period survives switching plays, and the URL follows', async () => {
    const { a, b } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    dragPlayer(a, 'O5', 1, 0)
    fireEvent.click(document.querySelector('.play-btn')!)
    fireEvent.click(within(document.querySelector('.play-list') as HTMLElement).getByText(b.name))
    await act(async () => settle(10))
    expect(playName()).toBe(b.name)
    await waitFor(() => expect(lastPath).toBe('/motion-lab/plays/101'))
    const o5 = (server.current.plays.get(100)!.document.players as { id: string; x: number }[]).find((p) => p.id === 'O5')!
    expect(o5.x).toBeCloseTo(a.players.find((p) => p.id === 'O5')!.x + 1, 6)
  })

  it('an edit inside the quiet period survives leaving for the Library, and a fresh load shows it', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    dragPlayer(a, 'O8', 0, 3)
    fireEvent.click(screen.getByRole('button', { name: '← Library' }))
    await act(async () => settle(10))
    expect(lastPath).toBe('/motion-lab')

    // Another browser: no session, no drafts - only what the server holds.
    cleanup()
    resetMotionLabSessions()
    localStorage.clear()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    const x = board().querySelector('[data-player="O8"]')!.getAttribute('transform')
    const o8 = a.players.find((p) => p.id === 'O8')!
    expect(x).toBe(`translate(${o8.x * 20} ${(17 - (o8.y + 3)) * 20})`)
  })

  it('a conflict stops and asks; "Load the latest version" reopens the server version', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    server.current.editElsewhere(100, 'Renamed by the DC')
    dragPlayer(a, 'O8', 0, -1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle(10)
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('This play was changed somewhere else.')
    expect(statusText()).toBe('Not saved')

    fireEvent.click(screen.getByRole('button', { name: 'Load the latest version' }))
    await waitFor(() => expect(playName()).toBe('Renamed by the DC'))
    await act(async () => settle(10))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(statusText()).toBe('Saved')
    expect(server.current.calls.filter((c) => c.kind === 'save')).toHaveLength(1)
  })

  it('a conflict can keep the coach\'s version as a copy - nothing is lost', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    server.current.editElsewhere(100, 'Renamed by the DC')
    dragPlayer(a, 'O8', 0, -1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle(10)
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine as a copy' }))
    await waitFor(() => expect(playName()).toBe(`${a.name} (my version)`))
    await act(async () => settle(10))
    const names = [...server.current.plays.values()].map((row) => row.name).sort()
    expect(names).toContain('Renamed by the DC')
    expect(names).toContain(`${a.name} (my version)`)
    const mine = [...server.current.plays.values()].find((row) => row.name.endsWith('(my version)'))!
    const o8 = (mine.document.players as { id: string; y: number }[]).find((p) => p.id === 'O8')!
    expect(o8.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 1, 6)
    await waitFor(() => expect(lastPath).toBe(`/motion-lab/plays/${mine.id}`))
  })

  it('a failed save says so and does not claim to be saved', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    server.current.failNextWith(new ApiError('Could not reach the server.', 0))
    dragPlayer(a, 'O8', 0, -1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
      await settle(10)
    })
    expect(statusText()).toBe('Not saved — retrying')
  })

  it('a look saved in the editor is saved to the server', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    // ML-UX-4 renamed the coach-facing control to Formation (SPEC §13).
      // The stored concept is still a Look: what this test asserts below.
      fireEvent.click(screen.getByRole('button', { name: /^Formation/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save this formation…' }))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Trips Rt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => settle(10))
    expect([...server.current.looks.values()].map((row) => row.name)).toEqual(['Trips Rt'])
  })

  it('a play that is not in the organization reads as not found', async () => {
    seedPlays()
    await settle()
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
    render(
      <MemoryRouter initialEntries={['/motion-lab/plays/555']}>
        <Routes>
          <Route path="/motion-lab/plays/:playId" element={<MotionLabEditorPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText("This play isn't in your Motion Lab.")).toBeInTheDocument()
  })
})

/**
 * THE INDICATOR A COACH ACTUALLY SEES (ML-UX-6, SPEC §3.3).
 *
 * The page's server-backed indicator replaces the editor's own, so this is
 * the one that has to say "Saving…" from the edit until the server confirms.
 * It used to read "Saved" for the editor's whole 400 ms quiet period - the
 * session had not yet been told anything changed - and "Saving…" only while
 * the request was out (28 ms in a real browser). The editor now hands the page
 * `editPending`; the session still decides everything after that.
 */
describe('the save indicator on the server path', () => {
  const sleep = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const saves = () => server.current.calls.filter((c) => c.kind === 'save')

  /** Every text the indicator shows, in order, from now on. */
  function watchStatus() {
    const seen = [statusText()]
    const observer = new MutationObserver(() => {
      const now = document.querySelector('.motion-lab-root .bar .saved')?.textContent ?? '(gone)'
      if (seen.at(-1) !== now) seen.push(now)
    })
    observer.observe(document.querySelector('.motion-lab-root .bar')!, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      return seen
    }
  }

  it('Saved, then Saving… from the edit, through the quiet period and the write, then Saved', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    const seen = watchStatus()
    expect(statusText()).toBe('Saved')
    server.current.hold()

    dragPlayer(a, 'O8', 0, -2)
    expect(statusText()).toBe('Saving…')

    // The window that used to read "Saved": nothing has been sent.
    await sleep(200)
    expect(statusText()).toBe('Saving…')
    expect(saves()).toHaveLength(0)

    // Handed over: the request is out and held. The editor is no longer
    // holding anything, so this "Saving…" is the SESSION's.
    await sleep(250)
    expect(saves()).toHaveLength(1)
    expect(statusText()).toBe('Saving…')

    // Only the server's answer makes it "Saved".
    server.current.release()
    await act(async () => settle(10))
    expect(statusText()).toBe('Saved')
    expect(seen()).toEqual(['Saved', 'Saving…', 'Saved'])
  })

  it('opening a play is not an edit: it never reads Saving…', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    const seen = watchStatus()

    await sleep(600)

    expect(seen()).toEqual(['Saved'])
    expect(saves()).toHaveLength(0)
  })

  it('a switch mid quiet period flushes the edit, and nothing is left reading Saving…', async () => {
    const { a, b } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))

    dragPlayer(a, 'O5', 1, 0)
    expect(statusText()).toBe('Saving…')
    fireEvent.click(document.querySelector('.play-btn')!)
    fireEvent.click(within(document.querySelector('.play-list') as HTMLElement).getByText(b.name))
    await act(async () => settle(10))

    expect(playName()).toBe(b.name)
    expect(statusText()).toBe('Saved')
    const o5 = (server.current.plays.get(100)!.document.players as { id: string; x: number }[]).find((p) => p.id === 'O5')!
    expect(o5.x).toBeCloseTo(a.players.find((p) => p.id === 'O5')!.x + 1, 6)
  })

  it('after a network failure an edit does not pretend a save has started; the retry carries it', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    server.current.failNextWith(new ApiError('Could not reach the server.', 0))
    dragPlayer(a, 'O8', 0, -1)
    await sleep(450)
    await act(async () => settle(10))
    expect(statusText()).toBe('Not saved — retrying')
    const sent = saves().length

    // A retry is already scheduled and this edit will ride on it; nothing new
    // is sent now, so "Saving…" would be a claim about an attempt that is
    // not happening.
    dragPlayer(a, 'O5', 1, 0)
    expect(statusText()).toBe('Not saved — retrying')
    await sleep(450)
    await act(async () => settle(10))
    expect(statusText()).toBe('Not saved — retrying')
    expect(saves()).toHaveLength(sent)

    // The connection comes back: the retry goes out with the latest version,
    // and only its answer makes it "Saved".
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await settle(10)
    })
    expect(statusText()).toBe('Saved')
    const stored = server.current.plays.get(100)!.document.players as { id: string; x: number; y: number }[]
    expect(stored.find((p) => p.id === 'O5')!.x).toBeCloseTo(a.players.find((p) => p.id === 'O5')!.x + 1, 6)
  })

  it('a refused save stays Not saved, and later edits do not claim to be saving', async () => {
    const { a } = seedPlays()
    await settle()
    await openEditor(100)
    await waitFor(() => expect(playName()).toBe(a.name))
    server.current.failNextWith(new ApiError('This play is too large to save.', 413))
    dragPlayer(a, 'O8', 0, -1)
    await sleep(450)
    await act(async () => settle(10))
    expect(statusText()).toBe('Not saved')
    const sent = saves().length

    dragPlayer(a, 'O5', 1, 0)
    expect(statusText()).toBe('Not saved')
    await sleep(450)
    await act(async () => settle(10))
    expect(statusText()).toBe('Not saved')
    expect(saves()).toHaveLength(sent)
  })
})
