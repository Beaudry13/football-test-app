import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { positionName } from './positionNames'
import { SCRATCH_NAME } from './scratch'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { chooseView } from '../testing/viewMenu'
import { U, Y_MAX } from '../engine/field'
import { newPlay, type Play } from '../engine/play'
import { Preview3D } from '../Preview3D'

/**
 * MOTION LAB'S FIRST 30 SECONDS.
 *
 * Somebody who has never seen Motion Lab - or football - must be able to
 * answer, from the screen alone: how do I start (pick a player), how do I
 * make him move (draw his movement), how do I watch it (Play), how do I keep
 * it (Save), how do I start over (+ New play), how do I get out (Home), and
 * where is 3D (Preview 3D). These tests pin the screen that answers them.
 */

installPointerStubs()

const LEARNED_KEY = 'peira.motionLab.learned.v1'
const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

function open(play: Play, props: Partial<Parameters<typeof MotionLabEditor>[0]> = {}) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} {...props} />)
}
function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
/** A click on empty grass, well behind the offense. */
function clickGrass() {
  fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(5, -12) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(5, -12) })
}

const topBar = () => document.querySelector('.bar:not(.context):not(.bottom)') as HTMLElement
const strip = () => document.querySelector('.bar.context') as HTMLElement
const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const card = () => screen.queryByRole('region', { name: 'Create your play' })
const playBtn = () => dock().querySelector('.play-toggle') as HTMLButtonElement
const byLabel = (play: Play, label: string) => play.players.find((p) => p.label === label)!

