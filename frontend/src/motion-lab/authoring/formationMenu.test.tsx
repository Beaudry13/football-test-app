import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { installPointerStubs } from '../testing/pointerStubs'
import type { Play } from '../engine/play'

/**
 * FORMATION (ML-UX-4, SPEC §13).
 *
 * Players and Look were two menus for one idea - who is on the field and how
 * they are arranged - so the resting strip now has one, called Formation.
 *
 * THE RENAME IS COACH-FACING ONLY. The stored concept is still a Look: the
 * type in engine/play.ts, `saveLook`/`listLooks` on the repository, the
 * `motion_looks` table. These tests read the storage back through the
 * repository to prove the words changed and the data did not.
 */

installPointerStubs()

const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))
const pane = (name: string) => panePlays().find((p) => p.name === name)!

let repo = createLocalPlayRepository()
function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  repo = createLocalPlayRepository()
  render(<MotionLabEditor repository={repo} />)
}

const strip = () => document.querySelector('.bar.context') as HTMLElement
const formationBtn = () => within(strip()).getByRole('button', { name: /^Formation/ })
const pop = () => strip().querySelector('.formation-pop') as HTMLElement | null
const item = (name: string | RegExp) => within(pop()!).getByRole('button', { name })
const playMenu = () => document.querySelector('.play-pop') as HTMLElement | null
const openPlayMenu = () => fireEvent.click(document.querySelector('.play-btn')!)

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the resting strip has one menu', () => {
  it('is called Formation, and Players and Look are gone', () => {
    open(play)
    expect(formationBtn()).toBeInTheDocument()
    expect(within(strip()).queryByRole('button', { name: /^Players/ })).toBeNull()
    expect(within(strip()).queryByRole('button', { name: /^Look/ })).toBeNull()
  })

  it('holds the men, the saved formations and a count', () => {
    open(play)
    fireEvent.click(formationBtn())

    expect(item('Add offensive player')).toBeInTheDocument()
    expect(item('Add defensive player')).toBeInTheDocument()
    expect(item('Save this formation…')).toBeInTheDocument()
    expect(pop()!.textContent).toContain('Saved formations')
    expect(pop()!.querySelector('.pop-foot')!.textContent).toMatch(/\d+ offense · \d+ defense/)
  })

  it('adds a player to either side', async () => {
    open(play)
    const before = repo.listPlays().find((p) => p.id === play.id)!.players.length

    fireEvent.click(formationBtn())
    fireEvent.click(item('Add offensive player'))
    await settle()

    expect(repo.listPlays().find((p) => p.id === play.id)!.players.length).toBe(before + 1)
  })
})

describe('saving an arrangement', () => {
  it('says formation to the coach and stores a look', async () => {
    open(play)
    fireEvent.click(formationBtn())
    fireEvent.click(item('Save this formation…'))

    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Trips Rt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()

    // The word the coach saw...
    expect(document.querySelector('.toast')!.textContent).toContain('Formation "Trips Rt" saved.')
    // ...and the thing that was actually written.
    expect(repo.listLooks().map((l) => l.name)).toEqual(['Trips Rt'])
    expect(repo.listLooks()[0].players.every((p) => p.path.length === 0)).toBe(true)
  })

  it('lists what has been saved, and can start a play from it', async () => {
    open(play)
    fireEvent.click(formationBtn())
    fireEvent.click(item('Save this formation…'))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Base 11' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()

    expect(pop()!.textContent).toContain('Base 11')
    fireEvent.click(item('New play'))
    await settle()

    expect(repo.listPlays().map((p) => p.name)).toContain('Base 11 — new play')
  })

  it('loads one back onto the field, and says so', async () => {
    open(play)
    fireEvent.click(formationBtn())
    fireEvent.click(item('Save this formation…'))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Base 11' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()

    fireEvent.click(item('Load'))
    await settle()

    expect(document.querySelector('.toast')!.textContent).toContain('Formation "Base 11" loaded')
  })

  it('deletes one, after asking', async () => {
    const asked: string[] = []
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => {
      asked.push(String(m))
      return true
    })
    open(play)
    fireEvent.click(formationBtn())
    fireEvent.click(item('Save this formation…'))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Base 11' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()
    expect(repo.listLooks()).toHaveLength(1)

    fireEvent.click(item('×'))
    await settle()

    expect(repo.listLooks()).toHaveLength(0)
    // The question uses the coach's word too.
    expect(asked[0]).toContain('formation')
  })
})

describe('the play menu', () => {
  it('calls a new play from this arrangement a formation', () => {
    open(play)
    openPlayMenu()
    expect(within(playMenu()!).getByRole('button', { name: 'New play (this formation)' })).toBeInTheDocument()
  })

  it('is where Clear all assignments lives now', async () => {
    open(play)
    expect(within(strip()).queryByRole('button', { name: /Clear All Paths/i })).toBeNull()

    openPlayMenu()
    const clear = within(playMenu()!).getByRole('button', { name: 'Clear all assignments' })
    expect(clear).not.toBeDisabled()

    fireEvent.click(clear)
    await settle()

    expect(repo.listPlays().find((p) => p.id === play.id)!.players.every((p) => p.path.length === 0)).toBe(true)
  })

  it('offers nothing to clear when there is nothing drawn', async () => {
    const bare = { ...play, players: play.players.map((p) => ({ ...p, path: [] })) }
    open(bare)

    openPlayMenu()

    expect(within(playMenu()!).getByRole('button', { name: 'Clear all assignments' })).toBeDisabled()
  })

  it('leaves the other play actions alone', () => {
    open(play)
    openPlayMenu()
    for (const name of ['Rename…', 'Duplicate', 'Delete play']) {
      expect(within(playMenu()!).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
