import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { gapPlays, panePlays } from '../__characterization__/fixtures'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * THE OVERHEAD BOARD'S MARKUP, PINNED.
 *
 * The overhead SVG is the field a coach authors on, and P1 moves it out of the
 * prototype editor into a reusable OverheadBoard. These snapshots are the SVG
 * the editor renders in every branch the board draws - paths and their
 * continuation, pre-snap dashes, engagement markers and links, catch and
 * throw markers, selection, body/look stubs, edit handles, pick rings and
 * dimming, the catch target, a draft route, Present and telestration - taken
 * BEFORE the extraction. The extracted board must reproduce them exactly.
 *
 * Markup, not pixels: jsdom does no layout, so this pins what is drawn and in
 * what order (SVG paints in document order), which is what an extraction can
 * break.
 */

// ---- the browser APIs the editor's pointer handling needs, which jsdom lacks

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
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
  // Client pixels ARE viewBox units here: an identity screen transform.
  Object.assign(globalThis, {
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

beforeEach(() => {
  localStorage.clear()
})

// ---- helpers

const board = () => document.querySelector('svg.board') as SVGSVGElement
/** One tag per line, so a failing snapshot diff reads as a list of elements. */
const markup = () => board().outerHTML.replace(/></g, '>\n<')
const snap = (name: string) => expect(markup()).toMatchFileSnapshot(`./__snapshots__/overhead/${name}.svg.html`)

/** Field yards -> client coordinates under the identity transform. */
const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

function scrub(t: number) {
  fireEvent.change(document.querySelector('.scrub input[type=range]')!, { target: { value: String(t) } })
}

function pointer(el: Element, kind: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) {
  fireEvent[kind](el, { button: 0, pointerId: 1, ...client(x, y) })
}

function clickPlayer(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  const g = board().querySelector(`[data-player="${id}"]`)!
  pointer(g, 'pointerDown', p.x, p.y)
  pointer(board(), 'pointerUp', p.x, p.y)
}

const key = (k: string) => fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k })
const pane = (name: string) => panePlays().find((p) => p.name === name)!
const gap = (id: string) => gapPlays().find((p) => p.id === id)!

describe('overhead board markup', () => {
  it('pre-snap motion and a pitch, through the play', async () => {
    const play = gap('fx_motion_pitch')
    open(play)
    await snap('motion-pitch-t0')
    scrub(1.2)
    await snap('motion-pitch-t1.2')
    scrub(3.2)
    await snap('motion-pitch-t3.2')
  })

  it('engage -> release with the engagement link, and edit handles', async () => {
    const play = gap('fx_engage_release_delayed')
    open(play)
    await snap('engage-t0')
    scrub(0.8)
    await snap('engage-t0.8')
    scrub(0)
    clickPlayer(play, 'O5')
    await snap('engage-selected')
    act(() => key('e'))
    await snap('engage-edit-handles')
  })

  it('a derived throw point and catch marker, selection and body/look', async () => {
    const play = pane('Trips Out')
    open(play)
    await snap('trips-out-t0')
    scrub(1.6)
    await snap('trips-out-t1.6')
    const qb = play.players.find((p) => p.label === 'QB')!
    scrub(0)
    clickPlayer(play, qb.id)
    await snap('trips-out-qb-selected')
  })

  it('a manual throw point (Throw From Here) and an explicit Settle', async () => {
    open(gap('fx_settle_throw_from_here'))
    await snap('settle-throw-t0')
    scrub(1.9)
    await snap('settle-throw-t1.9')
  })

  it('ball setup: pick rings and dimming, then the catch target', async () => {
    const play = pane('Trips Out')
    open(play)
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.startsWith('🏈'))!)
    // "Pass…" appears twice once a pass exists: the first action, then "Then…".
    fireEvent.click(screen.getAllByRole('button', { name: 'Pass…' })[0])
    await snap('setup-pick-target')
    const receiver = play.players.find((p) => p.side === 'offense' && p.label === 'H')!
    clickPlayer(play, receiver.id)
    await snap('setup-pick-catch')
    // A catch asked for barely past the break of the route - earlier than the
    // QB can get the ball there - so the planner moves it: the requested spot
    // and the adjusted catch are both drawn.
    const [a, b] = receiver.path
    const early = { x: a.x + (b.x - a.x) * 0.2, y: a.y + (b.y - a.y) * 0.2 }
    pointer(board(), 'pointerMove', early.x, early.y)
    await snap('setup-pick-catch-hover')
    pointer(board(), 'pointerDown', early.x, early.y)
    pointer(board(), 'pointerUp', early.x, early.y)
    await snap('catch-adjusted')
  })

  it('a receiver carried past his drawn route (continuation)', async () => {
    open(pane('Untitled Play'))
    await snap('continuation-t0')
  })

  it('a draft route while drawing', async () => {
    const play = pane('Inside Zone Rt')
    open(play)
    const y = play.players.find((p) => p.label === 'Y')!
    clickPlayer(play, y.id)
    act(() => key('d'))
    pointer(board().querySelector(`[data-player="${y.id}"]`)!, 'pointerDown', y.x, y.y)
    pointer(board(), 'pointerMove', y.x + 1, y.y + 3)
    pointer(board(), 'pointerMove', y.x + 3, y.y + 6)
    await snap('draw-draft')
    pointer(board(), 'pointerUp', y.x + 3, y.y + 6)
    await snap('draw-committed')
  })

  it('Present: a highlighted man and telestration marks', async () => {
    const play = pane('Reverse')
    open(play)
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))
    clickPlayer(play, play.players[6].id)
    await snap('present-highlight')
    fireEvent.click(screen.getByRole('button', { name: /Draw/ }))
    pointer(board(), 'pointerDown', 20, 2)
    pointer(board(), 'pointerMove', 24, 5)
    pointer(board(), 'pointerMove', 30, 7)
    pointer(board(), 'pointerUp', 30, 7)
    await snap('present-telestration')
  })
})