let empty: Play
beforeEach(() => {
  localStorage.clear()
  empty = newPlay(SCRATCH_NAME)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the top bar reads as the questions a newcomer asks', () => {
  it('where am I, how do I get out, start another, what am I working on - then what can I do with it', () => {
    open(empty, {
      exit: (
        <>
          <button>Home</button>
          <button>Library</button>
        </>
      ),
      isUnsaved: () => true,
      onSaveUnsaved: () => {},
      actions: <button>Preview 3D</button>,
    })
    const order = [...topBar().querySelectorAll('.brand, button')].map((el) => el.textContent!.trim())
    expect(order).toEqual(['Peira Motion Lab', 'Home', 'Library', '+ New play', `${SCRATCH_NAME}▾`, 'Save', '↶', '↷', 'Preview 3D', 'Present'])
    // Home and Library sit together, apart from the play.
    expect(within(topBar().querySelector('.ml-nav') as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home', 'Library'])
    // Unsaved, said once, with its one action beside it - and leaving is safe.
    const state = topBar().querySelector('.play-state') as HTMLElement
    expect(state.textContent).toBe(`${SCRATCH_NAME}▾UnsavedSave`)
    expect(within(state).getByText('Unsaved')).toHaveAttribute('title', "Kept on this device until you save it - leaving won't lose it")
    expect(within(state).getByRole('button', { name: 'Save' })).toHaveClass('gold-line')
  })

  it('a saved play reads "Name · Saved", with no Save and no Unsaved', () => {
    const saved = pane('Inside Zone Rt')
    open(saved, { saveStatus: <span className="saved">Saved</span> })
    const state = topBar().querySelector('.play-state') as HTMLElement
    expect(state.textContent).toBe(`${saved.name}▾Saved`)
    expect(within(topBar()).queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('the one gold outline up top is Save; Present is a peer of the play actions', () => {
    open(empty, { isUnsaved: () => true, onSaveUnsaved: () => {} })
    const gold = [...topBar().querySelectorAll('button.gold-line')].map((b) => b.textContent)
    expect(gold).toEqual(['Save'])
    expect(within(topBar()).getByRole('button', { name: 'Present' })).not.toHaveClass('gold-line')
  })
})

describe('CREATE YOUR PLAY: an empty field says what to do with it', () => {
  it('three steps on the field - pick, draw, Play - what the circles are, and one way to a formation', () => {
    open(empty)
    const c = within(card()!)
    expect(card()!.querySelectorAll('li')).toHaveLength(3)
    expect(card()!.textContent).toContain('Pick a player')
    expect(card()!.textContent).toContain('click any circle')
    expect(card()!.textContent).toContain('Draw where they should go')
    expect(card()!.textContent).toContain('Press ▶ Play')
    expect(card()!.textContent).toContain('Offense')
    expect(card()!.textContent).toContain('Defense')
    // Not a modal: nothing is blocked, the field and the bars all still work.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(c.getByRole('button', { name: 'Choose a formation' }))
    expect(strip().querySelector('.formation-pop')).not.toBeNull()
  })

  it('is gone the moment a player is picked - and does not come back when he is let go', () => {
    open(empty)
    select(empty, byLabel(empty, 'X').id)
    expect(card()).toBeNull()
    clickGrass()
    expect(strip().querySelector('.chip')).toBeNull()
    expect(card()).toBeNull()
  })

  it('never shows on a play with something drawn, in another view, or in Present', () => {
    open(pane('Inside Zone Rt'))
    expect(card()).toBeNull()
    cleanup()
    open(empty)
    chooseView('Coach')
    expect(card()).toBeNull()
    chooseView('Overhead')
    expect(card()).not.toBeNull()
    fireEvent.click(within(topBar()).getByRole('button', { name: 'Present' }))
    expect(card()).toBeNull()
  })

  it('a device that has built and watched a play is not shown beginner steps again', () => {
    localStorage.setItem(LEARNED_KEY, '1')
    open(empty)
    expect(card()).toBeNull()
  })
})

describe('Play says it is the way to watch what you made', () => {
  it('with nothing drawn it says what it is waiting for', () => {
    open(empty)
    expect(playBtn()).toBeDisabled()
    expect(playBtn()).toHaveAttribute('title', 'Draw where a player goes, then Play shows it')
  })

  it('the first thing drawn on a new device makes it glow until it is pressed - and pressing it means this device has learned', async () => {
    open(empty)
    const x = byLabel(empty, 'X')
    select(empty, x.id)
    drawFromHandle(empty, x.id, [[x.x, x.y + 8], [x.x + 4, x.y + 12]])
    await settle()
    expect(playBtn()).toBeEnabled()
    expect(playBtn()).toHaveClass('nudge')
    expect(localStorage.getItem(LEARNED_KEY)).toBeNull()

    fireEvent.click(playBtn())
    expect(playBtn()).not.toHaveClass('nudge')
    expect(localStorage.getItem(LEARNED_KEY)).toBe('1')
  })

  it('does not glow on a device that already knows', async () => {
    localStorage.setItem(LEARNED_KEY, '1')
    open(empty)
    const x = byLabel(empty, 'X')
    select(empty, x.id)
    drawFromHandle(empty, x.id, [[x.x, x.y + 8]])
    await settle()
    expect(playBtn()).not.toHaveClass('nudge')
  })
})

describe('a picked player, in plain words', () => {
  it('his position spelled out, and "Draw movement" as the one gold thing to do', () => {
    open(empty)
    const fs = byLabel(empty, 'FS')
    select(empty, fs.id)
    expect(strip().querySelector('.chip')!.textContent).toBe('FSFree safety')
    expect(within(strip()).getByRole('button', { name: '✎ Draw movement' })).toHaveClass('primary')
  })

  it('once an offensive man has somewhere to go, "+ Add motion" is the next thing to try', async () => {
    open(empty)
    const x = byLabel(empty, 'X')
    select(empty, x.id)
    expect(within(strip()).queryByRole('button', { name: '+ Add motion' })).toBeNull()
    drawFromHandle(empty, x.id, [[x.x, x.y + 8]])
    await settle()
    const add = within(strip()).getByRole('button', { name: '+ Add motion' })
    expect(add).toHaveAttribute('title', 'Draw where he moves before the snap')
    fireEvent.click(add)
    // The same first motion stroke as More's "Add pre-snap motion…".
    expect(strip().querySelector('.banner')!.textContent).toContain('motion')
    expect(board().classList.contains('board-armed')).toBe(true)
  })

  it('is not offered to a defender', async () => {
    open(empty)
    const cb = byLabel(empty, 'CB')
    select(empty, cb.id)
    drawFromHandle(empty, cb.id, [[cb.x, cb.y - 6]])
    await settle()
    expect(within(strip()).queryByRole('button', { name: '+ Add motion' })).toBeNull()
  })
})

describe('the dock: watch, and how', () => {
  it('View sits beside Play and says what each view is', () => {
    open(empty)
    expect(topBar().querySelector('.view-btn')).toBeNull()
    fireEvent.click(within(dock()).getByRole('button', { name: /^View Overhead/ }))
    const menu = within(screen.getByRole('menu', { name: 'Watch from' }))
    expect(menu.getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual([
      'OverheadThe whole field from above. Build the play here.',
      'CoachFrom the sideline, the way a coach sees it.',
      "PlayerThrough one player's eyes.",
    ])
    expect(menu.getByRole('menuitemradio', { name: 'Overhead' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Set the ball waits its turn: plain on an empty field, gold-line once there is a play to give it to', async () => {
    open(empty)
    const ball = () => dock().querySelector('.ball-btn') as HTMLElement
    expect(ball()).not.toHaveClass('gold-line')
    const x = byLabel(empty, 'X')
    select(empty, x.id)
    drawFromHandle(empty, x.id, [[x.x, x.y + 8]])
    await settle()
    expect(ball()).toHaveClass('gold-line')
  })
})

describe('position names', () => {
  it('spell out the labels Motion Lab uses, and leave the coach’s own labels alone', () => {
    expect(positionName('FS')).toBe('Free safety')
    expect(positionName('X')).toBe('Receiver')
    expect(positionName('QB')).toBe('Quarterback')
    expect(positionName('cb2')).toBe('Cornerback')
    expect(positionName('Rover')).toBeNull()
    // Every label the default field and the quick formations put on the field has a name.
    for (const p of newPlay().players) expect(positionName(p.label), p.label).not.toBeNull()
  })
})

describe('Preview 3D', () => {
  it('with a viewer, opens it', () => {
    const onOpen = vi.fn()
    render(<Preview3D available onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview 3D' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('without one, never pretends: announced unavailable, it explains and opens nothing', () => {
    const onOpen = vi.fn()
    render(<Preview3D available={false} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: /^Preview 3D/ })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn.textContent).toBe('Preview 3DSoon')
    fireEvent.click(btn)
    expect(screen.getByRole('note').textContent).toContain('When it is, this button opens your saved play in 3D')
    fireEvent.keyDown(screen.getByRole('note'), { key: 'Escape' })
    expect(screen.queryByRole('note')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
