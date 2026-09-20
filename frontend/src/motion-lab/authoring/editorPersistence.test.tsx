import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
      render(<MotionLabEditor repository={repo} />)
      expect(document.querySelector('.play-name')!.textContent).toBe(b.name)
      act(() => vi.advanceTimersByTime(2000))
      expect(stored(b.id)).toEqual(b)
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
