import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, LOOKS_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Play } from '../engine/play'

/**
 * THE COACH'S PRE-SNAP STANCE, IN THE EDITOR (V6).
 *
 * A coach picks how a man stands before the snap; the play keeps exactly
 * that, for that man only, through deselecting, reloading, undo, a duplicate
 * and a saved formation - and "Use position default" takes it away again
 * rather than writing the default in. Choosing a stance moves nothing and
 * changes no assignment: it is one field on one man.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}
/** Reopen what is stored now, as a coach coming back to the play would. */
function reopen(play: Play) {
  cleanup()
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}
const strip = () => document.querySelector('.bar.context') as HTMLElement
const morePop = () => strip().querySelector('.more-pop') as HTMLElement
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const manIn = (play: Play, id: string) => stored(play).players.find((p) => p.id === id)!

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
function more() {
  fireEvent.click(within(strip()).getByRole('button', { name: /^More/ }))
}
/** Esc closes the menu, a second Esc lets go of the man. */
function deselect() {
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }))
}
const stanceToggle = () => within(morePop()).getByRole('button', { name: /^Stance/ })
/** What the closed Stance row says he will stand in. */
const stanceValue = () => stanceToggle().querySelector('.stance-value')!.textContent
const stanceNote = () => [...morePop().querySelectorAll('.stance-note')].map((n) => n.textContent)
const choices = () => within(within(morePop()).getByRole('radiogroup', { name: 'Stance' })).getAllByRole('radio').map((r) => r.textContent!.replace(/^[●○]/, ''))
/** Select him, open More, open Stance and pick. */
async function choose(play: Play, id: string, name: string | RegExp) {
  select(play, id)
  more()
  fireEvent.click(stanceToggle())
  fireEvent.click(within(morePop()).getByRole('radio', { name }))
  await settle()
}
const undo = () => act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
const redo = () => act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }))

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

const LT = 'O0'
const LG = 'O1'
const C = 'O2'
const QB = 'O6'
const X = 'O8'
const CB = 'D7'
const FS = 'D9'

describe('choosing a stance', () => {
  it('a man with none shows his position default, and saying so stores nothing', async () => {
    open(play)
    select(play, LT)
    more()
    expect(stanceValue()).toBe('Position default')
    // He is left of the ball, so his outside hand is his left.
    expect(stanceNote()).toEqual(['3 Point — Left Hand Down'])
    await settle()
    expect('presnapStance' in manIn(play, LT)).toBe(false)
  })

  it('is stored on that man as the canonical id, and still shows after deselecting and reselecting', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    expect(manIn(play, LT).presnapStance).toBe('OL_2_POINT')
    deselect()
    select(play, LT)
    more()
    expect(stanceValue()).toBe('2 Point')
  })

  it('changes that man only', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    deselect()
    await choose(play, LG, /Right Hand Down/)
    deselect()
    select(play, LT)
    more()
    expect(stanceValue()).toBe('2 Point')
    deselect()
    select(play, LG)
    more()
    expect(stanceValue()).toBe('3 Point — Right Hand Down')
    const withStance = stored(play).players.filter((p) => 'presnapStance' in p).map((p) => [p.id, p.presnapStance])
    expect(withStance).toEqual([[LT, 'OL_2_POINT'], [LG, 'OL_3_POINT_RIGHT']])
  })

  it('moves nothing and changes no assignment - the stance is the only difference', async () => {
    // Compared against the play as its FIRST edit saved it: the first save of
    // a play written before P3.1 also records who snaps and who throws
    // (roles.ts, withRoles) - existing behaviour, not this one's.
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    deselect()
    const before = JSON.parse(JSON.stringify(stored(play)))
    await choose(play, 'O3', /^○?4 Point$/)
    const after = JSON.parse(JSON.stringify(stored(play)))
    const rg = after.players.find((p: Player) => p.id === 'O3')
    expect(rg.presnapStance).toBe('OL_4_POINT')
    delete rg.presnapStance
    expect({ ...after, updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 })
  })
})

