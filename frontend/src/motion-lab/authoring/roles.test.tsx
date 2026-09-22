import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, LOOKS_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import { roleHolder, type Player } from '../engine/formation'
import { deriveBall } from '../engine/ball'
import { buildSchedule } from '../engine/timeline'
import { sanitizePlay, SCHEMA_VERSION, type Play } from '../engine/play'
import { assignRole, passerOf, snapperOf, withRoles } from './roles'

/**
 * WHAT HE IS CALLED IS NOT WHAT HE DOES (P3.1).
 *
 * The prototype found the passer and the snapper by label, so a coach who
 * renamed his quarterback "Q" or "12" lost the ball and the snap. A player
 * carries a ROLE now. These tests hold both halves of the deal: the rename is
 * free, and the football does not move with it - while a play written before
 * roles existed still behaves exactly as the engine always behaved.
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
const strip = () => document.querySelector('.bar.context') as HTMLElement
const morePop = () => strip().querySelector('.more-pop') as HTMLElement
const item = (name: string | RegExp) => within(morePop()).getByRole('button', { name })
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const manIn = (play: Play, id: string) => stored(play).players.find((p) => p.id === id)!
const toast = () => document.querySelector('.toast')?.textContent ?? ''

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}
function openMore(play: Play, id: string) {
  open(play)
  select(play, id)
  fireEvent.click(within(strip()).getByRole('button', { name: /^More/ }))
}
/** Rename the selected man through the menu, as a coach does. */
async function rename(play: Play, id: string, to: string) {
  openMore(play, id)
  fireEvent.click(item('Rename…'))
  const input = document.querySelector('input.inline-name') as HTMLInputElement
  fireEvent.change(input, { target: { value: to } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await settle()
}

let play: Play
const man = (label: string, side: 'offense' | 'defense' = 'offense') =>
  play.players.find((p) => p.label === label && p.side === side)!

beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

describe('a play written before roles existed', () => {
  it('carries no role, and the engine still finds both men by label', () => {
    const players = sanitizePlay(JSON.parse(JSON.stringify(play)))!.players
    expect(players.some((p) => p.role)).toBe(false)
    expect(roleHolder(players, 'passer', 'QB')?.label).toBe('QB')
    expect(roleHolder(players, 'snapper', 'C')?.label).toBe('C')
  })

  it('throws the ball exactly as it did: no warning, a real passer', () => {
    const { schedule, snapAt } = buildSchedule(play.players)
    const ball = deriveBall(play.players, schedule, snapAt, play.ball, play.ballThen)
    expect(ball.warning).toBeNull()
    expect(ball.passer).toBe('QB')
  })
})

describe('writing the roles down', () => {
  it('gives them to whoever was already doing the job', () => {
    const players = withRoles(play.players)
    expect(passerOf(players)?.label).toBe('QB')
    expect(snapperOf(players)?.label).toBe('C')
    expect(players.filter((p) => p.role === 'passer')).toHaveLength(1)
    expect(players.filter((p) => p.role === 'snapper')).toHaveLength(1)
  })

  it('leaves a play that already says so untouched', () => {
    const already = withRoles(play.players)
    expect(withRoles(already)).toBe(already)
  })

  it('keeps one passer and one snapper when a job is handed over', () => {
    const players = assignRole(withRoles(play.players), man('RB').id, 'passer')
    expect(passerOf(players)?.label).toBe('RB')
    expect(players.filter((p) => p.role === 'passer')).toHaveLength(1)
    expect(players.find((p) => p.label === 'QB')!.role).toBeUndefined()
  })

  it('drops a second claim on load rather than picking by list order', () => {
    const twoPassers = {
      ...play,
      players: play.players.map((p) => (p.label === 'QB' || p.label === 'RB' ? { ...p, role: 'passer' } : p)),
    }
    const loaded = sanitizePlay(JSON.parse(JSON.stringify(twoPassers)))!
    expect(loaded.players.filter((p) => p.role === 'passer').map((p) => p.label)).toEqual(['QB'])
  })

  it('never lets the defense hold a role', () => {
    const cheeky = { ...play, players: play.players.map((p) => (p.side === 'defense' ? { ...p, role: 'passer' } : p)) }
    const loaded = sanitizePlay(JSON.parse(JSON.stringify(cheeky)))!
    expect(loaded.players.filter((p) => p.role).length).toBe(0)
  })
})

describe('renaming, with the roles in place', () => {
  it('QB → Q still throws it', async () => {
    const qb = man('QB')
    await rename(play, qb.id, 'Q')

    const after = manIn(play, qb.id)
    expect(after.label).toBe('Q')
    expect(after.role).toBe('passer')
    expect(passerOf(stored(play).players)?.id).toBe(qb.id)
    const { schedule, snapAt } = buildSchedule(stored(play).players)
    expect(deriveBall(stored(play).players, schedule, snapAt, stored(play).ball, stored(play).ballThen).warning).toBeNull()
  })

  it('QB → 12 still throws it', async () => {
    const qb = man('QB')
    await rename(play, qb.id, '12')
    expect(manIn(play, qb.id).label).toBe('12')
    expect(passerOf(stored(play).players)?.id).toBe(qb.id)
  })

  it('C → OC still snaps it, and the snap spot stays on him', async () => {
    const c = man('C')
    const before = deriveBall(withRoles(play.players), buildSchedule(play.players).schedule, buildSchedule(play.players).snapAt, null, null).at(0).pos
    await rename(play, c.id, 'OC')

    expect(manIn(play, c.id).label).toBe('OC')
    expect(snapperOf(stored(play).players)?.id).toBe(c.id)
    const players = stored(play).players
    const { schedule, snapAt } = buildSchedule(players)
    expect(deriveBall(players, schedule, snapAt, null, null).at(0).pos).toEqual(before)
  })

  it('another man renamed QB does not take the ball', async () => {
    const qb = man('QB')
    const rb = man('RB')
    await rename(play, rb.id, 'QB')

    expect(manIn(play, rb.id).label).toBe('QB')
    expect(manIn(play, rb.id).role).toBeUndefined()
    expect(passerOf(stored(play).players)?.id).toBe(qb.id)
  })

  it('another man renamed C does not take the snap', async () => {
    const c = man('C')
    const rg = man('RG')
    await rename(play, rg.id, 'C')

    expect(snapperOf(stored(play).players)?.id).toBe(c.id)
  })

  it('keeps everything he does', async () => {
    const y = man('Y')
    openMore(play, y.id)
    const before = manIn(play, y.id)
    const engagements = JSON.stringify(stored(play).engagements)
    const ball = JSON.stringify(stored(play).ball)
    cleanup()

    await rename(play, y.id, 'te')

    const after = manIn(play, y.id)
    expect(after.label).toBe('TE')
    expect(after.path).toEqual(before.path)
    expect(after.timing).toBe(before.timing)
    expect(after.speed).toBe(before.speed)
    expect(after.delay).toBe(before.delay)
    expect(JSON.stringify(stored(play).engagements)).toBe(engagements)
    expect(JSON.stringify(stored(play).ball)).toBe(ball)
  })

  it('is one undo step', async () => {
    const y = man('Y')
    await rename(play, y.id, 'TE')
    expect(manIn(play, y.id).label).toBe('TE')

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()
    expect(manIn(play, y.id).label).toBe('Y')
  })

  it('leaves the defense free to use any label, including QB and C', async () => {
    const fs = man('FS', 'defense')
    await rename(play, fs.id, 'MOF')
    expect(manIn(play, fs.id).label).toBe('MOF')
    cleanup()

    await rename(play, fs.id, 'C')
    expect(manIn(play, fs.id).label).toBe('C')
    expect(snapperOf(stored(play).players)?.label).toBe('C')
    expect(snapperOf(stored(play).players)?.side).toBe('offense')
  })
})

describe('handing the job to somebody else', () => {
  it('Make passer moves it, and says so', async () => {
    const rb = man('RB')
    openMore(play, rb.id)
    fireEvent.click(item('Make passer'))
    await settle()

    expect(manIn(play, rb.id).role).toBe('passer')
    expect(manIn(play, man('QB').id).role).toBeUndefined()
    expect(toast()).toContain('RB')
  })

  it('Make snapper moves it', async () => {
    const rg = man('RG')
    openMore(play, rg.id)
    fireEvent.click(item('Make snapper'))
    await settle()

    expect(manIn(play, rg.id).role).toBe('snapper')
    expect(manIn(play, man('C').id).role).toBeUndefined()
  })

  it('is not offered to the man who already holds it, nor to the defense', () => {
    openMore(play, man('QB').id)
    expect(within(morePop()).queryByRole('button', { name: 'Make passer' })).toBeNull()
    expect(within(morePop()).queryByRole('button', { name: 'Make snapper' })).not.toBeNull()
    cleanup()

    openMore(play, man('LB', 'defense').id)
    expect(within(morePop()).queryByRole('button', { name: 'Make passer' })).toBeNull()
    expect(within(morePop()).queryByRole('button', { name: 'Make snapper' })).toBeNull()
  })
})

describe('the roles survive the round trip', () => {
  it('a saved play reloads with them, and says which version wrote it', async () => {
    const qb = man('QB')
    await rename(play, qb.id, 'Q')
    cleanup()

    const reloaded = createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
    expect(reloaded.v).toBe(SCHEMA_VERSION)
    expect(passerOf(reloaded.players)?.label).toBe('Q')
    expect(snapperOf(reloaded.players)?.label).toBe('C')
  })

  it('a saved formation carries them onto the next play', async () => {
    open(play)
    fireEvent.click(within(strip()).getByRole('button', { name: /^Formation/ }))
    fireEvent.click(within(strip()).getByRole('button', { name: /Save this formation/ }))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Ace' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()

    const looks = JSON.parse(localStorage.getItem(LOOKS_KEY)!).items as { players: Player[] }[]
    const saved = looks.find((l) => (l as { name?: string }).name === 'Ace') ?? looks[looks.length - 1]
    expect(passerOf(saved.players)?.label).toBe('QB')
    expect(snapperOf(saved.players)?.label).toBe('C')
  })
})
