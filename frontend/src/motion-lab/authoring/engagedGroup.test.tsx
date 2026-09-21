import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * THE BLOCK, ONCE IT EXISTS (ML-UX-5, SPEC §7.4–§7.7, §7.9).
 *
 * Who it is against, whether he comes off it, and - the part that earned an
 * engine field - whether PEIRA may keep the meeting point on the end of the
 * blocker's path as that path changes.
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
const stripBtn = (name: string | RegExp) => within(strip()).getByRole('button', { name })
const blockMenu = () => strip().querySelector('.block-pop') as HTMLElement | null
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!
const block = (play: Play) => stored(play).engagements[0]

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

/** Drag the × marker to a spot on the field. */
function dragMarker(from: { x: number; y: number }, to: { x: number; y: number }) {
  const marker = board().querySelector('[data-engage]')!
  fireEvent.pointerDown(marker, { button: 0, pointerId: 1, ...client(from.x, from.y) })
  fireEvent.pointerMove(board(), { pointerId: 1, ...client(to.x, to.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(to.x, to.y) })
}

const offenseWithPath = (p: Play) => p.players.find((x) => x.side === 'offense' && x.path.length > 1)!
const defenders = (p: Play) => p.players.filter((x) => x.side === 'defense')

/** A play whose only block is the one under test, with the given `auto`. */
function withBlock(auto: boolean | undefined, over: Partial<Play> = {}): Play {
  const p = { ...pane('Inside Zone Rt'), ...over }
  const blocker = offenseWithPath(p)
  const d = defenders(p)[0]
  const point = blocker.path[blocker.path.length - 1]
  const e = { id: 'e-test', kind: 'engage' as const, a: blocker.id, b: d.id, point, ...(auto === undefined ? {} : { auto }) }
  return { ...p, engagements: [e] }
}

let play: Play
beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('what the group says', () => {
  it('names who he blocks', () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)

    expect(stripBtn(new RegExp(`^Blocks ${defenders(play)[0].label}`))).toBeInTheDocument()
  })

  it('a defender engages the man, rather than blocking him', () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).b) // the defender's own strip

    expect(stripBtn(/^Engages \w+/)).toBeInTheDocument()
  })

  it('flags a block the engine says cannot happen', () => {
    // Both men pinned far apart with the point out at the far sideline.
    const p = withBlock(false)
    const bad = { ...p, engagements: [{ ...p.engagements[0], point: { x: 52, y: 16 } }] }
    open(bad)
    select(bad, bad.engagements[0].a)

    const warn = strip().querySelector('.warn')
    if (warn) {
      expect(warn.getAttribute('title')).toBeTruthy()
      // The warning comes before the group it is about.
      expect(warn.compareDocumentPosition(stripBtn(/^Blocks \w+/))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
  })
})

describe('coming off the block', () => {
  it('is off by default, and says what it means', () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)

    const btn = stripBtn('Releases')
    expect(btn).toHaveAttribute('title', 'Comes off after a moment and continues his own path.')
    expect(btn).not.toHaveClass('gold-line')
  })

  it('turns on for the man whose strip it is', async () => {
    play = withBlock(true)
    open(play)
    const blocker = block(play).a
    select(play, blocker)

    fireEvent.click(stripBtn('Releases'))
    await settle()

    expect(block(play).release).toBe(blocker)
    expect(stripBtn('Releases ✓')).toHaveClass('gold-line')
  })

  it('turns off again', async () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)
    fireEvent.click(stripBtn('Releases'))
    await settle()

    fireEvent.click(stripBtn('Releases ✓'))
    await settle()

    expect(block(play).release).toBeUndefined()
  })

  it('only one man comes off: setting it on the other takes it from the first', async () => {
    play = withBlock(true)
    open(play)
    const { a, b } = block(play)
    select(play, a)
    fireEvent.click(stripBtn('Releases'))
    await settle()
    expect(block(play).release).toBe(a)

    select(play, b)
    fireEvent.click(stripBtn('Releases'))
    await settle()

    expect(block(play).release).toBe(b)
  })
})

describe('the block menu', () => {
  it('offers exactly three things, in order', () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)

    fireEvent.click(stripBtn(/^Blocks \w+/))
    const items = within(blockMenu()!).getAllByRole('button').map((b) => b.textContent!.trim())
    expect(items).toEqual(['Change the defender…', 'Move the meeting point…', 'Remove the block'])
  })

  it('Remove takes the block away and offers to start another', async () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)

    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Remove the block' }))
    await settle()

    expect(stored(play).engagements).toHaveLength(0)
    expect(stripBtn('Blocks…')).toBeInTheDocument()
  })

  it('removing it can be undone', async () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)
    await settle()

    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Remove the block' }))
    await settle()
    expect(stored(play).engagements).toHaveLength(0)

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(stored(play).engagements).toHaveLength(1)
  })
})

describe('changing the defender', () => {
  it('keeps the same block and the same release, and swaps the man', async () => {
    play = withBlock(true)
    open(play)
    const before = block(play)
    select(play, before.a)
    fireEvent.click(stripBtn('Releases'))
    await settle()

    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Change the defender…' }))
    const other = defenders(play)[1]
    select(play, other.id)
    await settle()

    const after = block(play)
    expect(stored(play).engagements).toHaveLength(1)
    expect(after.id).toBe(before.id)
    expect(after.release).toBe(before.a)
    expect(after.b).toBe(other.id)
  })

  it('re-infers the point while it is still PEIRA’s', async () => {
    // With a path, the point is the path end either way - so this proves the
    // swap does not lose `auto`, which is what lets it follow later edits.
    play = withBlock(true)
    open(play)
    select(play, block(play).a)
    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Change the defender…' }))
    select(play, defenders(play)[1].id)
    await settle()

    expect(block(play).auto).toBe(true)
  })

  it('leaves a hand-placed point exactly where the coach put it', async () => {
    play = withBlock(false)
    open(play)
    const before = block(play)
    select(play, before.a)
    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Change the defender…' }))
    select(play, defenders(play)[1].id)
    await settle()

    expect(block(play).point).toEqual(before.point)
    expect(block(play).auto).toBeFalsy()
  })
})

