// TESTS ONLY. The browser APIs the Motion Lab editor's pointer handling needs
// and jsdom lacks, installed for a test file and removed after it. Client
// pixels are viewBox units here: an identity screen transform.

import { afterAll, beforeAll } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}

export function installPointerStubs() {
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
}

export const board = () => document.querySelector('svg.board') as SVGSVGElement
const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })

/** Drag a player by (dx, dy) yards, the way a coach does. */
export function dragPlayer(play: Play, id: string, dx: number, dy: number) {
  const p = play.players.find((pl) => pl.id === id)!
  const g = board().querySelector(`[data-player="${id}"]`)!
  fireEvent.pointerDown(g, { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerMove(board(), { pointerId: 1, ...client(p.x + dx, p.y + dy) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x + dx, p.y + dy) })
}

export const playerMarker = (id: string) => board().querySelector(`[data-player="${id}"]`)!
export const routeHandle = (id: string) => board().querySelector(`[data-handle="${id}"]`)

/**
 * Draw a route, from wherever the gesture starts.
 *
 * ML-UX-1 gave drawing two ways in - the gold handle, and arming with D or the
 * Draw button and then dragging anywhere - so a test says which it means by
 * passing the element the pointer goes down on. `finish: false` leaves the
 * stroke in flight, for the tests about interrupting one.
 */
export function stroke(from: Element, points: [number, number][], { finish = true } = {}) {
  const [[x0, y0], ...rest] = points
  fireEvent.pointerDown(from, { button: 0, pointerId: 1, ...client(x0, y0) })
  for (const [x, y] of rest) fireEvent.pointerMove(board(), { pointerId: 1, ...client(x, y) })
  const [lx, ly] = points[points.length - 1]
  if (finish) fireEvent.pointerUp(board(), { pointerId: 1, ...client(lx, ly) })
}

/** Draw the selected player's assignment by dragging his gold route handle. */
export function drawFromHandle(play: Play, id: string, points: [number, number][], opts?: { finish?: boolean }) {
  const p = play.players.find((pl) => pl.id === id)!
  const handle = routeHandle(id)
  if (!handle) throw new Error(`no route handle for ${id} - is he selected, and is the board resting?`)
  stroke(handle, [[p.x, p.y], ...points], opts)
}
