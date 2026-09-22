import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * THE SELECTED-PLAYER STRIP (ML-UX-4, SPEC §4).
 *
 * Seven controls in a fixed order: who, draw, adjust, when, who he meets,
 * everything else, and what he ends up doing. The strip used to carry nine
 * groups - chip menu, timing, speed, end, an Assignment menu, throw point,
 * engage - and a coach had to read it to find the one he wanted.
 *
 * What each control DOES is older than this slice and is tested where it was
 * built; these tests are about the hierarchy, and about the things that moved.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

const strip = () => document.querySelector('.bar.context') as HTMLElement
const chip = () => strip().querySelector('.chip') as HTMLElement
const summary = () => strip().querySelector('.strip-summary') as HTMLElement | null
const banner = () => strip().querySelector('.banner')
const stripBtn = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const maybeBtn = (name: string | RegExp) => within(strip()).queryByRole('button', { name })
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

/** A man who already has a route, and one who does not. Both unengaged, so
 *  the strip shows `Blocks…` rather than today's engaged group (ML-UX-5). */
const engagedIds = (play: Play) => new Set(play.engagements.flatMap((e) => [e.a, e.b]))
const withPath = (play: Play) =>
  play.players.find((p) => p.side === 'offense' && p.path.length > 1 && !engagedIds(play).has(p.id))!
const noPath = (play: Play) =>
  play.players.find((p) => p.side === 'offense' && p.path.length < 2 && p.label !== 'QB' && !engagedIds(play).has(p.id))!
const freeDefender = (play: Play) => play.players.find((p) => p.side === 'defense' && !engagedIds(play).has(p.id))!

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

describe('the order never changes', () => {
  it('reads: who, draw, adjust, when, who he meets, more, summary', () => {
    open(play)
    const man = withPath(play)
    select(play, man.id)

    const order = [...strip().children].map((c) => c.className)
    // The chip is first and the summary is last, whatever sits between.
    expect(order[0]).toContain('chip')
    expect(order[order.length - 1]).toContain('strip-summary')

    const text = strip().textContent!
    const at = (s: string) => text.indexOf(s)
    expect(at(man.label)).toBeLessThan(at('Redraw'))
    expect(at('Redraw')).toBeLessThan(at('Adjust'))
    expect(at('Adjust')).toBeLessThan(at('Timing'))
    expect(at('Timing')).toBeLessThan(at('Blocks'))
    expect(at('Blocks')).toBeLessThan(at('More'))
  })

  it('nothing else is added to it', () => {
    open(play)
    select(play, withPath(play).id)
    const names = within(strip())
      .getAllByRole('button')
      .map((b) => b.textContent!.trim())
    // Redraw, Adjust, three Timing segments, Blocks…, More. Speed, End,
    // Copy, Mirror, Clear, Rename, Delete and Throw point are all under More.
    for (const gone of ['Speed', 'Copy to…', 'Mirror to…', 'Clear assignment', 'Rename…', 'Delete player', 'Assignment']) {
      expect(names).not.toContain(gone)
    }
  })
})

describe('the identity chip', () => {
  it('is not a button any more', () => {
    open(play)
    select(play, withPath(play).id)

    expect(chip().tagName).toBe('SPAN')
    expect(within(strip()).queryByRole('button', { name: /^[A-Z]{1,4} ?▾?$/ })).toBeNull()
  })

  it('says which side he is on', () => {
    open(play)
    select(play, withPath(play).id)
    expect(chip().textContent).toContain('Offense')

    cleanup()
    open(play)
    const d = freeDefender(play)
    select(play, d.id)
    expect(chip().textContent).toContain('Defense')
  })
})

describe('the primary', () => {
  it('invites a first assignment in gold, and becomes a plain Redraw after', async () => {
    open(play)
    const man = noPath(play)
    select(play, man.id)

    const first = stripBtn(/Draw assignment/)
    expect(first).toHaveClass('primary')

    drawFromHandle(play, man.id, [[man.x + 2, man.y + 6]])
    await settle()

    const again = stripBtn('Redraw')
    expect(again).not.toHaveClass('primary')
  })

  it('arms the same drawing ML-UX-1 built', () => {
    open(play)
    select(play, noPath(play).id)

    fireEvent.click(stripBtn(/Draw assignment/))

    expect(board().classList.contains('board-armed')).toBe(true)
  })

  it('has left the top bar', () => {
    open(play)
    select(play, noPath(play).id)
    const top = document.querySelector('.bar:not(.context):not(.bottom)') as HTMLElement
    expect(within(top).queryByRole('button', { name: /Draw assignment|Redraw/ })).toBeNull()
  })
})

