import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * MORE (ML-UX-4, SPEC §8).
 *
 * Everything about a selected man that is not one of the strip's seven:
 * how he runs it, what to do with his assignment, where the QB throws from,
 * and the man himself. Four groups, in this order, and nothing else is ever
 * added - which is what keeps the strip readable.
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
const morePop = () => strip().querySelector('.more-pop') as HTMLElement | null
const item = (name: string | RegExp) => within(morePop()!).getByRole('button', { name })
const maybeItem = (name: string | RegExp) => within(morePop()!).queryByRole('button', { name })
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const manIn = (play: Play, id: string) => stored(play).players.find((p) => p.id === id)!

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

const engagedIds = (play: Play) => new Set(play.engagements.flatMap((e) => [e.a, e.b]))
const withPath = (play: Play) =>
  play.players.find((p) => p.side === 'offense' && p.path.length > 1 && p.label !== 'QB' && !engagedIds(play).has(p.id))!
const noPath = (play: Play) =>
  play.players.find((p) => p.side === 'offense' && p.path.length < 2 && p.label !== 'QB' && !engagedIds(play).has(p.id))!

/** Open the play, select the man, open his More menu. */
function openMore(play: Play, id: string) {
  open(play)
  select(play, id)
  fireEvent.click(within(strip()).getByRole('button', { name: /^More/ }))
}

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = pane('Inside Zone Rt')
})
afterEach(cleanup)

describe('the four groups, in order', () => {
  it('reads: how he runs it, assignment, then the player', () => {
    openMore(play, withPath(play).id)
    const text = morePop()!.textContent!
    const at = (s: string) => text.indexOf(s)

    expect(at('How he runs it')).toBeGreaterThanOrEqual(0)
    expect(at('How he runs it')).toBeLessThan(at('Assignment'))
    expect(at('Assignment')).toBeLessThan(at('Player'))
  })

  it('opens below More, left-aligned', () => {
    openMore(play, withPath(play).id)
    expect(morePop()).not.toBeNull()
    // Popovers in the strip hang downward; only the dock's open upward.
    expect(morePop()!.closest('.bar.bottom')).toBeNull()
  })

  it('Escape closes it', () => {
    openMore(play, withPath(play).id)
    expect(morePop()).not.toBeNull()
    key('Escape')
    expect(morePop()).toBeNull()
  })
})

describe('how he runs it', () => {
  it('Speed lives here now, and still writes speed', async () => {
    const man = withPath(play)
    openMore(play, man.id)

    fireEvent.click(item('Fast'))
    await settle()

    expect(manIn(play, man.id).speed).toBe('fast')
  })

  it('After the route offers what he does, not the word "auto"', () => {
    openMore(play, withPath(play).id)
    const text = morePop()!.textContent!
    expect(text).toContain('After the route')
    expect(text).toMatch(/Keeps running|Stops/)
  })

  it('marks the automatic answer as (auto) until the coach says otherwise', async () => {
    const man = withPath(play)
    openMore(play, man.id)
    // Nothing chosen yet: exactly one option carries "(auto)".
    const autos = within(morePop()!)
      .getAllByRole('button', { name: /Keeps running|Stops/ })
      .filter((b) => b.textContent!.includes('(auto)'))
    expect(autos).toHaveLength(1)
    expect(manIn(play, man.id).endBehavior).toBeUndefined()

    // Choosing the OTHER one is an override, and drops "(auto)" from it.
    const other = within(morePop()!)
      .getAllByRole('button', { name: /Keeps running|Stops/ })
      .find((b) => !b.textContent!.includes('(auto)'))!
    const word = other.textContent!.includes('Stops') ? 'Stops' : 'Keeps running'
    fireEvent.click(other)
    await settle()

    expect(manIn(play, man.id).endBehavior).toBeDefined()
    // The coach's own choice is shown as his, without "(auto)" after it.
    const chosen = within(morePop()!)
      .getAllByRole('button', { name: /Keeps running|Stops/ })
      .find((b) => b.textContent!.includes(word))!
    expect(chosen.textContent).not.toContain('(auto)')
  })

  it('choosing the automatic answer clears the override rather than freezing it', async () => {
    const man = withPath(play)
    openMore(play, man.id)
    const other = within(morePop()!)
      .getAllByRole('button', { name: /Keeps running|Stops/ })
      .find((b) => !b.textContent!.includes('(auto)'))!
    fireEvent.click(other)
    await settle()
    expect(manIn(play, man.id).endBehavior).toBeDefined()

    const auto = within(morePop()!)
      .getAllByRole('button', { name: /Keeps running|Stops/ })
      .find((b) => b.textContent!.includes('(auto)'))!
    fireEvent.click(auto)
    await settle()

    expect(manIn(play, man.id).endBehavior).toBeUndefined()
  })

  it('is not offered to the QB', () => {
    const qb = play.players.find((p) => p.label === 'QB')!
    openMore(play, qb.id)
    expect(morePop()!.textContent).not.toContain('After the route')
  })
})

