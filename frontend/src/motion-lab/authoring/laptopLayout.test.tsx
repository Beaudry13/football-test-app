/// <reference types="node" />
// File-scoped Node types: the stylesheet is read from disk, as
// motionLabCss.test.ts does (vitest.config.ts sets `css: false`).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * SPEC §14, THE LAPTOP RULES (ML-UX-12).
 *
 * The media queries are pinned here; that they produce a screen with no
 * overflow at 1280 / 1366 / 1440 is the browser sweep's job, because jsdom
 * has no layout. ML-UX-12 added the last two: TIMING's label goes below
 * 1300, and Present at 1280 drops "Motion Lab" from the brand. Two §14 rules
 * are deliberately NOT here (owner decision): the Situation chip's icon-only
 * form below 1180 - under the supported minimum, and there is no icon - and
 * the stage's 10 / 12 px padding, which stays the prototype's 12.
 */

installPointerStubs()

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(resolve(here, '../motionLab.css'), 'utf-8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** The body of the rule for `selector` inside `@media (query)`, or null. */
function inMedia(query: string, selector: string): string | null {
  let from = 0
  for (;;) {
    const at = CSS.indexOf(`@media (${query})`, from)
    if (at === -1) return null
    const open = CSS.indexOf('{', at)
    let depth = 0
    let end = open
    for (; end < CSS.length; end++) {
      if (CSS[end] === '{') depth++
      else if (CSS[end] === '}' && --depth === 0) break
    }
    const block = CSS.slice(open + 1, end)
    const hit = block.indexOf(`${selector} {`)
    if (hit !== -1) return block.slice(block.indexOf('{', hit) + 1, block.indexOf('}', hit)).trim()
    from = end
  }
}

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(
    <div className="motion-lab-root">
      <MotionLabEditor repository={createLocalPlayRepository()} />
    </div>,
  )
}
function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
const play = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!
const strip = () => document.querySelector('.bar.context') as HTMLElement

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('the laptop rules (SPEC §14)', () => {
  it('VIEW and TIMING labels go on a narrow laptop; the controls they name stay', () => {
    expect(inMedia('max-width: 1300px', '.motion-lab-root .bar .lbl.view-label')).toBe('display: none;')
    // "Hidden below 1300": at 1300 itself the label is still there.
    expect(inMedia('max-width: 1299.98px', '.motion-lab-root .bar .lbl.timing-label')).toBe('display: none;')

    const p = play()
    open(p)
    select(p, p.players.find((x) => x.label === 'RB')!.id)
    const label = strip().querySelector('.lbl.timing-label')!
    expect(label.textContent).toBe('Timing')
    // Only the word goes: the segment is its own element, untouched by the rule.
    const seg = label.parentElement!.querySelector('.seg')!
    expect(seg.matches('.lbl, .timing-label')).toBe(false)
    // P3.4: Timing is when his ROUTE starts; pre-snap movement is its own phase.
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['On snap', 'Delayed'])
  })

  it('Present at 1280 drops "Motion Lab" from the brand, and only that', () => {
    expect(inMedia('max-width: 1280px', '.motion-lab-root .app.present .brand span')).toBe('display: none;')
    open(play())
    const brand = document.querySelector('.brand')!
    expect(brand.querySelector('span')!.textContent).toBe('Motion Lab')
    // Outside Present the rule cannot match: it is scoped to .app.present.
    expect(brand.closest('.app')!.classList.contains('present')).toBe(false)
    fireEvent.click(within(document.querySelector('.bar') as HTMLElement).getByRole('button', { name: 'Present' }))
    expect(brand.closest('.app')!.classList.contains('present')).toBe(true)
  })

  it('the widths §14 gives the dock and the top bar are still the ones in the sheet', () => {
    expect(inMedia('max-width: 1300px', '.motion-lab-root .bar.bottom .ball-btn')).toBe('max-width: 160px;')
    expect(CSS).toMatch(/\.motion-lab-root \.bar\.bottom \.ball-btn \{\s*max-width: 240px;/)
    expect(CSS).toMatch(/\.motion-lab-root \.bar\.bottom \.sit-chip \{[^}]*max-width: 180px;/)
    expect(CSS).toMatch(/\.motion-lab-root \.bar \.play-name \{[^}]*max-width: 200px;/)
    expect(CSS).toMatch(/\.motion-lab-root \.bar\.bottom \.scrub \{[^}]*min-width: 160px;/)
  })
})