describe('Adjust', () => {
  it('is offered only to a man who has something to adjust', () => {
    open(play)
    select(play, noPath(play).id)
    expect(maybeBtn('Adjust')).toBeNull()

    cleanup()
    open(play)
    select(play, withPath(play).id)
    expect(stripBtn('Adjust')).toBeInTheDocument()
  })

  it('says so itself while it is on - and the strip stays put', () => {
    open(play)
    select(play, withPath(play).id)

    fireEvent.click(stripBtn('Adjust'))

    expect(stripBtn('Adjust')).toHaveClass('gold-line')
    expect(board().classList.contains('board-adjusting')).toBe(true)
    // ML-UX-2 borrowed the waiting row for this; it does not any more.
    expect(banner()).toBeNull()
    expect(chip()).toBeInTheDocument()
    expect(stripBtn(/^More/)).toBeInTheDocument()

    fireEvent.click(stripBtn('Adjust'))
    expect(board().classList.contains('board-idle')).toBe(true)
  })

  it('E still does the same thing', () => {
    open(play)
    select(play, withPath(play).id)

    key('e')

    expect(stripBtn('Adjust')).toHaveClass('gold-line')
    expect(banner()).toBeNull()
  })
})

describe('Timing', () => {
  it('is always there, path or no path, and shows the delay when delayed', async () => {
    open(play)
    const man = noPath(play)
    select(play, man.id)
    expect(strip().textContent).toContain('Timing')

    fireEvent.click(stripBtn('Delayed'))
    await settle()

    expect(strip().querySelector('.delay input')).not.toBeNull()
    expect(stored(play).players.find((p) => p.id === man.id)!.timing).toBe('delayed')
  })

  it('changing it does not touch the route', async () => {
    open(play)
    const man = withPath(play)
    select(play, man.id)
    await settle()
    const before = stored(play).players.find((p) => p.id === man.id)!.path

    fireEvent.click(stripBtn('Pre-snap'))
    await settle()

    expect(stored(play).players.find((p) => p.id === man.id)!.path).toEqual(before)
  })
})

describe('who he meets', () => {
  it('a blocker blocks and a defender engages', () => {
    open(play)
    select(play, withPath(play).id)
    expect(stripBtn('Blocks…')).toBeInTheDocument()

    cleanup()
    open(play)
    select(play, freeDefender(play).id)
    expect(stripBtn('Engages…')).toBeInTheDocument()
  })
})

describe('the summary slot', () => {
  it('is the last thing in the strip, and says so when there is nothing to say', () => {
    open(play)
    select(play, noPath(play).id)

    expect(summary()).not.toBeNull()
    expect(summary()!.textContent).toBe('No assignment yet.')
  })

  it('says what he does once he has an assignment (ML-UX-7), and holds all of it in its tooltip', () => {
    open(play)
    const man = withPath(play)
    select(play, man.id)

    // What it says is pinned in playerSummary.test.ts and the A–E fixture
    // suite; here, only that the slot is filled with a summary of HIM.
    const text = summary()!.textContent!
    expect(text).toMatch(/^(Route|Drop|Path) · \d+ yds (up|back|across)/)
    expect(text).not.toBe('No assignment yet.')
    expect(summary()).toHaveAttribute('title', text)
  })
})

describe('what makes the strip go away', () => {
  it('removing the selected man returns it to resting', async () => {
    open(play)
    const man = withPath(play)
    select(play, man.id)

    fireEvent.click(stripBtn(/^More/))
    fireEvent.click(screen.getByRole('button', { name: 'Delete player' }))
    await settle()

    expect(within(strip()).getByRole('button', { name: /^Formation/ })).toBeInTheDocument()
    expect(strip().querySelector('.chip-static')).toBeNull()
  })

  it('a drawing still outranks it', () => {
    open(play)
    const man = noPath(play)
    select(play, man.id)

    key('d')

    expect(banner()).not.toBeNull()
    expect(strip().querySelector('.chip-static')).toBeNull()
    expect(maybeBtn(/^More/)).toBeNull()

    key('Escape')
    expect(banner()).toBeNull()
    expect(stripBtn(/^More/)).toBeInTheDocument()
  })

  it('a ball pick still outranks it', () => {
    open(play)
    select(play, withPath(play).id)
    const dock = document.querySelector('.bar.bottom') as HTMLElement
    fireEvent.click(dock.querySelector('.ball-btn') as HTMLButtonElement)
    fireEvent.click(within(dock).getByRole('button', { name: 'Pass to…' }))

    expect(banner()).not.toBeNull()
    expect(maybeBtn(/^More/)).toBeNull()
  })
})

describe('resting', () => {
  it('is one button and one sentence', () => {
    open(play)

    expect(within(strip()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Formation ▾'])
    // ML-UX-6 moved the situation to the dock; ML-UX-4 had left it here.
    expect(strip().querySelector('.sit-chip')).toBeNull()
    expect(strip().textContent).toContain('Drag a player to move him. Click a player to give him a job.')
    // Clear All Paths used to sit here permanently.
    expect(maybeBtn(/Clear All Paths/)).toBeNull()
  })
})