describe('assignment', () => {
  it('Copy, Mirror and Clear are dead without a route', () => {
    openMore(play, noPath(play).id)
    expect(item(/Copy his assignment/)).toBeDisabled()
    expect(item(/Mirror his assignment/)).toBeDisabled()
    expect(item(/Clear assignment/)).toBeDisabled()
  })

  it('Copy asks who gets it', () => {
    openMore(play, withPath(play).id)
    fireEvent.click(item(/Copy his assignment/))
    expect(strip().querySelector('.banner')!.textContent).toContain('Copy')
  })

  it('Mirror asks who gets it', () => {
    openMore(play, withPath(play).id)
    fireEvent.click(item(/Mirror his assignment/))
    expect(strip().querySelector('.banner')!.textContent).toContain('Mirror')
  })

  it('Clear assignment takes the path and nothing else', async () => {
    const man = withPath(play)
    openMore(play, man.id)
    await settle()
    const before = manIn(play, man.id)

    fireEvent.click(item(/Clear assignment/))
    await settle()

    const after = manIn(play, man.id)
    expect(after.path).toEqual([])
    expect(after.timing).toBe(before.timing)
    expect(after.speed).toBe(before.speed)
    expect(after.endBehavior).toBe(before.endBehavior)
  })

  it('Delete does exactly the same thing', async () => {
    const man = withPath(play)
    open(play)
    select(play, man.id)
    await settle()
    const before = manIn(play, man.id)

    key('Delete')
    await settle()

    const after = manIn(play, man.id)
    expect(after.path).toEqual([])
    expect(after.timing).toBe(before.timing)
    expect(after.speed).toBe(before.speed)
  })

  it('clearing is one undo step', async () => {
    const man = withPath(play)
    open(play)
    select(play, man.id)
    await settle()
    const before = manIn(play, man.id).path

    key('Delete')
    await settle()
    expect(manIn(play, man.id).path).toEqual([])

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(manIn(play, man.id).path).toEqual(before)
  })
})

describe('throw point', () => {
  it('is the QB’s, and only when there is a pass to throw', () => {
    const pass = pane('Trips Out')
    const qb = pass.players.find((p) => p.label === 'QB')!
    openMore(pass, qb.id)
    expect(morePop()!.textContent).toContain('Throw point')
    expect(item('Set on field…')).toBeInTheDocument()

    cleanup()
    openMore(pass, withPath(pass).id) // not the QB
    expect(morePop()!.textContent).not.toContain('Throw point')
  })

  it('is not offered when the ball is a handoff', () => {
    const qb = play.players.find((p) => p.label === 'QB')!
    openMore(play, qb.id)
    expect(morePop()!.textContent).not.toContain('Throw point')
  })

  it('drives the same pick the ball menu’s Advanced does', () => {
    const pass = pane('Trips Out')
    const qb = pass.players.find((p) => p.label === 'QB')!
    openMore(pass, qb.id)

    fireEvent.click(item('Set on field…'))

    // The same banner ML-UX-3 shows from Ball › Advanced › Set on field…
    expect(strip().querySelector('.banner')!.textContent).toContain("Click where on the QB's path he throws from")
  })
})