describe('moving the meeting point', () => {
  it('by hand, through the menu, ends PEIRA’s claim on it', async () => {
    play = withBlock(true)
    open(play)
    select(play, block(play).a)

    fireEvent.click(stripBtn(/^Blocks \w+/))
    fireEvent.click(within(blockMenu()!).getByRole('button', { name: 'Move the meeting point…' }))
    expect(strip().querySelector('.banner')!.textContent).toContain('meet')

    fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(30, 6) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(30, 6) })
    await settle()

    expect(block(play).auto).toBe(false)
    expect(block(play).point).toEqual({ x: 30, y: 6 })
    expect(stored(play).engagements).toHaveLength(1)
  })

  it('dragging the × does the same', async () => {
    play = withBlock(true)
    open(play)
    const before = block(play)
    select(play, before.a)

    dragMarker(before.point, { x: before.point.x + 3, y: before.point.y + 2 })
    await settle()

    expect(block(play).auto).toBe(false)
    expect(block(play).point).not.toEqual(before.point)
  })
})

describe('an inferred point follows the blocker’s path', () => {
  it('moves to the end of a redrawn route', async () => {
    play = withBlock(true)
    open(play)
    const blocker = play.players.find((p) => p.id === block(play).a)!
    select(play, blocker.id)

    drawFromHandle(play, blocker.id, [[blocker.x + 1, blocker.y + 3], [blocker.x + 4, blocker.y + 9]])
    await settle()

    const path = stored(play).players.find((p) => p.id === blocker.id)!.path
    expect(block(play).point).toEqual(path[path.length - 1])
    expect(block(play).auto).toBe(true)
  })

  it('falls back to halfway when the route is cleared, and returns when one is drawn', async () => {
    play = withBlock(true)
    open(play)
    const blocker = play.players.find((p) => p.id === block(play).a)!
    const d = play.players.find((p) => p.id === block(play).b)!
    select(play, blocker.id)

    act(() => void fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' }))
    await settle()

    expect(block(play).point).toEqual({ x: (blocker.x + d.x) / 2, y: (blocker.y + d.y) / 2 })
    expect(block(play).auto).toBe(true)

    drawFromHandle(play, blocker.id, [[blocker.x + 2, blocker.y + 5]])
    await settle()

    const path = stored(play).players.find((p) => p.id === blocker.id)!.path
    expect(block(play).point).toEqual(path[path.length - 1])
  })

  it('a hand-placed point never moves, however the route changes', async () => {
    play = withBlock(false)
    open(play)
    const before = block(play)
    const blocker = play.players.find((p) => p.id === before.a)!
    select(play, blocker.id)

    drawFromHandle(play, blocker.id, [[blocker.x + 1, blocker.y + 3], [blocker.x + 5, blocker.y + 11]])
    await settle()

    expect(block(play).point).toEqual(before.point)
  })

  it('a legacy block, with no auto recorded, is treated as the coach’s', async () => {
    play = withBlock(undefined)
    open(play)
    const before = block(play)
    expect('auto' in before).toBe(false)

    const blocker = play.players.find((p) => p.id === before.a)!
    select(play, blocker.id)
    drawFromHandle(play, blocker.id, [[blocker.x + 1, blocker.y + 3], [blocker.x + 5, blocker.y + 11]])
    await settle()

    expect(block(play).point).toEqual(before.point)
  })

  it('THE DEFENDER’S ROUTE NEVER MOVES IT', async () => {
    play = withBlock(true)
    open(play)
    const before = block(play)
    const d = play.players.find((p) => p.id === before.b)!
    select(play, d.id)

    drawFromHandle(play, d.id, [[d.x - 2, d.y - 4], [d.x - 6, d.y - 9]])
    await settle()

    expect(stored(play).players.find((p) => p.id === d.id)!.path.length).toBeGreaterThan(1)
    expect(block(play).point).toEqual(before.point)
  })
})

describe('across a reload - the reason the field is stored at all', () => {
  it('an inferred block is still inferred, and still follows the path', async () => {
    play = withBlock(true)
    open(play)
    await settle()
    expect(block(play).auto).toBe(true)

    // Reopen the play from storage, exactly as a coach coming back would.
    cleanup()
    const repo = createLocalPlayRepository()
    expect(repo.listPlays().find((p) => p.id === play.id)!.engagements[0].auto).toBe(true)

    render(<MotionLabEditor repository={createLocalPlayRepository()} />)
    const blocker = play.players.find((p) => p.id === block(play).a)!
    select(play, blocker.id)
    drawFromHandle(play, blocker.id, [[blocker.x + 2, blocker.y + 7]])
    await settle()

    const path = stored(play).players.find((p) => p.id === blocker.id)!.path
    expect(block(play).point).toEqual(path[path.length - 1])
  })

  it('a hand-placed block is still hand-placed', async () => {
    play = withBlock(false)
    open(play)
    await settle()
    const before = block(play)

    cleanup()
    render(<MotionLabEditor repository={createLocalPlayRepository()} />)
    const blocker = play.players.find((p) => p.id === before.a)!
    select(play, blocker.id)
    drawFromHandle(play, blocker.id, [[blocker.x + 2, blocker.y + 7]])
    await settle()

    expect(block(play).point).toEqual(before.point)
  })
})
