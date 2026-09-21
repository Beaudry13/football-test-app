/// <reference types="node" />
// File-scoped Node types: the stylesheet is read from disk, as
// motionLabCss.test.ts does (vitest.config.ts sets `css: false`).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * EDGE PRESENTATION (ML-UX-11, SPEC §15; §12.1, §12.3).
 *
 * Two dead ends that used to say nothing. D with nobody selected now points
 * the coach at the sentence that tells him what to do first; a ball with
 * nobody to give it to no longer offers four picks that cannot finish.
 *
 * §12.9's other-tab notice is deliberately NOT here: PEIRA saves to the
 * server by revision, and its conflict flow ("This play was changed
 * somewhere else.") already covers it without overwriting anyone.
 */

installPointerStubs()

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(resolve(here, '../motionLab.css'), 'utf-8').replace(/\r\n/g, '\n')

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
/** Let the editor's 400 ms autosave quiet period pass. */
const settle = () => wait(450)
const pane = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!
const byLabel = (play: Play, label: string) => play.players.find((p) => p.label === label)!
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!

/** Inside the root, as MotionLabEditorPage renders it. */
function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  return render(
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

const topBar = () => document.querySelector('.bar:not(.context):not(.bottom)') as HTMLElement
const strip = () => document.querySelector('.bar.context') as HTMLElement | null
const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const hint = () => strip()!.querySelector('.hint') as HTMLElement
const flashing = () => document.querySelectorAll('.hint-flash').length > 0
const toast = () => document.querySelector('.toast')
const ballBtn = () => dock().querySelector('.ball-btn') as HTMLButtonElement
const ballMenu = () => document.querySelector('.ball-pop') as HTMLElement | null
const item = (name: string | RegExp) => within(ballMenu()!).getByRole('button', { name })

/** The same play with its offense cut down to `keep` - and nothing left
 *  pointing at the men who went. */
function offenseOnly(keep: (label: string) => boolean): Play {
  const p = pane()
  const players = p.players.filter((x) => x.side === 'defense' || keep(x.label))
  const ids = new Set(players.map((x) => x.id))
  return {
    ...p,
    players,
    engagements: p.engagements.filter((e) => ids.has(e.a) && ids.has(e.b)),
    ball: null,
    ballThen: null,
  } as Play
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---- §12.1 ------------------------------------------------------------------

describe('D with nobody selected: the resting hint flashes gold (SPEC §12.1)', () => {
  it('flashes the hint on screen, and does nothing else at all', async () => {
    const play = pane()
    open(play)
    await settle()
    const before = JSON.stringify(stored(play))
    const words = hint().textContent

    key('d')

    expect(hint()).toHaveClass('hint-flash')
    expect(hint().textContent).toBe(words) // the same sentence - no new copy
    // Nobody selected, nothing armed, no toast, no banner.
    expect(board().getAttribute('class')).toBe('board board-idle')
    expect(strip()!.querySelector('.chip-static')).toBeNull()
    expect(strip()!.querySelector('.banner')).toBeNull()
    expect(toast()).toBeNull()
    // No edit: nothing saved, and nothing to undo.
    await settle()
    expect(JSON.stringify(stored(play))).toBe(before)
    expect(within(topBar()).getByRole('button', { name: '↶' })).toBeDisabled()
  })

  it('lasts 200 ms, then the hint is itself again', async () => {
    open(pane())
    key('d')
    await wait(100)
    expect(hint()).toHaveClass('hint-flash')
    await waitFor(() => expect(hint()).not.toHaveClass('hint-flash'), { timeout: 1000 })
  })

  it('each press starts the 200 ms over', async () => {
    open(pane())
    key('d')
    await wait(150)
    key('d')
    await wait(150)
    // 300 ms after the first press: a first timer left running would have
    // ended the flash at 200. Only a restarted one is still going.
    expect(hint()).toHaveClass('hint-flash')
    await waitFor(() => expect(hint()).not.toHaveClass('hint-flash'), { timeout: 1000 })
  })

  it('flashes whatever the resting hint says - the ball\'s warning included', () => {
    // A ball with nobody to hold it: the resting hint becomes the warning.
    const p = pane()
    const qb = byLabel(p, 'QB')
    open({
      ...p,
      players: p.players.filter((x) => x.id !== qb.id),
      engagements: p.engagements.filter((e) => e.a !== qb.id && e.b !== qb.id),
      ball: { kind: 'keep' },
      ballThen: null,
    } as Play)
    expect(hint().textContent).toBe('Ball: No QB on the field.')

    key('d')

    expect(hint()).toHaveClass('hint-flash')
    expect(hint().textContent).toBe('Ball: No QB on the field.')
  })

  it('with a man selected, D still arms drawing for him - no flash', () => {
    const play = pane()
    open(play)
    select(play, byLabel(play, 'LT').id)

    key('d')

    expect(board().getAttribute('class')).toBe('board board-armed')
    expect(flashing()).toBe(false)
  })

  it('not in Coach view, not in Player view, not in Present, not during a pick', () => {
    const play = pane()
    const view = (name: string) => fireEvent.click(within(topBar()).getByRole('button', { name }))

    open(play)
    view('Coach')
    key('d')
    expect(flashing()).toBe(false)

    view('Player') // choosing whom to watch from
    key('d')
    expect(flashing()).toBe(false)
    select(play, byLabel(play, 'FS').id) // now watching from him
    key('d')
    expect(flashing()).toBe(false)
    cleanup()
    localStorage.clear()

    open(play)
    fireEvent.click(within(topBar()).getByRole('button', { name: 'Present' }))
    key('d')
    expect(flashing()).toBe(false)
    cleanup()
    localStorage.clear()

    open(play)
    fireEvent.click(ballBtn())
    fireEvent.click(item('Pass to…'))
    expect(strip()!.querySelector('.banner')).not.toBeNull()
    key('d')
    expect(flashing()).toBe(false)
    // ...and the pick is still waiting for its answer.
    expect(strip()!.querySelector('.banner')).not.toBeNull()
  })

  it('leaves no timer behind when the editor goes away', () => {
    open(pane())
    const set = vi.spyOn(window, 'setTimeout')
    key('d')
    const call = set.mock.calls.findIndex((c) => c[1] === 200)
    expect(call).toBeGreaterThanOrEqual(0)
    const timer = set.mock.results[call].value
    const clear = vi.spyOn(window, 'clearTimeout')

    cleanup()

    expect(clear).toHaveBeenCalledWith(timer)
  })

  it('is a colour, not an animation: gold, with no transition or keyframe to switch off', () => {
    const text = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = text.match(/\.motion-lab-root \.bar\.context \.hint\.hint-flash,\s*\.motion-lab-root \.bar\.context \.hint\.hint-flash b \{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1].trim()).toBe('color: var(--accent);')
    // Nothing else in the stylesheet animates, transitions or hides it.
    const others = [...text.matchAll(/([^{}]*hint-flash[^{}]*)\{([^}]*)\}/g)].map((m) => m[2])
    expect(others.every((body) => !/animation|transition/.test(body))).toBe(true)
    // A PEIRA addition, below the marker the prototype's rules end at.
    expect(CSS.indexOf('.hint-flash')).toBeGreaterThan(CSS.indexOf('==== PEIRA ADDITIONS'))
  })
})

// ---- §12.3 ------------------------------------------------------------------

const TAKERS = [/^Handoff to…$/, /^Pitch to…$/, /^Pass to…$/, /^Play action/]
const UNAVAILABLE = 'Add an offensive player first.'

function expectNobodyToGiveItTo() {
  expect(item(/QB keeps it/)).not.toBeDisabled()
  expect(item(/QB keeps it/)).not.toHaveAttribute('title')
  for (const name of TAKERS) {
    expect(item(name), String(name)).toBeDisabled()
    expect(item(name)).toHaveAttribute('title', UNAVAILABLE)
  }
}

describe('a ball with nobody to give it to (SPEC §12.3)', () => {
  it('only the QB on offense: Keep stays, the four are disabled and say why', () => {
    open(offenseOnly((l) => l === 'QB'))
    fireEvent.click(ballBtn())
    expect(within(ballMenu()!).getByText('What happens with the ball?')).toBeInTheDocument()
    expectNobodyToGiveItTo()
  })

  it('in the "Change to" list as well', () => {
    open({ ...offenseOnly((l) => l === 'QB'), ball: { kind: 'keep' } } as Play)
    fireEvent.click(ballBtn())
    expect(within(ballMenu()!).getByText('Change to')).toBeInTheDocument()
    expectNobodyToGiveItTo()
  })

  it('no offense at all', () => {
    open(offenseOnly(() => false))
    fireEvent.click(ballBtn())
    expectNobodyToGiveItTo()
  })

  it('a disabled item does nothing: no pick, no toast, no view change, the menu stays', async () => {
    const play = offenseOnly((l) => l === 'QB')
    open(play)
    await settle()
    const before = JSON.stringify(stored(play))
    fireEvent.click(ballBtn())

    for (const name of TAKERS) fireEvent.click(item(name))

    expect(ballMenu()).not.toBeNull()
    expect(strip()!.querySelector('.banner')).toBeNull()
    expect(toast()).toBeNull()
    expect(within(topBar()).getByRole('button', { name: 'Overhead' })).toHaveClass('active')
    await settle()
    expect(JSON.stringify(stored(play))).toBe(before)
  })

  it('QB keeps it still works when it is the only answer', async () => {
    const play = offenseOnly((l) => l === 'QB')
    open(play)
    fireEvent.click(ballBtn())
    fireEvent.click(item(/QB keeps it/))
    await settle()
    expect(stored(play).ball).toEqual({ kind: 'keep' })
  })

  it('one teammate is enough: everything is on again, and a pick starts as before', () => {
    open(offenseOnly((l) => l === 'QB' || l === 'X'))
    fireEvent.click(ballBtn())
    for (const name of [/QB keeps it/, ...TAKERS]) {
      expect(item(name), String(name)).not.toBeDisabled()
      expect(item(name)).not.toHaveAttribute('title')
    }
    fireEvent.click(item('Pass to…'))
    expect(strip()!.querySelector('.banner')).not.toBeNull()
  })

  it('B opens the same menu with the same rule', () => {
    open(offenseOnly((l) => l === 'QB'))
    key('b')
    expect(ballMenu()).not.toBeNull()
    expectNobodyToGiveItTo()
  })

  it('from Coach view too - the menu is in the dock', () => {
    open(offenseOnly((l) => l === 'QB'))
    fireEvent.click(within(topBar()).getByRole('button', { name: 'Coach' }))
    fireEvent.click(ballBtn())
    expectNobodyToGiveItTo()
    fireEvent.click(item('Pass to…'))
    // Disabled: it did not take him back to Overhead for a pick.
    expect(within(topBar()).getByRole('button', { name: 'Coach' })).toHaveClass('active')
  })
})
