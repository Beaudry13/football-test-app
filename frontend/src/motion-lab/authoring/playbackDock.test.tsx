import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import { newPlay } from '../engine/play'
import type { Play } from '../engine/play'

/**
 * THE PLAYBACK DOCK (ML-UX-2).
 *
 * Watching a play used to be spread across a bottom bar that also held display
 * settings, with Reset and Restart sitting side by side doing nearly the same
 * thing. The dock is one row: go back to the spot, play, step a frame at a
 * time, scrub, and - behind Display - decide what the field shows.
 *
 * Most of what is asserted here was NEVER TESTED BEFORE. Space, R, the scrub,
 * the SNAP mark, the rate and the path filter all worked and nothing watched
 * them, so this file is as much characterization of what must survive as it is
 * cover for what is new.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k, ...init }))

/** "Inside Zone Rt" - a real play, so the clock has something to run. */
const fixture = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const scrubInput = () => document.querySelector('.scrub input[type=range]') as HTMLInputElement
const timeText = () => dock().querySelector('.time')!.textContent
const at = () => Number(scrubInput().value)
const duration = () => Number(scrubInput().max)
const btn = (name: string | RegExp) => within(dock()).getByRole('button', { name })
const playBtn = () => dock().querySelector('.play-toggle') as HTMLButtonElement
const snapMark = () => dock().querySelector('.snap-mark') as HTMLElement | null
/** The pill itself, not the rate options inside its popover. */
const ratePill = () => dock().querySelector('.rate-pill') as HTMLButtonElement
const displayBtn = () => within(dock()).getByRole('button', { name: /^Display/ })

const setScrub = (t: number) => act(() => void fireEvent.change(scrubInput(), { target: { value: String(t) } }))

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = fixture()
})
afterEach(cleanup)

describe('play and pause', () => {
  it('toggles, and says which it is', () => {
    open(play)
    expect(playBtn().textContent).toContain('Play')

    fireEvent.click(playBtn())
    expect(playBtn().textContent).toContain('Pause')

    fireEvent.click(playBtn())
    expect(playBtn().textContent).toContain('Play')
  })

  it('Space still works, and still means play', () => {
    open(play)

    key(' ')
    expect(playBtn().textContent).toContain('Pause')

    key(' ')
    expect(playBtn().textContent).toContain('Play')
  })

  it('a play with nothing to watch offers no transport at all', () => {
    // An empty play: men on the field, nobody with anywhere to be.
    open({ ...newPlay('Nothing drawn'), id: play.id })

    expect(playBtn()).toBeDisabled()
    expect(btn('Restart')).toBeDisabled()
    expect(btn('Back 0.1 seconds')).toBeDisabled()
    expect(btn('Forward 0.1 seconds')).toBeDisabled()
    expect(timeText()).toBe('—')
  })
})

describe('the one restart', () => {
  it('from a stop, goes back to the spot and stays stopped', () => {
    open(play)
    setScrub(1.2)
    expect(at()).toBeCloseTo(1.2, 5)

    fireEvent.click(btn('Restart'))

    expect(at()).toBe(0)
    expect(playBtn().textContent).toContain('Play')
  })

  it('while playing, goes back to the spot and KEEPS playing', () => {
    open(play)
    fireEvent.click(playBtn())
    setScrub(1.2) // scrubbing pauses, as it always has
    fireEvent.click(playBtn())
    expect(playBtn().textContent).toContain('Pause')

    fireEvent.click(btn('Restart'))

    expect(at()).toBe(0)
    expect(playBtn().textContent).toContain('Pause')
  })

  it('R does what the button does', () => {
    open(play)
    fireEvent.click(playBtn())
    expect(playBtn().textContent).toContain('Pause')

    key('r')

    expect(at()).toBe(0)
    expect(playBtn().textContent).toContain('Pause')
  })
})

describe('stepping a frame at a time', () => {
  it('the buttons move the clock a tenth of a second', () => {
    open(play)
    setScrub(1)

    fireEvent.click(btn('Forward 0.1 seconds'))
    expect(at()).toBeCloseTo(1.1, 5)

    fireEvent.click(btn('Back 0.1 seconds'))
    expect(at()).toBeCloseTo(1, 5)
  })

  it('the arrow keys do the same, and Shift makes it half a second', () => {
    open(play)
    setScrub(1)

    key('ArrowRight')
    expect(at()).toBeCloseTo(1.1, 5)

    key('ArrowLeft')
    expect(at()).toBeCloseTo(1, 5)

    key('ArrowRight', { shiftKey: true })
    expect(at()).toBeCloseTo(1.5, 5)

    key('ArrowLeft', { shiftKey: true })
    expect(at()).toBeCloseTo(1, 5)
  })

  it('stops at the ends of the play', () => {
    open(play)

    setScrub(0)
    key('ArrowLeft')
    expect(at()).toBe(0)

    setScrub(duration())
    key('ArrowRight')
    expect(at()).toBeCloseTo(duration(), 5)
  })

  it('pauses first, because stepping is looking rather than watching', () => {
    open(play)
    fireEvent.click(playBtn())
    expect(playBtn().textContent).toContain('Pause')

    key('ArrowRight')

    expect(playBtn().textContent).toContain('Play')
  })

  it('ten steps forward land exactly on the second', () => {
    // 0.1 added ten times is not 1 in binary; the clock is rounded so a
    // stepped frame is the same frame a coach would scrub to.
    open(play)
    setScrub(0)
    for (let i = 0; i < 10; i++) key('ArrowRight')
    expect(at()).toBe(1)
  })
})

