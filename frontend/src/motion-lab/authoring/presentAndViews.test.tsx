import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * VIEWS AND PRESENT CHROME (ML-UX-8, SPEC §2, §3.3, §10, §11, §13, §16).
 *
 * Coach and Player views say where the coach is watching from; Player view
 * with nobody chosen asks, in the shared banner. Present is teaching, not
 * authoring: no strip at all, a top bar that names the play and offers only
 * views, telestration and the way out, and a dock with everything but the
 * ball. Its guards - no edits, no authoring keys, strokes never kept - are the
 * slice's own regression list, and most were never tested before.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k, ...init }))
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))

/** "Inside Zone Rt": routes, two blocks and a handoff - a real play to teach. */
const fixture = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  // PEIRA's way out, exactly as the editor page passes it.
  render(<MotionLabEditor repository={createLocalPlayRepository()} exit={<button>← Library</button>} />)
}

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
const mark = (kind: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) =>
  fireEvent[kind](board(), { button: 0, pointerId: 1, ...client(x, y) })

const app = () => document.querySelector('.app') as HTMLElement
const topBar = () => document.querySelector('.app > .bar:not(.context):not(.bottom)') as HTMLElement
const strip = () => document.querySelector('.bar.context') as HTMLElement | null
const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const btn = (name: string | RegExp) => screen.getByRole('button', { name })
const maybeBtn = (name: string | RegExp) => screen.queryByRole('button', { name })
const viewBtn = (name: 'Overhead' | 'Coach' | 'Player') => within(topBar()).getByRole('button', { name })
const overhead = () => document.querySelector('svg.board:not(.field-view)')
const fieldView = () => document.querySelector('svg.field-view')
const presenting = () => app().classList.contains('present')
const strokes = () => board().querySelectorAll('polyline[stroke="#fff27a"]')
const ringOn = (id: string) => playerMarker(id).querySelector('circle[fill="none"][stroke-width="3"]')
const ballMenu = () => document.querySelector('.ball-pop')
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const scrubAt = () => Number((document.querySelector('.scrub input[type=range]') as HTMLInputElement).value)
const playToggle = () => dock().querySelector('.play-toggle') as HTMLButtonElement

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = fixture()
})
afterEach(cleanup)

describe('Coach view', () => {
  it('says where he is watching from, in exactly the SPEC\'s words, and offers no authoring', () => {
    open(play)
    fireEvent.click(viewBtn('Coach'))

    expect(fieldView()).not.toBeNull()
    expect(strip()!.textContent).toBe('Watching from the sideline. Switch to Overhead to edit.')
    expect(within(strip()!).queryAllByRole('button')).toHaveLength(0)
  })

  it('keeps the dock, and the ball menu works - by click and by B', () => {
    open(play)
    fireEvent.click(viewBtn('Coach'))
    expect(dock().querySelector('.ball-btn')).not.toBeNull()
    expect(playToggle()).not.toBeNull()

    fireEvent.click(dock().querySelector('.ball-btn')!)
    expect(ballMenu()).not.toBeNull()
    key('Escape')
    expect(ballMenu()).toBeNull()

    key('b')
    expect(ballMenu()).not.toBeNull()
    key('b')
    expect(ballMenu()).toBeNull()
  })

  it('a pick reached through B still takes him back to Overhead (§6.8)', () => {
    open({ ...play, ball: null, ballThen: null })
    fireEvent.click(viewBtn('Coach'))
    key('b')
    fireEvent.click(within(ballMenu() as HTMLElement).getByRole('button', { name: 'Handoff to…' }))

    expect(overhead()).not.toBeNull()
    expect(strip()!.querySelector('.banner')!.textContent).toContain('Choose who gets the ball')
  })
})

describe('Player view, nobody chosen yet', () => {
  it('keeps the overhead and asks, in the shared banner', () => {
    open(play)
    fireEvent.click(viewBtn('Player'))

    expect(overhead()).not.toBeNull()
    expect(fieldView()).toBeNull()
    const banner = strip()!.querySelector('.banner')!
    expect(banner.querySelector('.banner-icon')!.textContent).toBe('👁')
    expect(banner.querySelector('b')!.textContent).toBe('Click the player to watch from.')
    expect(within(strip()!).getByRole('button', { name: /^Cancel/ })).toHaveAttribute('title', 'Cancel · Esc')
  })

  it('Cancel goes back to Overhead', () => {
    open(play)
    fireEvent.click(viewBtn('Player'))
    fireEvent.click(within(strip()!).getByRole('button', { name: /^Cancel/ }))

    expect(viewBtn('Overhead')).toHaveClass('active')
    expect(strip()!.querySelector('.banner')).toBeNull()
  })

  it('so does Escape', () => {
    open(play)
    fireEvent.click(viewBtn('Player'))
    key('Escape')

    expect(viewBtn('Overhead')).toHaveClass('active')
    expect(strip()!.querySelector('.banner')).toBeNull()
  })

  it('clicking a man watches from him', () => {
    open(play)
    fireEvent.click(viewBtn('Player'))
    const fs = play.players.find((p) => p.label === 'FS')!
    select(play, fs.id)

    expect(fieldView()).not.toBeNull()
    expect(strip()!.querySelector('.chip')!.textContent).toBe('FS')
  })
})

