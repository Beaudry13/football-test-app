import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { clampToField, U, Y_MAX } from '../engine/field'
import { hashX, situationLabel, type Play, type Situation } from '../engine/play'

/**
 * THE SITUATION IN THE DOCK (ML-UX-6, SPEC §9 row 9, §9.6, §13).
 *
 * Down and distance describe the field the play is run on, not the man who
 * is selected, so the chip left the strip for the dock's right-hand group -
 * `ball │ transport │ situation · Display` - where it also survives into
 * Present. Its Markings toggle moved into Display, beside Paths and Labels,
 * because whether the field shows the line to gain is a display choice.
 *
 * What the popover DOES (down, distance, spot, hash) is older than this
 * slice. It is re-asserted here because it moved, and a move is exactly when
 * a control can quietly stop being wired to anything.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))

/** "Inside Zone Rt": a real play with no ball warning, so the resting hint is
 *  the default sentence. */
const fixture = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const strip = () => document.querySelector('.bar.context') as HTMLElement
const sitChip = () => dock().querySelector('.sit-chip') as HTMLButtonElement
const sitPop = () => dock().querySelector('.sit-pop') as HTMLElement | null
const displayBtn = () => within(dock()).getByRole('button', { name: /^Display/ })
const displayPop = () => dock().querySelector('.display-pop') as HTMLElement | null
/** One row of the Display popover, by its label. */
const displayRow = (label: string) =>
  [...displayPop()!.querySelectorAll('.sit-row')].find((r) => r.querySelector('.lbl')?.textContent === label) as HTMLElement
const rowLabels = (pop: HTMLElement) => [...pop.querySelectorAll('.sit-row .lbl')].map((l) => l.textContent)
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
/** The line to gain - the one thing on the field `situation.show` draws. */
const lineToGain = () => board().querySelector('line[stroke="#f7c948"]')

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

let play: Play
beforeEach(() => {
  localStorage.clear()
  play = fixture()
})
afterEach(cleanup)

describe('where the chip is', () => {
  it('is in the dock', () => {
    open(play)
    expect(sitChip()).not.toBeNull()
    expect(sitChip().textContent).toBe(situationLabel(play.situation))
  })

  it('is not in the strip - resting, selected, or in Present', () => {
    open(play)
    expect(strip().querySelector('.sit-chip')).toBeNull()

    select(play, play.players.find((p) => p.side === 'offense')!.id)
    expect(strip().querySelector('.sit-chip')).toBeNull()

    key('Escape')
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))
    expect(strip().querySelector('.sit-chip')).toBeNull()
    expect(document.querySelectorAll('.sit-chip')).toHaveLength(1)
  })

  it('sits in the third group: ball │ transport … rate │ situation, Display', () => {
    open(play)
    const kids = [...dock().children]
    const at = (el: Element | null) => kids.findIndex((k) => k === el || k.contains(el))
    const dividers = kids.filter((k) => k.classList.contains('dock-divider'))

    expect(dividers).toHaveLength(2)
    expect(at(dock().querySelector('.ball-btn'))).toBeLessThan(at(dividers[0]))
    expect(at(dock().querySelector('.rate-pill'))).toBeLessThan(at(dividers[1]))
    expect(at(dividers[1])).toBeLessThan(at(sitChip()))
    expect(at(sitChip())).toBeLessThan(at(displayBtn()))
  })
})