describe('what each position is offered', () => {
  it('the center gets his own stance first; another lineman may still choose it, last', () => {
    open(play)
    select(play, C)
    more()
    fireEvent.click(stanceToggle())
    expect(choices()).toEqual(['Use position default (Center)', 'Center', '2 Point', '3 Point — Left Hand Down', '3 Point — Right Hand Down', '4 Point'])
    deselect()
    select(play, LG)
    more()
    fireEvent.click(stanceToggle())
    expect(choices()).toEqual(['Use position default (3 Point — Left Hand Down)', '2 Point', '3 Point — Left Hand Down', '3 Point — Right Hand Down', '4 Point', 'Center'])
  })

  it.each([
    [QB, ['Use position default (Under Center)', 'Under Center', 'Pistol', 'Shotgun']],
    [X, ['Use position default (Staggered)', 'Standard', 'Staggered']],
    [CB, ['Use position default (Off)', 'Press', 'Off', 'Safety']],
    [FS, ['Use position default (Safety)', 'Press', 'Off', 'Safety']],
  ])('%s is offered his family only', (id, expected) => {
    open(play)
    select(play, id)
    more()
    fireEvent.click(stanceToggle())
    expect(choices()).toEqual(expected)
  })

  it('a label that does not say (N: nose or nickel?) offers his whole side, grouped, rather than a guess', async () => {
    const renamed = { ...play, players: play.players.map((p) => (p.id === 'D2' ? { ...p, label: 'N' } : p)) }
    open(renamed)
    select(renamed, 'D2')
    more()
    fireEvent.click(stanceToggle())
    const groups = [...morePop().querySelectorAll('.stance-family')].map((g) => g.textContent)
    expect(groups).toEqual(['Defensive line', 'Linebacker', 'Defensive back'])
    expect(choices()).toHaveLength(1 + 4 + 3 + 3)
  })
})

describe('position default', () => {
  it('clears the field rather than storing the default', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    expect(manIn(play, LT).presnapStance).toBe('OL_2_POINT')
    fireEvent.click(stanceToggle())
    fireEvent.click(within(morePop()).getByRole('radio', { name: /Use position default/ }))
    await settle()
    expect('presnapStance' in manIn(play, LT)).toBe(false)
    expect(stanceValue()).toBe('Position default')
  })
})

describe('keeping it', () => {
  it('survives closing and reopening the play, and so does its absence', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    deselect()
    await choose(play, LG, /Right Hand Down/)
    reopen(play)
    select(play, LT)
    more()
    expect(stanceValue()).toBe('2 Point')
    deselect()
    select(play, LG)
    more()
    expect(stanceValue()).toBe('3 Point — Right Hand Down')
    expect(stored(play).players.filter((p) => 'presnapStance' in p)).toHaveLength(2)
  })

  it('is an ordinary edit: one undo takes it back, redo puts it back', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    await settle()
    fireEvent.click(stanceToggle())
    fireEvent.click(within(morePop()).getByRole('radio', { name: /^○?3 Point — Left Hand Down$/ }))
    await settle()
    expect(manIn(play, LT).presnapStance).toBe('OL_3_POINT_LEFT')
    undo()
    await settle()
    expect(manIn(play, LT).presnapStance).toBe('OL_2_POINT')
    redo()
    await settle()
    expect(manIn(play, LT).presnapStance).toBe('OL_3_POINT_LEFT')
  })

  it('stays when he is relabelled into another position, and says it is outside it', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    fireEvent.click(within(morePop()).getByRole('button', { name: 'Rename…' }))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'X' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(manIn(play, LT).label).toBe('X')
    expect(manIn(play, LT).presnapStance).toBe('OL_2_POINT')
    more()
    expect(stanceValue()).toBe('Offensive line · 2 Point')
    expect(stanceNote()).toEqual(['Not a receiver stance — kept until you choose another.'])
  })

  it('a duplicate carries it', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    deselect()
    fireEvent.click(document.querySelector('.play-btn')!)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await settle()
    const copy = createLocalPlayRepository().listPlays().find((p) => p.id !== play.id)!
    expect(copy.players.find((p) => p.id === LT)!.presnapStance).toBe('OL_2_POINT')
  })

  it('a saved formation carries it onto the next play', async () => {
    open(play)
    await choose(play, LT, /^○?2 Point$/)
    deselect()
    fireEvent.click(within(strip()).getByRole('button', { name: /^Formation/ }))
    fireEvent.click(within(strip()).getByRole('button', { name: /Save this formation/ }))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Ace' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    const looks = JSON.parse(localStorage.getItem(LOOKS_KEY)!).items as { name: string; players: Player[] }[]
    const ace = looks.find((l) => l.name === 'Ace')!
    expect(ace.players.find((p) => p.id === LT)!.presnapStance).toBe('OL_2_POINT')
    expect(ace.players.filter((p) => 'presnapStance' in p)).toHaveLength(1)
  })
})

describe('an older play', () => {
  it('opens as it was, offers the default, and gains a stance only where the coach chooses one', async () => {
    const raw = JSON.parse(JSON.stringify(play))
    expect(raw.players.some((p: object) => 'presnapStance' in p)).toBe(false)
    open(play)
    select(play, QB)
    more()
    expect(stanceValue()).toBe('Position default')
    expect(stanceNote()).toEqual(['Under Center'])
    deselect()
    await settle()
    expect(stored(play).players.some((p) => 'presnapStance' in p)).toBe(false)

    await choose(play, CB, /^○?Press$/)
    const gained = stored(play).players.filter((p) => 'presnapStance' in p)
    expect(gained.map((p) => [p.id, p.presnapStance])).toEqual([[CB, 'DB_PRESS']])
  })
})
