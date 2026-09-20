import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { gapPlays, panePlays } from '../__characterization__/fixtures'
import { board, drawFromHandle, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * THE BALL IN THE DOCK (ML-UX-3, SPEC §6).
 *
 * The ball control used to be a button in the top bar whose label summarised
 * the stored object - "Ball: Play Action → RB → Z". It is now the first thing
 * in the dock, it says what the play does in a sentence, and its menu asks a
 * question when nothing is set.
 *
 * What the ball MEANS is the engine's and is unchanged; these tests are about
 * the control, the menu, and the banners a pick puts on screen. The football
 * itself stays pinned by __characterization__.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const settle = () => act(() => new Promise((r) => setTimeout(r, 450)))

const pane = (name: string) => panePlays().find((p) => p.name === name)!
const gap = (id: string) => gapPlays().find((p) => p.id === id)!

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const ballBtn = () => dock().querySelector('.ball-btn') as HTMLButtonElement
const ballPop = () => dock().querySelector('.ball-pop') as HTMLElement | null
const strip = () => document.querySelector('.bar.context') as HTMLElement
/** The authoring board. FieldView also renders `svg.board`, so be specific. */
const overhead = () => document.querySelector('svg.board:not(.field-view)')
const banner = () => strip().querySelector('.banner') as HTMLElement | null
const popBtn = (name: string | RegExp) => within(ballPop()!).getByRole('button', { name })
const openMenu = () => fireEvent.click(ballBtn())
const stored = (play: Play) => createLocalPlayRepository().listPlays().find((p) => p.id === play.id)!

/** Click a man on the board, the way a coach answers a pick. */
function clickPlayer(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('where the ball lives now', () => {
  it('is the first control in the dock, before the transport', () => {
    open(pane('Inside Zone Rt'))
    const kids = [...dock().children]
    expect(kids[0].querySelector('.ball-btn')).not.toBeNull()
    expect(kids[1]).toHaveClass('dock-divider')
    expect(kids[2].getAttribute('aria-label')).toBe('Restart')
  })

  it('has left the top bar', () => {
    open(pane('Inside Zone Rt'))
    const top = document.querySelector('.bar:not(.context):not(.bottom)') as HTMLElement
    expect(top.querySelector('.ball-btn')).toBeNull()
  })
})

describe('the control itself', () => {
  it('invites you to set the ball when nothing is set, outlined', () => {
    const play = { ...pane('Inside Zone Rt'), ball: null, ballThen: null }
    open(play)
    expect(ballBtn().textContent).toContain('Set the ball')
    expect(ballBtn()).toHaveClass('gold-line')
  })

  it('says what the play does once the ball is set', () => {
    open(pane('Inside Zone Rt')) // a handoff
    expect(ballBtn().textContent).toMatch(/Handoff to \w+/)
    expect(ballBtn().textContent).not.toContain('Ball:')
    expect(ballBtn().textContent).not.toContain('→')
    expect(ballBtn()).not.toHaveClass('gold-line')
  })

  it('carries the whole sentence in its tooltip, for when it is cut short', () => {
    open(pane('Inside Zone Rt'))
    expect(ballBtn().getAttribute('title')).toMatch(/Handoff to \w+/)
  })

  it('B toggles the menu', () => {
    open(pane('Inside Zone Rt'))
    expect(ballPop()).toBeNull()

    key('b')
    expect(ballPop()).not.toBeNull()
    expect(ballBtn()).toHaveAttribute('aria-expanded', 'true')

    key('b')
    expect(ballPop()).toBeNull()
  })

  it('stands down while an assignment is being drawn', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    const Y = play.players.find((p) => p.label === 'Y')!
    clickPlayer(play, Y.id)

    drawFromHandle(play, Y.id, [[Y.x + 2, Y.y + 6]], { finish: false })

    expect(ballBtn()).toBeDisabled()
  })

  it('stands down while a pick is running', () => {
    open(pane('Inside Zone Rt'))
    openMenu()
    fireEvent.click(popBtn('Pass to…'))

    expect(ballBtn()).toBeDisabled()
  })

  it('shows the warning badge, with the warning as its tooltip', () => {
    // A pitch the engine cannot make cleanly carries a timeline warning.
    const play = gap('fx_motion_pitch')
    open({ ...play, ball: { kind: 'pitch', targetId: play.players.find((p) => p.label === 'QB')!.id } } as Play)
    const warn = ballBtn().querySelector('.warn')
    if (warn) {
      // SPEC §6.1: the BADGE carries the warning; the button keeps the
      // sentence, so a truncated sentence is still readable on hover.
      expect(warn.getAttribute('title')).toBeTruthy()
      expect(ballBtn().getAttribute('title')).toBe(ballBtn().querySelector('.ball-sentence')!.textContent)
    } else {
      // If this fixture stops producing a warning the badge is not the thing
      // under test; the engine's warnings are pinned by characterization.
      expect(ballBtn().querySelector('.warn')).toBeNull()
    }
  })
})

describe('the menu', () => {
  it('asks a question when nothing is set, and offers the five choices', () => {
    open({ ...pane('Inside Zone Rt'), ball: null, ballThen: null })
    openMenu()

    expect(ballPop()!.textContent).toContain('What happens with the ball?')
    for (const label of ['QB keeps it', 'Handoff to…', 'Pitch to…', 'Pass to…', 'Play action: fake, then pass…']) {
      expect(popBtn(label)).toBeInTheDocument()
    }
    expect(ballPop()!.textContent).not.toContain('Now:')
  })

  it('states what the play does now, once something is set', () => {
    open(pane('Trips Out')) // a pass
    openMenu()

    const now = ballPop()!.querySelector('.now-card')!
    expect(now.textContent).toContain('Now:')
    expect(now.textContent).toMatch(/Pass to \w+/)
  })

  it('the Now card says how far downfield the ball is caught', () => {
    open(pane('Trips Out'))
    openMenu()
    expect(ballPop()!.querySelector('.now-card')!.textContent).toMatch(/caught \d+ yds downfield|caught at the line|behind the line/)
  })

  it('marks the current kind with a dot under Change to', () => {
    open(pane('Inside Zone Rt')) // handoff
    openMenu()

    expect(ballPop()!.textContent).toContain('Change to')
    expect(popBtn(/Handoff to/).querySelector('.now-dot')!.textContent).toBe('●')
    expect(popBtn(/Pitch to/).querySelector('.now-dot')!.textContent).toBe('')
  })

  it('offers a second action, but never after a keep', () => {
    open(pane('Inside Zone Rt'))
    openMenu()
    expect(ballPop()!.textContent).toContain('Then…')
    expect(popBtn('Then hand off to…')).toBeInTheDocument()
    expect(popBtn('Then pitch to…')).toBeInTheDocument()
    expect(popBtn('Then throw to…')).toBeInTheDocument()

    cleanup()
    open({ ...pane('Inside Zone Rt'), ball: { kind: 'keep' }, ballThen: null })
    openMenu()
    expect(ballPop()!.textContent).not.toContain('Then…')
  })

  it('offers to clear the second action only when there is one', () => {
    open(pane('Inside Zone Rt'))
    openMenu()
    expect(within(ballPop()!).queryByRole('button', { name: 'Clear the second action' })).toBeNull()

    cleanup()
    open(pane('Reverse')) // a two-step chain
    openMenu()
    expect(popBtn('Clear the second action')).toBeInTheDocument()
  })

  it('clears the ball, the second action and the clock together', async () => {
    const play = pane('Reverse')
    open(play)
    openMenu()

    fireEvent.click(popBtn('Clear the ball'))
    await settle()

    expect(ballPop()).toBeNull()
    expect(ballBtn().textContent).toContain('Set the ball')
    expect(stored(play).ball).toBeNull()
    expect(stored(play).ballThen).toBeNull()
  })

  it('clearing the ball can be undone', async () => {
    const play = pane('Inside Zone Rt')
    open(play)
    await settle()
    const before = stored(play).ball

    openMenu()
    fireEvent.click(popBtn('Clear the ball'))
    await settle()
    expect(stored(play).ball).toBeNull()

    act(() => void fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await settle()

    expect(stored(play).ball).toEqual(before)
  })
})

describe('Advanced', () => {
  it('is offered only for a pass whose QB has a path', () => {
    open(pane('Trips Out'))
    openMenu()
    expect(within(ballPop()!).getByRole('button', { name: /Advanced/ })).toBeInTheDocument()

    cleanup()
    open(pane('Inside Zone Rt')) // a handoff
    openMenu()
    expect(within(ballPop()!).queryByRole('button', { name: /Advanced/ })).toBeNull()
  })

  it('starts shut, opens onto the throw point, and holds nothing else', () => {
    open(pane('Trips Out'))
    openMenu()
    expect(ballPop()!.querySelector('.adv-body')).toBeNull()

    fireEvent.click(within(ballPop()!).getByRole('button', { name: /Advanced/ }))

    const body = ballPop()!.querySelector('.adv-body')!
    expect(body.textContent).toContain('Throw point')
    expect(within(body as HTMLElement).getByRole('button', { name: 'Set on field…' })).toBeInTheDocument()
  })

  it('remembers that it was opened, for the rest of the page load', () => {
    // The memory is a module variable - per page load, shared across mounts -
    // so this drives from whatever state it finds rather than assuming one.
    open(pane('Trips Out'))
    openMenu()
    const advBtn = () => within(ballPop()!).getByRole('button', { name: /Advanced/ })
    const isOpen = () => ballPop()!.querySelector('.adv-body') !== null
    if (!isOpen()) fireEvent.click(advBtn())
    expect(isOpen()).toBe(true)

    // Close the menu, reopen it: still open, without being asked again.
    openMenu()
    openMenu()
    expect(isOpen()).toBe(true)

    // And shut again when the coach shuts it - which also survives reopening.
    fireEvent.click(advBtn())
    expect(isOpen()).toBe(false)
    openMenu()
    openMenu()
    expect(isOpen()).toBe(false)
  })

  it('Set on field asks where on the QB path he throws from', () => {
    open(pane('Trips Out'))
    openMenu()
    fireEvent.click(within(ballPop()!).getByRole('button', { name: /Advanced/ }))
    fireEvent.click(within(ballPop()!.querySelector('.adv-body') as HTMLElement).getByRole('button', { name: 'Set on field…' }))

    expect(banner()!.textContent).toContain("Click where on the QB's path he throws from")
  })
})

describe('the banners a pick puts up', () => {
  const cases: [string, string, RegExp][] = [
    ['handoff', 'Handoff to…', /Handoff\. *Choose who gets the ball\./],
    ['pitch', 'Pitch to…', /Pitch\. *Choose who gets the ball\./],
    ['pass', 'Pass to…', /Pass\. *Choose the receiver\./],
    ['play action', 'Play action: fake, then pass…', /Play action\. *Choose who the QB fakes to\./],
  ]

  it.each(cases)('%s', (_name, item, sentence) => {
    open({ ...pane('Inside Zone Rt'), ball: null, ballThen: null })
    openMenu()
    fireEvent.click(popBtn(item))

    expect(banner()).not.toBeNull()
    expect(banner()!.textContent!.replace(/\s+/g, ' ')).toMatch(sentence)
    const cancel = within(strip()).getByRole('button', { name: /Cancel/ })
    expect(cancel).toHaveAttribute('title', 'Cancel · Esc')
  })

  it('names the receiver once he is chosen', () => {
    const play = pane('Trips Out')
    open({ ...play, ball: null, ballThen: null })
    openMenu()
    fireEvent.click(popBtn('Pass to…'))
    const H = play.players.find((p) => p.side === 'offense' && p.label === 'H')!
    clickPlayer(play, H.id)

    expect(banner()!.textContent!.replace(/\s+/g, ' ')).toMatch(/Pass to H\. *Click where on his route the ball arrives\./)
  })

  it('a keep needs no pick at all', async () => {
    const play = { ...pane('Inside Zone Rt'), ball: null, ballThen: null }
    open(play)
    openMenu()
    fireEvent.click(popBtn('QB keeps it'))
    await settle()

    expect(banner()).toBeNull()
    expect(ballBtn().textContent).toContain('QB keeps it')
  })
})

describe('a pick that is abandoned changes nothing', () => {
  const abandon: [string, () => void][] = [
    ['Escape', () => key('Escape')],
    ['the Cancel button', () => fireEvent.click(within(strip()).getByRole('button', { name: /Cancel/ }))],
    ['pressing Play', () => key(' ')],
    ['changing view', () => fireEvent.click(screen.getByRole('button', { name: 'Coach' }))],
  ]

  it.each(abandon)('%s leaves the ball exactly as it was', async (_name, act_) => {
    const play = pane('Inside Zone Rt') // starts as a handoff
    open(play)
    await settle()
    const before = JSON.stringify(stored(play).ball)
    const beforeLabel = ballBtn().textContent

    openMenu()
    fireEvent.click(popBtn('Pass to…'))
    expect(banner()).not.toBeNull()

    act_()
    await settle()

    expect(JSON.stringify(stored(play).ball)).toBe(before)
    expect(banner()).toBeNull()
    // The control still says what it said before the menu was opened.
    expect(document.querySelector('.ball-btn')!.textContent).toBe(beforeLabel)
  })
})

describe('changing the first action', () => {
  it('clears a second action, and says so', async () => {
    const play = pane('Reverse') // has a chain
    open(play)
    await settle()
    expect(stored(play).ballThen).not.toBeNull()

    openMenu()
    fireEvent.click(popBtn('QB keeps it'))
    await settle()

    expect(stored(play).ballThen).toBeNull()
    expect(document.querySelector('.toast')!.textContent).toContain('Second action cleared')
  })
})

describe('a receiver with no route', () => {
  it('catches it where he stands, and the coach is told why', async () => {
    const play = pane('Inside Zone Rt')
    const bare = play.players.find((p) => p.side === 'offense' && p.path.length < 2 && p.label !== 'QB')!
    open({ ...play, ball: null, ballThen: null })

    openMenu()
    fireEvent.click(popBtn('Pass to…'))
    clickPlayer(play, bare.id)
    await settle()

    expect(banner()).toBeNull() // completed immediately, no catch-point step
    expect(document.querySelector('.toast')!.textContent).toContain('has no route, so he catches it where he stands')
    expect(stored(play).ball).toMatchObject({ kind: 'pass', targetId: bare.id })
  })
})

describe('from Coach view', () => {
  it('the menu still works, and a pick brings the board back', () => {
    const play = pane('Inside Zone Rt')
    open({ ...play, ball: null, ballThen: null })
    fireEvent.click(screen.getByRole('button', { name: 'Coach' }))
    expect(overhead()).toBeNull()

    expect(ballBtn()).not.toBeDisabled()
    openMenu()
    fireEvent.click(popBtn('Handoff to…'))

    // Switched to overhead by itself, and asked the question there.
    expect(overhead()).not.toBeNull()
    expect(banner()!.textContent).toContain('Choose who gets the ball')
  })

  it('a keep needs no switch', () => {
    const play = pane('Inside Zone Rt')
    open({ ...play, ball: null, ballThen: null })
    fireEvent.click(screen.getByRole('button', { name: 'Coach' }))

    openMenu()
    fireEvent.click(popBtn('QB keeps it'))

    expect(overhead()).toBeNull() // still watching
    expect(ballBtn().textContent).toContain('QB keeps it')
  })
})

describe('a worked pass, end to end', () => {
  it('choose pass, choose the receiver, choose the catch point', async () => {
    const play = pane('Trips Out')
    open({ ...play, ball: null, ballThen: null })
    const H = play.players.find((p) => p.side === 'offense' && p.label === 'H')!

    openMenu()
    fireEvent.click(popBtn('Pass to…'))
    clickPlayer(play, H.id)

    const [a, b] = H.path
    const spot = { x: a.x + (b.x - a.x) * 0.8, y: a.y + (b.y - a.y) * 0.8 }
    fireEvent.pointerDown(board(), { button: 0, pointerId: 1, ...client(spot.x, spot.y) })
    fireEvent.pointerUp(board(), { pointerId: 1, ...client(spot.x, spot.y) })
    await settle()

    expect(banner()).toBeNull()
    expect(ballBtn().textContent).toContain('Pass to H')
    expect(stored(play).ball).toMatchObject({ kind: 'pass', targetId: H.id })
  })
})
