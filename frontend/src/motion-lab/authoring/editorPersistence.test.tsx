import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import type { PlayRepository } from '../storage/playRepository'
import { gapPlays } from '../__characterization__/fixtures'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * WHAT THE EDITOR PROMISES ABOUT SAVING, through the repository boundary.
 *
 * These are the prototype's autosave rules, pinned so P2 can swap browser
 * storage for PEIRA's server and be held to the same behaviour: an edit made
 * inside the quiet period is not lost when the coach switches plays, a reload
 * reopens the play they were on, and rename / duplicate / delete / looks all
 * land in storage.
 */

class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}
const saved: Record<string, unknown> = {}
beforeAll(() => {
  saved.PointerEvent = (globalThis as Record<string, unknown>).PointerEvent
  saved.DOMPoint = (globalThis as Record<string, unknown>).DOMPoint
  saved.getScreenCTM = (SVGElement.prototype as unknown as Record<string, unknown>).getScreenCTM
  saved.setPointerCapture = Element.prototype.setPointerCapture
  saved.releasePointerCapture = Element.prototype.releasePointerCapture
  Object.assign(globalThis, {
    PointerEvent: TestPointerEvent,
    DOMPoint: class {
      x: number
      y: number
      constructor(x = 0, y = 0) {
        this.x = x
        this.y = y
      }
      matrixTransform() {
        return { x: this.x, y: this.y }
      }
    },
  })
  Object.assign(SVGElement.prototype, { getScreenCTM: () => ({ inverse: () => ({}) }) })
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
})
afterAll(() => {
  Object.assign(globalThis, { PointerEvent: saved.PointerEvent, DOMPoint: saved.DOMPoint })
  Object.assign(SVGElement.prototype, { getScreenCTM: saved.getScreenCTM })
  Element.prototype.setPointerCapture = saved.setPointerCapture as Element['setPointerCapture']
  Element.prototype.releasePointerCapture = saved.releasePointerCapture as Element['releasePointerCapture']
})

let repo: PlayRepository
beforeEach(() => {
  localStorage.clear()
  repo = createLocalPlayRepository()
})

const board = () => document.querySelector('svg.board') as SVGSVGElement
const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const stored = (id: string) => repo.listPlays().find((p) => p.id === id)

function seed(plays: Play[], current: string) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: plays }))
  localStorage.setItem(CURRENT_KEY, current)
}