describe('Player view, watching from a man', () => {
  function watchFrom(label: string) {
    open(play)
    fireEvent.click(viewBtn('Player'))
    select(play, play.players.find((p) => p.label === label)!.id)
  }

  it('reads [FS] [Change ▾] "Camera rides with the FS."', () => {
    watchFrom('FS')
    expect(strip()!.querySelector('.chip')!.textContent).toBe('FS')
    expect(within(strip()!).getByRole('button', { name: 'Change ▾' })).toBeInTheDocument()
    expect(strip()!.querySelector('.hint')!.textContent).toBe('Camera rides with the FS.')
  })

  it('Change lists both sides, and picking another man rides with him', () => {
    watchFrom('FS')
    fireEvent.click(within(strip()!).getByRole('button', { name: 'Change ▾' }))
    const pop = document.querySelector('.viewer-pop') as HTMLElement
    expect(pop.querySelectorAll('.viewer-row')).toHaveLength(2)
    expect(within(pop).getAllByRole('button')).toHaveLength(play.players.length)

    fireEvent.click(within(pop).getAllByRole('button', { name: 'RB' })[0])
    expect(strip()!.querySelector('.chip')!.textContent).toBe('RB')
    expect(strip()!.querySelector('.hint')!.textContent).toBe('Camera rides with the RB.')
  })

  it('B opens the ball menu here too', () => {
    watchFrom('FS')
    key('b')
    expect(ballMenu()).not.toBeNull()
  })
})

describe('the top bar', () => {
  it('while authoring: the VIEW label, and Present outlined rather than solid', () => {
    open(play)
    expect(topBar().querySelector('.lbl.view-label')!.textContent).toBe('View')
    expect(btn('Present')).toHaveClass('gold-line')
    expect(btn('Present')).not.toHaveClass('primary')
    expect(btn('Present')).toHaveAttribute('title', 'Hide the tools and teach')
    // Play is the one solid-gold control.
    expect(playToggle()).toHaveClass('primary')
  })

  it('in Present: the name as text, VIEW, ✎ Draw, Clear marks, an outlined Exit Present - and nothing else', () => {
    open(play)
    fireEvent.click(btn('Present'))

    expect(maybeBtn('← Library')).toBeNull()
    expect(topBar().querySelector('.present-name')!.textContent).toBe(play.name)
    expect(topBar().querySelector('.play-btn')).toBeNull()
    expect(topBar().querySelector('.lbl.view-label')).not.toBeNull()
    expect(btn('✎ Draw')).toBeInTheDocument()
    expect(btn('Exit Present')).toHaveClass('gold-line')
    expect(btn('Exit Present')).not.toHaveClass('primary')
    // Nothing about the file or its history.
    expect(topBar().querySelector('.saved')).toBeNull()
    expect(maybeBtn('↶')).toBeNull()
    expect(maybeBtn('↷')).toBeNull()
  })

  it('Clear marks is never disabled, even with nothing to clear', () => {
    open(play)
    fireEvent.click(btn('Present'))
    expect(strokes()).toHaveLength(0)
    expect(btn('Clear marks')).toBeEnabled()
    fireEvent.click(btn('Clear marks'))
    expect(strokes()).toHaveLength(0)
    expect(presenting()).toBe(true)
  })
})

describe('Present has no strip', () => {
  it('none at all: three rows, not four', () => {
    open(play)
    expect(app().children).toHaveLength(4)
    fireEvent.click(btn('Present'))

    expect(strip()).toBeNull()
    expect(app().children).toHaveLength(3)
  })

  it('a highlighted man is a ring on the field, and brings no strip back', () => {
    open(play)
    fireEvent.click(btn('Present'))
    const rb = play.players.find((p) => p.label === 'RB')!
    select(play, rb.id)

    expect(ringOn(rb.id)).not.toBeNull()
    expect(strip()).toBeNull()
  })
})

