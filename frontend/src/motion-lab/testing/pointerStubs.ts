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