describe('shortcuts stay out of the way of typing', () => {
  it('the transport keys do nothing while a number is being typed', () => {
    open(play)
    setScrub(1)
    // The situation popover holds real number inputs.
    fireEvent.click(screen.getByRole('button', { name: /1st & 10/ }))
    const field = document.querySelector('.sit-pop input[type=number]') as HTMLInputElement
    expect(field).toBeTruthy()

    for (const k of [' ', 'r', 'ArrowLeft', 'ArrowRight']) {
      act(() => void fireEvent.keyDown(field, { key: k, code: k === ' ' ? 'Space' : k }))
    }
    act(() => void fireEvent.keyDown(field, { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true }))
    act(() => void fireEvent.keyDown(field, { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true }))

    expect(at()).toBeCloseTo(1, 5)
    expect(playBtn().textContent).toContain('Play')
  })
})

describe('the scrub', () => {
  it('lands on the same frame every time it is given the same moment', () => {
    open(play)
    setScrub(1.4)
    const once = board().innerHTML

    setScrub(0.3)
    setScrub(1.4)

    expect(board().innerHTML).toBe(once)
  })

  it('marks the snap, and only once there is a play to watch', () => {
    open(play)
    const mark = snapMark()
    expect(mark).not.toBeNull()
    // Somewhere inside the track, not pinned to either end.
    const left = Number.parseFloat(mark!.style.left)
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(100)
    expect(mark!.textContent).toBe('SNAP')

    cleanup()
    open({ ...newPlay('Nothing drawn'), id: 'p2' })
    expect(snapMark()).toBeNull()
  })

  it('shows where the clock is, relative to the snap', () => {
    open(play)
    setScrub(0)
    expect(timeText()).toMatch(/^[−+]/)
    const atZero = timeText()
    setScrub(1.4)
    expect(timeText()).not.toBe(atZero)
  })
})

describe('the rate pill', () => {
  it('opens, changes the rate, and closes', () => {
    open(play)
    expect(ratePill()).toHaveAttribute('aria-expanded', 'false')
    expect(ratePill().textContent).toContain('1×')

    fireEvent.click(ratePill())
    expect(ratePill()).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(within(dock().querySelector('.rate-pop') as HTMLElement).getByRole('button', { name: '1.5×' }))

    expect(ratePill().textContent).toContain('1.5×')
    expect(dock().querySelector('.rate-pop')).toBeNull()
  })
})

describe('Display', () => {
  it('holds Paths, and Paths still belongs to the play', async () => {
    open(play)
    fireEvent.click(displayBtn())
    expect(displayBtn()).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(within(dock()).getByRole('button', { name: 'Defense' }))
    await act(() => new Promise((r) => setTimeout(r, 450)))

    const stored = createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
    expect(stored.filter).toBe('defense')
  })

  it('holds Labels, and Labels is only this screen', () => {
    open(play)
    // The players' own labels, not the field's yard numbers.
    const labels = () => board().querySelectorAll('[data-player] text')
    expect(labels().length).toBeGreaterThan(0)

    fireEvent.click(displayBtn())
    fireEvent.click(within(dock()).getByRole('button', { name: 'Shown' }))

    expect(labels()).toHaveLength(0)
    expect(btn('Hidden')).toBeInTheDocument()
  })

  it('Escape closes it', () => {
    open(play)
    fireEvent.click(displayBtn())
    expect(dock().querySelector('.display-pop')).not.toBeNull()

    key('Escape')

    expect(dock().querySelector('.display-pop')).toBeNull()
  })
})

describe('the zones', () => {
  it('the instruction has left the top bar', () => {
    open(play)
    expect(document.querySelector('.top-hint')).toBeNull()
  })

  it("ML-UX-1's drawing feedback still shows - now in the strip", () => {
    open(play)
    const Y = play.players.find((p) => p.label === 'Y')!
    fireEvent.pointerDown(playerMarker(Y.id), { button: 0, pointerId: 1, ...client(Y.x, Y.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(Y.x, Y.y) })

    key('d')

    const banner = document.querySelector('.bar.context .banner')!
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain("Draw Y's assignment")
    expect(within(document.querySelector('.bar.context') as HTMLElement).getByRole('button', { name: /Cancel/ })).toBeInTheDocument()

    key('Escape')
    expect(document.querySelector('.bar.context .banner')).toBeNull()
  })
})