describe("Present's dock", () => {
  it('everything but the ball, and the ball\'s divider goes with it', () => {
    open(play)
    fireEvent.click(btn('Present'))

    expect(dock().querySelector('.ball-btn')).toBeNull()
    expect(dock().children[0].classList.contains('dock-divider')).toBe(false)
    expect(dock().querySelectorAll('.dock-divider')).toHaveLength(1)
    for (const label of ['Restart', 'Back 0.1 seconds', 'Forward 0.1 seconds']) expect(within(dock()).getByRole('button', { name: label })).toBeInTheDocument()
    expect(playToggle()).not.toBeNull()
    expect(dock().querySelector('.scrub input[type=range]')).not.toBeNull()
    expect(dock().querySelector('.time')).not.toBeNull()
    expect(dock().querySelector('.rate-pill')).not.toBeNull()
    expect(dock().querySelector('.sit-chip')).not.toBeNull()
  })

  it('Display still opens', () => {
    open(play)
    fireEvent.click(btn('Present'))
    fireEvent.click(within(dock()).getByRole('button', { name: /^Display/ }))
    expect(dock().querySelector('.display-pop')).not.toBeNull()
  })
})

describe('Present guards: no edits, no authoring keys (§3.3, §10, §16)', () => {
  const rg = () => play.players.find((p) => p.label === 'RG')!

  it('D, E and Delete do nothing to the man he has highlighted', async () => {
    open(play)
    fireEvent.click(btn('Present'))
    select(play, rg().id)
    const path = JSON.stringify(rg().path)

    // The board stays exactly in its Present state. (This used to be a
    // `not.toContain('board-draw-armed')`, which would have passed for ever
    // once ML-UX-9 renamed that class - so it asserts what IS true instead.)
    key('d')
    expect(board().getAttribute('class')).toBe('board board-present')
    key('e')
    expect(board().getAttribute('class')).toBe('board board-present')
    key('Delete')
    key('Backspace')
    await settle()

    expect(JSON.stringify(stored(play).players.find((p) => p.id === rg().id)!.path)).toBe(path)
  })

  it('B does not open the ball menu', () => {
    open(play)
    fireEvent.click(btn('Present'))
    key('b')
    // The menu has nowhere to show in Present - so check it did not open
    // underneath, waiting for Exit.
    fireEvent.click(btn('Exit Present'))
    expect(ballMenu()).toBeNull()
  })

  it('undo and redo are off in Present, and back on after it', async () => {
    open(play)
    const rb = play.players.find((p) => p.label === 'RB')!
    select(play, rb.id)
    fireEvent.click(within(strip()!).getByRole('button', { name: 'Pre-Snap' }))
    await settle()
    expect(stored(play).players.find((p) => p.id === rb.id)!.timing).toBe('pre-snap')

    fireEvent.click(btn('Present'))
    key('z', { ctrlKey: true })
    key('z', { ctrlKey: true, shiftKey: true })
    key('y', { ctrlKey: true })
    await settle()
    expect(stored(play).players.find((p) => p.id === rb.id)!.timing).toBe('pre-snap')

    fireEvent.click(btn('Exit Present'))
    key('z', { ctrlKey: true })
    await settle()
    expect(stored(play).players.find((p) => p.id === rb.id)!.timing).toBe('on-snap')
  })

  it('Space, the arrows and R still drive the clock', () => {
    open(play)
    fireEvent.click(btn('Present'))

    key('ArrowRight')
    expect(scrubAt()).toBeCloseTo(0.1, 5)
    key('ArrowRight')
    key('ArrowLeft')
    expect(scrubAt()).toBeCloseTo(0.1, 5)
    key('r')
    expect(scrubAt()).toBe(0)

    key(' ')
    expect(playToggle().textContent).toContain('Pause')
    key(' ')
    expect(playToggle().textContent).toContain('Play')
  })

  it('Escape never leaves Present - Exit is explicit', () => {
    open(play)
    fireEvent.click(btn('Present'))
    key('Escape')
    key('Escape')
    expect(presenting()).toBe(true)
  })

  it('dragging a man moves nobody', async () => {
    open(play)
    fireEvent.click(btn('Present'))
    const r = rg()
    fireEvent.pointerDown(playerMarker(r.id), { button: 0, pointerId: 1, ...client(r.x, r.y) })
    fireEvent.pointerMove(board(), { pointerId: 1, ...client(r.x + 5, r.y + 3) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(r.x + 5, r.y + 3) })
    await settle()

    const after = stored(play).players.find((p) => p.id === r.id)!
    expect([after.x, after.y]).toEqual([r.x, r.y])
  })
})

