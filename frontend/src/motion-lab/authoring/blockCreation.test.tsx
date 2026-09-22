import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { inferMeetPoint } from './meetPoint'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * TELLING PEIRA WHO BLOCKS WHOM (ML-UX-5, SPEC §7.2–§7.3).
 *
 * It used to take two clicks: pick the defender, then pick the spot. The spot
 * was nearly always the same one - the end of the blocker's path - so it is
 * inferred now, and the coach corrects it only when he disagrees.
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
const stripBtn = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const banner = () => strip().querySelector('.banner') as HTMLElement | null
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const blocks = (play: Play) => stored(play).engagements
const toast = () => document.querySelector('.toast')?.textContent ?? ''

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

/** A play with no blocks in it yet, so each test starts from nothing. */
const clean = (name = 'Inside Zone Rt'): Play => ({ ...pane(name), engagements: [] })
const offenseWithPath = (play: Play) => play.players.find((p) => p.side === 'offense' && p.path.length > 1)!
const offenseNoPath = (play: Play) => play.players.find((p) => p.side === 'offense' && p.path.length < 2 && p.label !== 'QB')!
const anyDefender = (play: Play) => play.players.find((p) => p.side === 'defense')!

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = clean()
})
afterEach(cleanup)

describe('one click, not two', () => {
  it('creates the block the moment the defender is chosen', async () => {
    open(play)
    const blocker = offenseWithPath(play)
    select(play, blocker.id)

    fireEvent.click(stripBtn('Blocks…'))
    expect(banner()!.textContent).toContain(`Choose the defender ${blocker.label} blocks`)

    const d = anyDefender(play)
    select(play, d.id)
    await settle()

    // No second question, and the block exists.
    expect(banner()).toBeNull()
    expect(blocks(play)).toHaveLength(1)
    expect(blocks(play)[0]).toMatchObject({ a: blocker.id, b: d.id })
  })

  it('leaves the blocker selected, so the strip shows his block', async () => {
    open(play)
    const blocker = offenseWithPath(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, anyDefender(play).id)
    await settle()

    expect(strip().querySelector('.chip')!.textContent).toContain(blocker.label)
    expect(within(strip()).getByRole('button', { name: /^Blocks \w+/ })).toBeInTheDocument()
  })

  it('puts the × on the field at the inferred point', async () => {
    open(play)
    const blocker = offenseWithPath(play)
    const d = anyDefender(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()

    expect(board().querySelector('[data-engage]')).not.toBeNull()
    expect(blocks(play)[0].point).toEqual(inferMeetPoint(blocker, d))
  })
})

describe('where PEIRA puts them', () => {
  it('at the end of his path, when he has one', async () => {
    open(play)
    const blocker = offenseWithPath(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, anyDefender(play).id)
    await settle()

    expect(blocks(play)[0].point).toEqual(blocker.path[blocker.path.length - 1])
  })

  it('halfway between them, when he has none', async () => {
    open(play)
    const blocker = offenseNoPath(play)
    const d = anyDefender(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()

    expect(blocks(play)[0].point).toEqual({ x: (blocker.x + d.x) / 2, y: (blocker.y + d.y) / 2 })
  })

  it('and always on the field', async () => {
    // A path drawn hard into the sideline still yields a point in bounds.
    open(play)
    const blocker = offenseNoPath(play)
    select(play, blocker.id)
    drawFromHandle(play, blocker.id, [[blocker.x + 2, blocker.y + 4], [-40, 90]])
    await settle()

    fireEvent.click(stripBtn('Blocks…'))
    select(play, anyDefender(play).id)
    await settle()

    const { x, y } = blocks(play)[0].point
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(53.33)
    expect(y).toBeLessThanOrEqual(17)
  })

  it('a new block is PEIRA’s guess, not the coach’s placement', async () => {
    open(play)
    select(play, offenseWithPath(play).id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, anyDefender(play).id)
    await settle()

    expect(blocks(play)[0].auto).toBe(true)
  })
})

describe('who may be chosen', () => {
  it('the other side only - his own team is not pickable', () => {
    open(play)
    const blocker = offenseWithPath(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))

    const teammate = play.players.find((p) => p.side === 'offense' && p.id !== blocker.id)!
    const before = blocks(play).length
    select(play, teammate.id)

    expect(blocks(play)).toHaveLength(before)
    expect(banner()).not.toBeNull() // still asking
  })

  it('a defender already in a block is not pickable', async () => {
    open(play)
    const first = offenseWithPath(play)
    const d = anyDefender(play)
    select(play, first.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()
    expect(blocks(play)).toHaveLength(1)

    // A second blocker cannot have the same man.
    const second = play.players.find((p) => p.side === 'offense' && p.id !== first.id && p.label !== 'QB')!
    select(play, second.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()

    expect(blocks(play)).toHaveLength(1)
    expect(banner()).not.toBeNull()
  })

  it('a defender engages, rather than blocks', () => {
    open(play)
    const d = anyDefender(play)
    select(play, d.id)

    fireEvent.click(stripBtn('Engages…'))

    expect(banner()!.textContent).toContain(`Choose who ${d.label} engages`)
  })

  it('with nobody left to pick, the button is dead and says why', () => {
    // A play cut down to two defenders, both already spoken for, leaving a
    // blocker with nobody to block.
    const p = pane('Inside Zone Rt')
    const offense = p.players.filter((x) => x.side === 'offense')
    const defense = p.players.filter((x) => x.side === 'defense').slice(0, 2)
    const busy: Play = {
      ...p,
      players: [...offense, ...defense],
      engagements: defense.map((d, i) => ({
        id: `e${i}`,
        kind: 'engage' as const,
        a: offense[i].id,
        b: d.id,
        point: { x: d.x, y: d.y },
      })),
    }
    open(busy)
    const free = offense.find((x) => !busy.engagements.some((e) => e.a === x.id || e.b === x.id))!
    select(busy, free.id)

    const btn = stripBtn('Blocks…')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Every defender is already engaged.')
  })
})

describe('what the coach is told', () => {
  it('names the path when that is where the block went', async () => {
    open(play)
    const blocker = offenseWithPath(play)
    const d = anyDefender(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()

    expect(toast()).toBe(`${blocker.label} blocks ${d.label} where his path ends. Drag the × to move it.`)
  })

  it('says halfway, and how to fix it, when he has no path', async () => {
    open(play)
    const blocker = offenseNoPath(play)
    const d = anyDefender(play)
    select(play, blocker.id)
    fireEvent.click(stripBtn('Blocks…'))
    select(play, d.id)
    await settle()

    expect(toast()).toBe(
      `${blocker.label} blocks ${d.label} halfway to him. Drag the × to move it, or draw ${blocker.label}'s path.`,
    )
  })
})

describe('changing his mind', () => {
  it('Escape during the pick leaves no half-made block', async () => {
    open(play)
    select(play, offenseWithPath(play).id)
    fireEvent.click(stripBtn('Blocks…'))
    expect(banner()).not.toBeNull()

    key('Escape')
    await settle()

    expect(banner()).toBeNull()
    expect(blocks(play)).toHaveLength(0)
    expect(stripBtn('Blocks…')).toBeInTheDocument()
  })

  it('Cancel does the same', async () => {
    open(play)
    select(play, offenseWithPath(play).id)
    fireEvent.click(stripBtn('Blocks…'))

    fireEvent.click(within(strip()).getByRole('button', { name: /Cancel/ }))
    await settle()

    expect(blocks(play)).toHaveLength(0)
  })
})