describe('the player himself', () => {
  it('Rename opens the inline field where the chip was, and caps at four', async () => {
    const man = withPath(play)
    openMore(play, man.id)

    fireEvent.click(item('Rename…'))
    const input = document.querySelector('input.inline-name') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.closest('.bar.context')).not.toBeNull()

    fireEvent.change(input, { target: { value: 'wideout' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await settle()

    expect(manIn(play, man.id).label).toBe('WIDE')
  })

  it('Delete player takes him with no questions, and says so', async () => {
    const man = withPath(play)
    openMore(play, man.id)

    fireEvent.click(item('Delete player'))
    await settle()

    expect(stored(play).players.find((p) => p.id === man.id)).toBeUndefined()
    expect(document.querySelector('.toast')!.textContent).toContain(man.label)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('deleting him can be undone', async () => {
    const man = withPath(play)
    openMore(play, man.id)
    fireEvent.click(item('Delete player'))
    await settle()
    expect(stored(play).players.find((p) => p.id === man.id)).toBeUndefined()

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(stored(play).players.find((p) => p.id === man.id)).toBeDefined()
  })

  it('deleting an engaged man takes his engagement with him', async () => {
    const blocker = play.engagements.length ? play.players.find((p) => p.id === play.engagements[0].a)! : null
    if (!blocker) return
    openMore(play, blocker.id)

    fireEvent.click(item('Delete player'))
    await settle()

    expect(stored(play).engagements.some((e) => e.a === blocker.id || e.b === blocker.id)).toBe(false)
  })
})

describe('what is deliberately NOT in More', () => {
  it('holds no Timing, no Blocks and no Then', () => {
    openMore(play, withPath(play).id)
    const text = morePop()!.textContent!
    expect(text).not.toContain('Timing')
    expect(text).not.toContain('Blocks')
    expect(text).not.toContain('Then')
    expect(maybeItem(/Adjust/)).toBeNull()
  })
})

describe('deleting a player, with roles in place (P3.2)', () => {
  /**
   * A man's id carries every reference to him, so removal has always cleaned
   * those up. Two men are different because the ENGINE needs them: the passer
   * (nothing names him - the ball simply assumes him) and the snapper (whose
   * feet are the snap spot). Deleting the passer therefore takes the ball
   * action with him, and deleting the snapper is refused until somebody else
   * has the job - otherwise the snap silently moves to midfield.
   *
   * ROLE, NEVER LABEL: a man called QB who is not the passer deletes like
   * anybody else.
   */
  const named = (label: string, side: 'offense' | 'defense' = 'offense') =>
    play.players.find((p) => p.label === label && p.side === side)!
  const del = async () => {
    fireEvent.click(item('Delete player'))
    await settle()
  }
  const toastText = () => document.querySelector('.toast')?.textContent ?? ''
  const gone = (id: string) => stored(play).players.every((p) => p.id !== id)
  const roleOf = (id: string) => stored(play).players.find((p) => p.id === id)?.role

  it('deletes a defensive player and leaves everyone else alone', async () => {
    const lb = named('LB', 'defense')
    openMore(play, lb.id)
    await del()

    expect(gone(lb.id)).toBe(true)
    // Everyone else is exactly as he was authored. (Roles are written down by
    // this first save; they are asserted on their own, below and in roles.test.)
    const authored = (p: (typeof play.players)[number]) => ({ ...p, role: undefined })
    expect(stored(play).players.map(authored)).toEqual(play.players.filter((p) => p.id !== lb.id).map(authored))
    expect(stored(play).ball).toEqual(play.ball)
    expect(stored(play).engagements).toEqual(play.engagements)
  })

  it('deleting the passer takes the ball action with him, and says so', async () => {
    const qb = named('QB')
    openMore(play, qb.id)
    expect(stored(play).ball).not.toBeNull()
    await del()

    expect(gone(qb.id)).toBe(true)
    expect(stored(play).ball).toBeNull()
    expect(stored(play).ballThen).toBeNull()
    expect(toastText()).toMatch(/ball/i)
  })

  it('deleting the passer hands the job to nobody', async () => {
    const qb = named('QB')
    openMore(play, qb.id)
    await del()

    expect(stored(play).players.some((p) => p.role === 'passer')).toBe(false)
  })

  it('deleting the snapper is refused, with the way out', async () => {
    const c = named('C')
    openMore(play, c.id)
    const before = JSON.stringify(stored(play))
    await del()

    expect(gone(c.id)).toBe(false)
    expect(JSON.stringify(stored(play))).toBe(before)
    expect(toastText()).toMatch(/snapper/i)
  })

  it('a refused delete is not an undo step', async () => {
    const c = named('C')
    openMore(play, c.id)
    // One real edit first, so there is something for undo to walk back to.
    fireEvent.click(item('Fast'))
    await settle()
    const afterEdit = JSON.stringify(stored(play))

    openMore(play, c.id)
    await del()
    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    // Undo walked back the SPEED change, which means the refusal never
    // reached the history at all.
    expect(JSON.stringify(stored(play))).not.toBe(afterEdit)
    expect(stored(play).players.find((p) => p.id === c.id)!.speed).toBe(play.players.find((p) => p.id === c.id)!.speed)
  })

  it('once somebody else snaps it, the old snapper deletes normally', async () => {
    const c = named('C')
    const rg = named('RG')
    openMore(play, rg.id)
    fireEvent.click(item('Make snapper'))
    await settle()
    expect(roleOf(rg.id)).toBe('snapper')

    openMore(play, c.id)
    await del()
    expect(gone(c.id)).toBe(true)
    expect(roleOf(rg.id)).toBe('snapper')
  })

  it('a man called QB who does not throw it deletes like anybody else', async () => {
    const qb = named('QB')
    const rb = named('RB')
    openMore(play, rb.id)
    fireEvent.click(item('Make passer'))
    await settle()

    openMore(play, qb.id)
    await del()
    expect(gone(qb.id)).toBe(true)
    expect(roleOf(rb.id)).toBe('passer')
    expect(stored(play).ball).not.toBeNull()
  })

  it('a man called C who does not snap it deletes like anybody else', async () => {
    const c = named('C')
    const rg = named('RG')
    openMore(play, rg.id)
    fireEvent.click(item('Make snapper'))
    await settle()
    // He is still called C; the job is the other man's now.
    openMore(play, c.id)
    await del()

    expect(gone(c.id)).toBe(true)
    expect(stored(play).players.find((p) => p.id === rg.id)!.label).toBe('RG')
  })

  it('undo brings back the man, his job, his route and the ball', async () => {
    const qb = named('QB')
    openMore(play, qb.id)
    // One real edit first, so the stored play is the one the editor is
    // holding - roles written down and all - and undo has a step to land on.
    fireEvent.click(item('Fast'))
    await settle()
    const before = stored(play)

    openMore(play, qb.id)
    await del()
    expect(gone(qb.id)).toBe(true)

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    const back = stored(play).players.find((p) => p.id === qb.id)!
    const was = before.players.find((p) => p.id === qb.id)!
    expect(back).toEqual(was)
    expect(back.role).toBe('passer')
    expect(stored(play).ball).toEqual(before.ball)
    expect(stored(play).engagements).toEqual(before.engagements)
  })

  it('the camera stops riding with a man who has been deleted', async () => {
    const man = withPath(play)
    open(play)
    select(play, man.id)
    const view = (name: string) => fireEvent.click(within(document.querySelector('.bar') as HTMLElement).getByRole('button', { name }))
    view('Player')
    await settle()
    expect(strip().textContent).toContain(man.label)

    view('Overhead')
    select(play, man.id)
    fireEvent.click(within(strip()).getByRole('button', { name: /^More/ }))
    await del()

    view('Player')
    await settle()
    expect(strip().textContent).toMatch(/Click the player to watch from/)
  })
})