describe('choosing whom to watch while presenting (owner decision)', () => {
  it('Player view with nobody chosen: a click chooses him - no banner, no strip', () => {
    open(play)
    fireEvent.click(btn('Present'))
    fireEvent.click(viewBtn('Player'))
    expect(fieldView()).toBeNull()
    expect(strip()).toBeNull()

    const fs = play.players.find((p) => p.label === 'FS')!
    select(play, fs.id)

    expect(fieldView()).not.toBeNull()
    expect(strip()).toBeNull()
    expect(document.querySelector('.banner')).toBeNull()
    expect(presenting()).toBe(true)
  })

  it('in Overhead a click still only highlights - it does not choose a viewer', () => {
    open(play)
    fireEvent.click(btn('Present'))
    const fs = play.players.find((p) => p.label === 'FS')!
    select(play, fs.id)

    expect(ringOn(fs.id)).not.toBeNull()
    expect(viewBtn('Overhead')).toHaveClass('active')
    expect(fieldView()).toBeNull()
  })
})

describe('telestration', () => {
  it('✎ Draw lights up and says how to stop; pressing on the field pauses and marks it', () => {
    open(play)
    fireEvent.click(btn('Present'))
    key(' ')
    expect(playToggle().textContent).toContain('Pause')

    fireEvent.click(btn('✎ Draw'))
    expect(btn('✎ Draw')).toHaveClass('active')
    expect(btn('✎ Draw').getAttribute('title')).toContain('Esc to stop')

    mark('pointerDown', 20, 2)
    expect(playToggle().textContent).toContain('Play')
    mark('pointerMove', 24, 5)
    mark('pointerMove', 30, 7)
    mark('pointerUp', 30, 7)
    expect(strokes()).toHaveLength(1)
  })

  it('no row appears while he draws - the field cannot move under the pen', () => {
    open(play)
    fireEvent.click(btn('Present'))
    const rows = app().children.length
    fireEvent.click(btn('✎ Draw'))

    expect(app().children).toHaveLength(rows)
    expect(strip()).toBeNull()
    expect(document.querySelector('.banner')).toBeNull()
  })

  it('Escape stops drawing and stays in Present', () => {
    open(play)
    fireEvent.click(btn('Present'))
    fireEvent.click(btn('✎ Draw'))
    key('Escape')
    expect(btn('✎ Draw')).not.toHaveClass('active')
    expect(presenting()).toBe(true)
  })

  it('Clear marks takes them away', () => {
    open(play)
    fireEvent.click(btn('Present'))
    fireEvent.click(btn('✎ Draw'))
    mark('pointerDown', 20, 2)
    mark('pointerMove', 26, 6)
    mark('pointerUp', 26, 6)
    expect(strokes()).toHaveLength(1)

    fireEvent.click(btn('Clear marks'))
    expect(strokes()).toHaveLength(0)
  })

  it('Exit throws the marks away, and they are never saved', async () => {
    open(play)
    const before = JSON.stringify(stored(play))
    fireEvent.click(btn('Present'))
    fireEvent.click(btn('✎ Draw'))
    mark('pointerDown', 20, 2)
    mark('pointerMove', 26, 6)
    mark('pointerUp', 26, 6)
    await settle()
    expect(JSON.stringify(stored(play))).toBe(before)

    fireEvent.click(btn('Exit Present'))
    fireEvent.click(btn('Present'))
    expect(strokes()).toHaveLength(0)
  })
})

describe('Exit Present', () => {
  it('gives everything back: the strip, the Library, the file controls, the ball', () => {
    open(play)
    fireEvent.click(btn('Present'))
    fireEvent.click(btn('Exit Present'))

    expect(presenting()).toBe(false)
    expect(strip()).not.toBeNull()
    expect(app().children).toHaveLength(4)
    expect(btn('← Library')).toBeInTheDocument()
    expect(topBar().querySelector('.saved')).not.toBeNull()
    expect(btn('↶')).toBeInTheDocument()
    expect(dock().querySelector('.ball-btn')).not.toBeNull()
    expect(dock().querySelectorAll('.dock-divider')).toHaveLength(2)
    expect(btn('Present')).toHaveClass('gold-line')
  })

  it('and switching views works going in and coming out', () => {
    open(play)
    fireEvent.click(viewBtn('Coach'))
    fireEvent.click(btn('Present'))
    expect(fieldView()).not.toBeNull()
    fireEvent.click(viewBtn('Overhead'))
    expect(overhead()).not.toBeNull()
    fireEvent.click(viewBtn('Coach'))
    fireEvent.click(btn('Exit Present'))

    expect(fieldView()).not.toBeNull()
    expect(strip()!.textContent).toBe('Watching from the sideline. Switch to Overhead to edit.')
  })
})