function drag(play: Play, id: string, dx: number, dy: number) {
  const p = play.players.find((pl) => pl.id === id)!
  const g = board().querySelector(`[data-player="${id}"]`)!
  fireEvent.pointerDown(g, { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerMove(board(), { pointerId: 1, ...client(p.x + dx, p.y + dy) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + dx, p.y + dy) })
}

const playMenu = () => fireEvent.click(document.querySelector('.play-btn')!)

describe('Motion Lab editor persistence', () => {
  it('reopens the play the coach was on, unchanged, and opening it is not an edit', () => {
    const [a, b] = gapPlays()
    seed([a, b], b.id)
    vi.useFakeTimers()
    try {
      const before = localStorage.getItem(PLAYS_KEY)
      render(<MotionLabEditor repository={repo} />)
      expect(document.querySelector('.play-name')!.textContent).toBe(b.name)
      act(() => vi.advanceTimersByTime(2000))
      // Nothing was written at all: the bytes on disk are the ones the play
      // arrived with, version and all. (Reading stamps the reader's version
      // in memory - P3.1 raised it to 2 - which is why the stored bytes, not
      // the loaded object, are what "not an edit" has to mean.)
      expect(localStorage.getItem(PLAYS_KEY)).toBe(before)
      expect({ ...stored(b.id)!, v: b.v }).toEqual(b)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an edit inside the autosave quiet period survives an immediate switch to another play', () => {
    const [a, b] = gapPlays()
    seed([a, b], a.id)
    render(<MotionLabEditor repository={repo} />)
    drag(a, 'O8', 0, -2)
    // No waiting for the 400 ms debounce: switch straight away.
    playMenu()
    fireEvent.click(within(document.querySelector('.play-list') as HTMLElement).getByText(b.name))
    expect(document.querySelector('.play-name')!.textContent).toBe(b.name)
    const moved = stored(a.id)!.players.find((p) => p.id === 'O8')!
    expect(moved.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
    expect(repo.currentPlayId()).toBe(b.id)
  })

  it('an edit inside the quiet period survives leaving Motion Lab for another PEIRA page', () => {
    // Navigating within the app unmounts the editor without any pagehide.
    const [a] = gapPlays()
    seed([a], a.id)
    const { unmount } = render(<MotionLabEditor repository={repo} />)
    drag(a, 'O8', 0, -3)
    unmount()
    expect(stored(a.id)!.players.find((p) => p.id === 'O8')!.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 3, 6)
  })

  it('autosaves an edit after the quiet period, and a reload shows it', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    vi.useFakeTimers()
    try {
      render(<MotionLabEditor repository={repo} />)
      drag(a, 'O5', 1, 0)
      act(() => vi.advanceTimersByTime(500))
      expect(stored(a.id)!.players.find((p) => p.id === 'O5')!.x).toBeCloseTo(a.players.find((p) => p.id === 'O5')!.x + 1, 6)
    } finally {
      vi.useRealTimers()
    }
    cleanup()
    render(<MotionLabEditor repository={createLocalPlayRepository()} />)
    expect(document.querySelector('.play-name')!.textContent).toBe(a.name)
    const g = board().querySelector('[data-player="O5"]')!
    expect(g.getAttribute('transform')).toBe(`translate(${(a.players.find((p) => p.id === 'O5')!.x + 1) * U} ${(Y_MAX - a.players.find((p) => p.id === 'O5')!.y) * U})`)
  })

  it('renames, duplicates and deletes through the repository', () => {
    const [a, b] = gapPlays()
    seed([a, b], a.id)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<MotionLabEditor repository={repo} />)

      playMenu()
      fireEvent.click(screen.getByRole('button', { name: 'Rename…' }))
      const nameInput = document.querySelector('input.inline-name') as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'Toss Crack' } })
      fireEvent.keyDown(nameInput, { key: 'Enter' })
      playMenu()
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
      // Duplicate saves the source first, then opens the copy for renaming.
      expect(stored(a.id)!.name).toBe('Toss Crack')
      const copies = repo.listPlays().filter((p) => p.name === 'Toss Crack (copy)')
      expect(copies).toHaveLength(1)
      expect(copies[0].players).toEqual(stored(a.id)!.players)
      fireEvent.keyDown(document.querySelector('input.inline-name')!, { key: 'Escape' })

      playMenu()
      fireEvent.click(screen.getByRole('button', { name: 'Delete play' }))
      expect(stored(copies[0].id)).toBeUndefined()
      expect(repo.listPlays().map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('saves a look and starts a new play from it', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    render(<MotionLabEditor repository={repo} />)
    // ML-UX-4 renamed the coach-facing control to Formation (SPEC §13).
      // The stored concept is still a Look: what this test asserts below.
      fireEvent.click(screen.getByRole('button', { name: /^Formation/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save this formation…' }))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Base 11' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(repo.listLooks().map((l) => l.name)).toEqual(['Base 11'])
    expect(repo.listLooks()[0].players.every((p) => p.path.length === 0)).toBe(true)

    // The Look menu stays open after saving, with the new look listed.
    fireEvent.click(screen.getByRole('button', { name: 'New play' }))
    expect(repo.listPlays().map((p) => p.name)).toContain('Base 11 — new play')
    expect(document.querySelector('.play-name')!.textContent).toBe('Base 11 — new play')
  })
})

/**
 * THE BUILT-IN SAVE INDICATOR (ML-UX-6, SPEC §3.3).
 *
 * "Saving…" from the first edit until the write lands - the quiet period AND
 * the write. Before this it read "Saved" throughout the quiet period, which is
 * precisely the window in which an edit is NOT yet saved.
 *
 * This is the editor's fallback. Inside PEIRA the page passes `saveStatus`,
 * the server-backed indicator, and that one is authoritative - it is the only
 * one that knows whether a network write landed. The last test here pins that
 * the fallback never competes with it.
 */
describe('the built-in save indicator', () => {
  const indicator = () => document.querySelector('.bar .saved') as HTMLElement | null
  const text = () => indicator()?.textContent ?? null
  const failed = () => indicator()?.classList.contains('failed') ?? false

  afterEach(() => vi.useRealTimers())

  it('opening a play is not an edit, so it never reads Saving…', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    vi.useFakeTimers()
    render(<MotionLabEditor repository={repo} />)
    expect(text()).toBe('')
    act(() => vi.advanceTimersByTime(2000))
    expect(text()).toBe('')
  })

  it('reads Saving… for the whole quiet period, then Saved', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    vi.useFakeTimers()
    render(<MotionLabEditor repository={repo} />)

    drag(a, 'O8', 0, -2)
    expect(text()).toBe('Saving…')
    act(() => vi.advanceTimersByTime(399))
    expect(text()).toBe('Saving…')
    // Nothing has been written yet - which is exactly why it must not say Saved.
    // (`v` is the reader's stamp, not the play's content; see above.)
    expect({ ...stored(a.id)!, v: a.v }).toEqual(a)

    act(() => vi.advanceTimersByTime(1))
    expect(text()).toBe('Saved')
    expect(failed()).toBe(false)
  })

  it('still reads Saving… while the write itself is running', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    const during: (string | null)[] = []
    const watched: PlayRepository = {
      ...repo,
      savePlay: (p) => {
        during.push(text())
        return repo.savePlay(p)
      },
    }
    vi.useFakeTimers()
    render(<MotionLabEditor repository={watched} />)

    drag(a, 'O8', 0, -2)
    act(() => vi.advanceTimersByTime(500))

    expect(during).toEqual(['Saving…'])
    expect(text()).toBe('Saved')
  })

  it('a failed write reads Not saved; the next edit is the retry, and reads Saving… until it lands', () => {
    const [a] = gapPlays()
    seed([a], a.id)
    let broken = true
    const flaky: PlayRepository = { ...repo, savePlay: (p) => (broken ? false : repo.savePlay(p)) }
    vi.useFakeTimers()
    render(<MotionLabEditor repository={flaky} />)

    drag(a, 'O8', 0, -2)
    act(() => vi.advanceTimersByTime(500))
    expect(text()).toBe('Not saved')
    expect(failed()).toBe(true)

    // Still failing: the retry says so, then comes straight back to Not saved.
    drag(a, 'O5', 1, 0)
    expect(text()).toBe('Saving…')
    expect(failed()).toBe(false)
    act(() => vi.advanceTimersByTime(500))
    expect(text()).toBe('Not saved')

    // Storage recovers: the next edit's write lands, and so does the last one's.
    broken = false
    drag(a, 'O5', 1, 0)
    expect(text()).toBe('Saving…')
    act(() => vi.advanceTimersByTime(500))
    expect(text()).toBe('Saved')
    expect(failed()).toBe(false)
    expect(stored(a.id)!.players.find((p) => p.id === 'O8')!.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
  })

  it('a switch to another play flushes the pending edit, and nothing is left reading Saving…', () => {
    const [a, b] = gapPlays()
    seed([a, b], a.id)
    render(<MotionLabEditor repository={repo} />)

    drag(a, 'O8', 0, -2)
    expect(text()).toBe('Saving…')
    playMenu()
    fireEvent.click(within(document.querySelector('.play-list') as HTMLElement).getByText(b.name))

    expect(text()).toBe('Saved')
    expect(stored(a.id)!.players.find((p) => p.id === 'O8')!.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
  })

  it.each([
    ['pagehide', () => window.dispatchEvent(new Event('pagehide'))],
    ['beforeunload', () => window.dispatchEvent(new Event('beforeunload'))],
    [
      'the tab going hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      },
    ],
  ])('%s flushes the pending edit and settles the indicator', (_label, leave) => {
    const [a] = gapPlays()
    seed([a], a.id)
    render(<MotionLabEditor repository={repo} />)

    drag(a, 'O8', 0, -2)
    expect(text()).toBe('Saving…')
    try {
      act(() => leave())
    } finally {
      // Restore the real getter for every later test.
      delete (document as unknown as Record<string, unknown>).visibilityState
    }

    expect(text()).toBe('Saved')
    expect(stored(a.id)!.players.find((p) => p.id === 'O8')!.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
  })

  it('a page indicator given as a function is told editPending, from the edit until the handoff', () => {
    // The contract the page's server-backed indicator is built on: the one
    // stretch only the editor knows about.
    const [a] = gapPlays()
    seed([a], a.id)
    const atHandoff: string[] = []
    const probe = () => document.querySelector('.probe')?.textContent
    const watched: PlayRepository = {
      ...repo,
      savePlay: (p) => {
        atHandoff.push(probe()!)
        return repo.savePlay(p)
      },
    }
    vi.useFakeTimers()
    render(<MotionLabEditor repository={watched} saveStatus={({ editPending }) => <span className="probe">{String(editPending)}</span>} />)
    expect(probe()).toBe('false')

    drag(a, 'O8', 0, -2)
    expect(probe()).toBe('true')
    act(() => vi.advanceTimersByTime(399))
    expect(probe()).toBe('true')
    act(() => vi.advanceTimersByTime(1))

    // Still pending while the repository is being handed the play; over once
    // it has it. Everything after that is the repository's to report.
    expect(atHandoff).toEqual(['true'])
    expect(probe()).toBe('false')
    expect(indicator()).toBeNull()
  })

  it("the page's own indicator still replaces it outright", () => {
    const [a] = gapPlays()
    seed([a], a.id)
    vi.useFakeTimers()
    render(<MotionLabEditor repository={repo} saveStatus={<span className="server-status">Saved on the server</span>} />)

    drag(a, 'O8', 0, -2)
    expect(indicator()).toBeNull()
    expect(document.querySelector('.server-status')!.textContent).toBe('Saved on the server')
    act(() => vi.advanceTimersByTime(500))
    expect(indicator()).toBeNull()
    // The fallback stepping aside changes nothing about the save itself.
    expect(stored(a.id)!.players.find((p) => p.id === 'O8')!.y).toBeCloseTo(a.players.find((p) => p.id === 'O8')!.y - 2, 6)
  })
})