describe('the resting strip, finally', () => {
  it('is Formation and one sentence, and nothing else', () => {
    open(play)
    expect(within(strip()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Formation ▾'])
    expect(strip().querySelector('.hint')!.textContent).toBe('Drag a player to move him. Click a player to give him a job.')
    expect(strip().children).toHaveLength(2)
  })
})

describe('the popover', () => {
  it('opens from the dock, and Escape closes it', () => {
    open(play)
    fireEvent.click(sitChip())
    expect(sitPop()).not.toBeNull()
    expect(sitChip()).toHaveAttribute('aria-expanded', 'true')

    key('Escape')

    expect(sitPop()).toBeNull()
  })

  it('still edits down, distance and where the ball is, and they are saved with the play', async () => {
    open(play)
    fireEvent.click(sitChip())
    const pop = sitPop()!

    fireEvent.click(within(pop).getByRole('button', { name: '3rd' }))
    const [distance, ballOn] = [...pop.querySelectorAll('input[type=number]')] as HTMLInputElement[]
    fireEvent.change(distance, { target: { value: '7' } })
    fireEvent.change(ballOn, { target: { value: '62' } })
    await settle()

    const s: Situation = stored(play).situation
    expect([s.down, s.distance, s.losYard]).toEqual([3, 7, 62])
    expect(sitChip().textContent).toBe(situationLabel(s))
  })

  it('no longer holds the markings toggle', () => {
    open(play)
    fireEvent.click(sitChip())
    expect(rowLabels(sitPop()!)).toEqual(['Down', 'Distance', 'Ball on', 'Hash'])
    expect(within(sitPop()!).queryByRole('button', { name: /Shown|Hidden/ })).toBeNull()
  })
})

describe('the hash still moves the whole formation', () => {
  /** Where `setHash` puts everyone: the centre goes to the hash, and every
   *  man, every route point and every meeting point moves with him. */
  function expectShifted(from: Play, to: Play, hash: Situation['hash']) {
    const center = from.players.find((p) => p.side === 'offense' && p.label === 'C')!
    const dx = hashX(hash) - center.x
    const shift = (q: { x: number; y: number }) => clampToField({ x: q.x + dx, y: q.y })

    expect(to.situation.hash).toBe(hash)
    for (const p of from.players) {
      const q = to.players.find((x) => x.id === p.id)!
      expect([q.x, q.y]).toEqual([shift(p).x, shift(p).y].map((v) => expect.closeTo(v, 6)))
      q.path.forEach((pt, i) => expect([pt.x, pt.y]).toEqual([shift(p.path[i]).x, shift(p.path[i]).y].map((v) => expect.closeTo(v, 6))))
    }
    from.engagements.forEach((e, i) =>
      expect(to.engagements[i].point.x).toBeCloseTo(shift(e.point).x, 6),
    )
  }

  it.each(['left', 'right'] as const)('to the %s hash, and back to the middle', async (hash) => {
    open(play)
    const label = hash === 'left' ? 'Left' : 'Right'

    fireEvent.click(sitChip())
    fireEvent.click(within(sitPop()!).getByRole('button', { name: label }))
    await settle()
    const moved = stored(play)
    expectShifted(play, moved, hash)

    fireEvent.click(within(sitPop()!).getByRole('button', { name: 'Middle' }))
    await settle()
    expectShifted(moved, stored(play), 'middle')
  })
})

describe('in Present', () => {
  it('still opens - the situation is read aloud in a meeting', () => {
    open(play)
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))

    expect(sitChip()).not.toBeDisabled()
    fireEvent.click(sitChip())
    expect(sitPop()).not.toBeNull()
  })

  it('and it still changes the situation there', async () => {
    open(play)
    fireEvent.click(screen.getByRole('button', { name: 'Present' }))
    fireEvent.click(sitChip())
    fireEvent.click(within(sitPop()!).getByRole('button', { name: '2nd' }))
    await settle()

    expect(stored(play).situation.down).toBe(2)
  })
})

describe('Display', () => {
  it('holds Paths, Labels and Field markings, in that order', () => {
    open(play)
    fireEvent.click(displayBtn())
    expect(rowLabels(displayPop()!)).toEqual(['Paths', 'Labels', 'Field markings'])
  })

  it('Field markings says Shown / Hidden, like Labels above it', () => {
    open(play)
    fireEvent.click(displayBtn())
    expect(within(displayRow('Field markings')).getByRole('button').textContent).toBe('Shown')
    expect(within(displayRow('Labels')).getByRole('button').textContent).toBe('Shown')
  })

  it('Field markings is `situation.show`: it hides the line to gain, and is saved with the play', async () => {
    open(play)
    expect(play.situation.show).toBe(true)
    expect(lineToGain()).not.toBeNull()

    fireEvent.click(displayBtn())
    fireEvent.click(within(displayRow('Field markings')).getByRole('button'))
    await settle()

    expect(lineToGain()).toBeNull()
    expect(within(displayRow('Field markings')).getByRole('button').textContent).toBe('Hidden')
    expect(stored(play).situation.show).toBe(false)
    // The rest of the situation is untouched: it is the same object, one flag.
    expect({ ...stored(play).situation, show: true }).toEqual(play.situation)
  })

  it('Field markings survives a reload', async () => {
    open(play)
    fireEvent.click(displayBtn())
    fireEvent.click(within(displayRow('Field markings')).getByRole('button'))
    await settle()
    cleanup()

    render(<MotionLabEditor repository={createLocalPlayRepository()} />)
    expect(lineToGain()).toBeNull()
    fireEvent.click(displayBtn())
    expect(within(displayRow('Field markings')).getByRole('button').textContent).toBe('Hidden')
  })

  it('Labels still does not survive one - it is this screen, not the play', async () => {
    open(play)
    fireEvent.click(displayBtn())
    fireEvent.click(within(displayRow('Labels')).getByRole('button'))
    await settle()
    cleanup()

    render(<MotionLabEditor repository={createLocalPlayRepository()} />)
    fireEvent.click(displayBtn())
    expect(within(displayRow('Labels')).getByRole('button').textContent).toBe('Shown')
  })
})

describe('the rate pill', () => {
  it('is exactly as ML-UX-2 left it', () => {
    open(play)
    const pill = dock().querySelector('.rate-pill') as HTMLButtonElement
    expect(pill.textContent).toBe('1× ▾')
    expect(pill).toHaveAttribute('title', 'Playback rate')

    fireEvent.click(pill)
    const pop = dock().querySelector('.rate-pop') as HTMLElement
    expect(within(pop).getAllByRole('button').map((b) => b.textContent)).toEqual(['0.5×', '1×', '1.5×'])

    fireEvent.click(within(pop).getByRole('button', { name: '0.5×' }))
    expect(pill.textContent).toBe('0.5× ▾')
    expect(dock().querySelector('.rate-pop')).toBeNull()
  })
})
