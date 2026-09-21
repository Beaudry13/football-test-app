/// <reference types="node" />
// File-scoped Node types: the stylesheet is read from disk, as
// motionLabCss.test.ts does (vitest.config.ts sets `css: false`).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * STATES AND MOTION (ML-UX-10, SPEC §15; §4.3, §11.1, §1.4, §14).
 *
 * Keys live in tooltips, not on buttons. Every control takes the same step
 * on hover and goes back to its own idle when pressed; disabled ones do not
 * react. An open menu's button is not gold. The keyboard's focus ring can be
 * seen on gold and is not clipped by a segmented control. Menus fade in.
 *
 * jsdom has no layout and no :hover, so the CSS half of this file reads the
 * real stylesheet: the rules, their values, whether each one out-ranks the
 * prototype rule it overrides, and - through element.matches() - that it
 * actually selects the controls the editor renders. The browser check in the
 * ML-UX-10 report confirms the computed result.
 */

installPointerStubs()

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(resolve(here, '../motionLab.css'), 'utf-8').replace(/\r\n/g, '\n')

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })
const key = (k: string) => act(() => void fireEvent.keyDown(window, { key: k, code: k === ' ' ? 'Space' : k }))
const pane = (name: string) => panePlays().find((p) => p.name === name)!
const byLabel = (play: Play, label: string) => play.players.find((p) => p.label === label)!

/** Inside the root, as MotionLabEditorPage renders it: every rule here is
 *  scoped to it, and element.matches() below has to see the same tree. */
function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(
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
const strip = () => document.querySelector('.bar.context') as HTMLElement
const dock = () => document.querySelector('.bar.bottom') as HTMLElement
const btnIn = (bar: HTMLElement, name: string | RegExp) => within(bar).getByRole('button', { name })
const ballBtn = () => dock().querySelector('.ball-btn') as HTMLButtonElement
const playBtn = () => dock().querySelector('.play-toggle') as HTMLButtonElement

/** A play whose only block is between its first offensive man with a path
 *  and its first defender (engagedGroup.test.tsx's shape). */
function withBlock(): Play {
  const p = pane('Inside Zone Rt')
  const blocker = p.players.find((x) => x.side === 'offense' && x.path.length > 1)!
  const d = p.players.find((x) => x.side === 'defense')!
  return { ...p, engagements: [{ id: 'e-test', kind: 'engage', a: blocker.id, b: d.id, point: blocker.path[blocker.path.length - 1] }] }
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

// ---- the rendered controls ------------------------------------------------

describe('tooltips carry the key (SPEC §11.1)', () => {
  it('top bar: undo, redo, Present', () => {
    open(pane('Inside Zone Rt'))
    expect(btnIn(topBar(), '↶')).toHaveAttribute('title', 'Undo · Ctrl+Z')
    expect(btnIn(topBar(), '↷')).toHaveAttribute('title', 'Redo · Ctrl+Shift+Z')
    expect(btnIn(topBar(), 'Present')).toHaveAttribute('title', 'Hide the tools and teach')
  })

  it('strip: Draw assignment, Redraw (PEIRA\'s own words), Adjust', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    select(play, byLabel(play, 'LT').id) // no route
    expect(btnIn(strip(), /Draw assignment/)).toHaveAttribute('title', 'Draw what he does · D')

    select(play, byLabel(play, 'RB').id) // has one
    expect(btnIn(strip(), 'Redraw')).toHaveAttribute('title', 'Draw it again · D')
    expect(btnIn(strip(), 'Adjust')).toHaveAttribute('title', 'Move the points of his route · E')
  })

  it('dock: restart, play then pause, back, forward, rate', () => {
    open(pane('Inside Zone Rt'))
    expect(btnIn(dock(), 'Restart')).toHaveAttribute('title', 'Restart · R')
    expect(btnIn(dock(), 'Back 0.1 seconds')).toHaveAttribute('title', 'Back 0.1 s · ←')
    expect(btnIn(dock(), 'Forward 0.1 seconds')).toHaveAttribute('title', 'Forward 0.1 s · →')
    expect(dock().querySelector('.rate-pill')).toHaveAttribute('title', 'Playback rate')

    expect(playBtn()).toHaveAttribute('title', 'Play · Space')
    fireEvent.click(playBtn())
    expect(playBtn().textContent).toBe('❚❚ Pause')
    expect(playBtn()).toHaveAttribute('title', 'Pause · Space')
  })

  it('a waiting row\'s Cancel says Esc on the button and in its tooltip', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    select(play, byLabel(play, 'LT').id)
    key('d')
    const cancel = btnIn(strip(), /^Cancel/)
    expect(cancel).toHaveAttribute('title', 'Cancel · Esc')
    expect(cancel.querySelector('.key')!.textContent).toBe('Esc')
  })

  it('Present\'s Draw, off and on', () => {
    open(pane('Inside Zone Rt'))
    fireEvent.click(btnIn(topBar(), 'Present'))
    const draw = () => btnIn(topBar(), '✎ Draw')
    expect(draw()).toHaveAttribute('title', 'Draw on the field while paused')
    fireEvent.click(draw())
    expect(draw()).toHaveAttribute('title', 'Draw on the field while paused · Esc to stop')
  })

  it('Releases', () => {
    const play = withBlock()
    open(play)
    select(play, play.engagements[0].a)
    expect(btnIn(strip(), 'Releases')).toHaveAttribute('title', 'Comes off after a moment and continues his own path.')
  })

  it('the ball keeps its sentence as its tooltip - exactly, with no key on the end', () => {
    const play = pane('Inside Zone Rt')
    open({ ...play, ball: null, ballThen: null } as Play)
    expect(ballBtn()).toHaveAttribute('title', 'Set the ball')
    cleanup()
    localStorage.clear()

    const qb = byLabel(play, 'QB')
    const rb = byLabel(play, 'RB')
    open({ ...play, ball: { kind: 'handoff', carrierId: qb.id, targetId: rb.id } } as Play)
    expect(ballBtn().getAttribute('title')).toBe(ballBtn().querySelector('.ball-sentence')!.textContent)
    expect(ballBtn().getAttribute('title')).not.toMatch(/·\s*B$/)
  })

  it('a warning badge still says exactly what the engine says', () => {
    // A ball with nobody to hold it: the engine's one unconditional warning,
    // and the same sentence the resting strip shows.
    const play = pane('Inside Zone Rt')
    const qb = byLabel(play, 'QB')
    open({
      ...play,
      players: play.players.filter((p) => p.id !== qb.id),
      engagements: play.engagements.filter((e) => e.a !== qb.id && e.b !== qb.id),
      ball: { kind: 'keep' },
      ballThen: null,
    } as Play)

    const warn = ballBtn().querySelector('.warn')!
    expect(warn).not.toBeNull()
    const hint = strip().querySelector('.hint')!.textContent!
    expect(hint.startsWith('Ball: ')).toBe(true)
    expect(warn.getAttribute('title')).toBe(hint.slice('Ball: '.length))
  })

  it('with nobody left to pick, Blocks… names defenders and Engages… names offensive players', () => {
    const p = pane('Inside Zone Rt')
    const offense = p.players.filter((x) => x.side === 'offense')
    const defense = p.players.filter((x) => x.side === 'defense')

    // Offense: two defenders, both taken.
    const d2 = defense.slice(0, 2)
    const noDefenders: Play = {
      ...p,
      players: [...offense, ...d2],
      engagements: d2.map((d, i) => ({ id: `e${i}`, kind: 'engage' as const, a: offense[i].id, b: d.id, point: { x: d.x, y: d.y } })),
    }
    open(noDefenders)
    const freeBlocker = offense.find((o) => !noDefenders.engagements.some((e) => e.a === o.id))!
    select(noDefenders, freeBlocker.id)
    const blocks = btnIn(strip(), 'Blocks…')
    expect(blocks).toBeDisabled()
    expect(blocks).toHaveAttribute('title', 'Every defender is already engaged.')
    cleanup()
    localStorage.clear()

    // Defense: two offensive players, both taken.
    const o2 = offense.slice(0, 2)
    const noOffense: Play = {
      ...p,
      ball: null,
      ballThen: null,
      players: [...o2, ...defense],
      engagements: o2.map((o, i) => ({ id: `e${i}`, kind: 'engage' as const, a: o.id, b: defense[i].id, point: { x: o.x, y: o.y } })),
    } as Play
    open(noOffense)
    const freeDefender = defense.find((d) => !noOffense.engagements.some((e) => e.b === d.id))!
    select(noOffense, freeDefender.id)
    const engages = btnIn(strip(), 'Engages…')
    expect(engages).toBeDisabled()
    expect(engages).toHaveAttribute('title', 'Every offensive player is already engaged.')
  })
})

describe('keys belong in tooltips, not on buttons (DESIGN §18)', () => {
  it('Play and Pause carry no Space badge', () => {
    open(pane('Inside Zone Rt'))
    expect(playBtn().querySelector('.key')).toBeNull()
    expect(playBtn().textContent).toBe('▶ Play')
    fireEvent.click(playBtn())
    expect(playBtn().querySelector('.key')).toBeNull()
    expect(playBtn().textContent).toBe('❚❚ Pause')
  })

  it('the ball carries no B badge', () => {
    open(pane('Inside Zone Rt'))
    expect(ballBtn().querySelector('.key')).toBeNull()
    // The football, the sentence, and the warning badge if there is one.
    const warn = ballBtn().querySelector('.warn')?.textContent ?? ''
    expect(ballBtn().textContent!.trim()).toBe(`🏈 ${ballBtn().querySelector('.ball-sentence')!.textContent}${warn}`)
  })

  it('Esc stays on Cancel, and Delete beside Clear assignment', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    select(play, byLabel(play, 'RB').id)
    fireEvent.click(btnIn(strip(), /^More/))
    const clear = within(document.querySelector('.more-pop') as HTMLElement).getByRole('button', { name: /Clear assignment/ })
    expect(clear.querySelector('.key')!.textContent).toBe('Delete')
  })
})

// ---- the stylesheet ---------------------------------------------------------

interface Rule {
  selectors: string[]
  body: string
  media: string | null
  index: number
}
/** Every rule, @media flattened (remembering which), @keyframes kept whole. */
function parse(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  const walk = (src: string, media: string | null) => {
    let i = 0
    while (i < src.length) {
      const openAt = src.indexOf('{', i)
      if (openAt === -1) break
      let depth = 0
      let end = openAt
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++
        else if (src[end] === '}' && --depth === 0) break
      }
      const prelude = src.slice(i, openAt).trim()
      const body = src.slice(openAt + 1, end)
      if (prelude.startsWith('@media')) walk(body, prelude)
      else out.push({ selectors: prelude.startsWith('@') ? [prelude] : prelude.split(',').map((s) => s.trim()), body, media, index: out.length })
      i = end + 1
    }
  }
  walk(text, null)
  return out
}
const RULES = parse(CSS)
/** Index of the first rule below the PEIRA ADDITIONS marker. */
const MARKER = parse(CSS.slice(0, CSS.lastIndexOf('/*', CSS.indexOf('==== PEIRA ADDITIONS')))).length

/** The LAST rule naming exactly this selector (outside @media unless asked). */
function rule(selector: string, media: string | null = null): Rule {
  const hits = RULES.filter((r) => r.selectors.includes(selector) && r.media === media)
  if (!hits.length) throw new Error(`no rule for ${selector}`)
  return hits[hits.length - 1]
}
const decl = (r: Rule, prop: string) => r.body.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`))?.[1].trim()

/** Selector specificity, enough for these selectors: ids, classes /
 *  attributes / pseudo-classes (a :not() counts as its argument), elements. */
function specificity(selector: string): [number, number, number] {
  const s = selector.replace(/:not\(([^)]*)\)/g, ' $1')
  const ids = (s.match(/#[\w-]+/g) ?? []).length
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const elements = (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return [ids, classes, elements]
}
const cmp = (a: number[], b: number[]) => a.map((v, i) => v - b[i]).find((d) => d !== 0) ?? 0
/** Does `a` win over `b` when both match: specificity, then source order. */
function wins(a: string, b: string) {
  const c = cmp(specificity(a), specificity(b))
  return c > 0 || (c === 0 && rule(a).index > rule(b).index)
}

const R = '.motion-lab-root'
const PLAIN = `${R} button:not(:disabled):not(.active):not(.primary)`
const OPEN = `${R} button.active[aria-expanded='true']`

describe('the state tokens (SPEC §4.3)', () => {
  const root = RULES.filter((r) => r.selectors.includes(R) && /(^|;)\s*--[\w-]+\s*:/.test(r.body.trim()))
  const token = (name: string) => {
    for (const r of [...root].reverse()) {
      const v = decl(r, name)
      if (v) return v
    }
    throw new Error(`no token ${name}`)
  }
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

  it('are declared on the root, below the marker, and never on :root', () => {
    expect(root.length).toBe(2)
    expect(root[1].index).toBeGreaterThan(MARKER)
    expect(token('--btn')).toBe('#1e2126')
    expect(token('--btn-hover')).toBe('#262a30')
  })

  it('the primary\'s hover and pressed are the gold mixed with the panel, 92% and 85% - darker, not lighter', () => {
    const gold = rgb(token('--accent'))
    const panel = rgb(token('--panel'))
    for (const [name, w] of [['--accent-hover', 0.92], ['--accent-pressed', 0.85]] as const) {
      const got = rgb(token(name))
      const want = gold.map((g, i) => g * w + panel[i] * (1 - w))
      got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(1))
      expect(got.reduce((a, b) => a + b)).toBeLessThan(gold.reduce((a, b) => a + b))
    }
  })
})

describe('every control takes the same step', () => {
  it('plain: idle, hover one step lighter, pressed back to idle', () => {
    expect(decl(rule(`${R} button`), 'background')).toBe('var(--btn)')
    expect(decl(rule(`${PLAIN}:hover`), 'background')).toBe('var(--btn-hover)')
    expect(decl(rule(`${PLAIN}:active`), 'background')).toBe('var(--btn)')
    // ...and each beats what it replaces.
    expect(rule(`${R} button`).index).toBeGreaterThan(MARKER)
    expect(wins(`${PLAIN}:hover`, `${R} button:hover`)).toBe(true)
    expect(wins(`${PLAIN}:hover`, `${R} .popover button:hover`)).toBe(true)
    expect(wins(`${PLAIN}:active`, `${PLAIN}:hover`)).toBe(true)
  })

  it('reaches the controls it should, and leaves gold ones alone', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    select(play, byLabel(play, 'RB').id)
    const more = btnIn(strip(), /^More/)
    const chosen = strip().querySelector('.seg button.active') as HTMLElement // the Timing he has
    expect(more.matches(PLAIN)).toBe(true)
    expect(btnIn(strip(), 'Redraw').matches(PLAIN)).toBe(true)
    expect(chosen.matches(PLAIN)).toBe(false)
    expect(playBtn().matches(PLAIN)).toBe(false)
  })

  it('menu rows go back to the menu when pressed, and the current row keeps its tint', () => {
    expect(decl(rule(`${R} .popover button:not(:disabled):not(.active):active`), 'background')).toBe('transparent')
    expect(wins(`${R} .popover button:not(:disabled):not(.active):active`, `${PLAIN}:active`)).toBe(true)
    expect(decl(rule(`${R} .popover button.play-row.active:hover`), 'background')).toBe('#2a2412')
    expect(wins(`${R} .popover button.play-row.active:hover`, `${R} .popover button:hover`)).toBe(true)
  })

  it('the Situation and Display segments leave the prototype\'s old idle behind', () => {
    const r = rule(`${R} .sit-row .seg button:not(.active)`)
    expect(r.index).toBeGreaterThan(MARKER)
    expect(decl(r, 'background')).toBe('var(--btn)')
    expect(wins(`${PLAIN}:hover`, `${R} .sit-row .seg button:not(.active)`)).toBe(true)
  })

  it('disabled is 40% and does not answer the pointer, whatever kind of button it is', () => {
    expect(decl(rule(`${R} button:disabled`), 'opacity')).toBe('0.4')
    expect(decl(rule(`${R} button:disabled:hover`), 'background')).toBe('var(--btn)')
    expect(decl(rule(`${R} button.primary:disabled:hover`), 'background')).toBe('var(--accent)')
    expect(decl(rule(`${R} .ball-btn.has-action:disabled:hover`), 'background')).toBe('#2a2412')
    expect(decl(rule(`${R} button.gold-line:disabled:hover`), 'background')).toBe('transparent')
    expect(decl(rule(`${R} .popover button:disabled:hover`), 'background')).toBe('transparent')
    expect(wins(`${R} button:disabled:hover`, `${R} button:hover`)).toBe(true)
    expect(wins(`${R} button.primary:disabled:hover`, `${R} button.primary:hover`)).toBe(true)
    expect(wins(`${R} .popover button:disabled:hover`, `${R} .popover button:hover`)).toBe(true)

    // A button with no history is disabled, and none of the hover steps reach it.
    open(pane('Inside Zone Rt'))
    const undo = btnIn(topBar(), '↶')
    expect(undo).toBeDisabled()
    expect(undo.matches(PLAIN)).toBe(false)
  })

  it('the primary darkens on hover and further when pressed, and stays opaque', () => {
    const hover = rule(`${R} button.primary:not(:disabled):hover`)
    const pressed = rule(`${R} button.primary:not(:disabled):active`)
    expect(decl(hover, 'background')).toBe('var(--accent-hover)')
    expect(decl(pressed, 'background')).toBe('var(--accent-pressed)')
    expect(`${hover.body}${pressed.body}`).not.toMatch(/opacity/)
    expect(wins(`${R} button.primary:not(:disabled):hover`, `${R} button.primary:hover`)).toBe(true)

    open(pane('Inside Zone Rt'))
    expect(playBtn().matches(`${R} button.primary:not(:disabled)`)).toBe(true)
  })

  it('gold-line answers the pointer now, and stays gold-line', () => {
    const hover = rule(`${R} button.gold-line:not(:disabled):not(.active):hover`)
    expect(decl(hover, 'background')).toBe('var(--btn-hover)')
    // Only the fill: the outline and the words are its own rule's.
    expect(hover.body).not.toMatch(/border|color:/)
    expect(wins(`${R} button.gold-line:not(:disabled):not(.active):hover`, `${R} .bar button.gold-line`)).toBe(true)
    expect(decl(rule(`${R} button.gold-line:not(:disabled):not(.active):active`), 'background')).toBe('transparent')

    open(pane('Inside Zone Rt'))
    expect(btnIn(topBar(), 'Present').matches(`${R} button.gold-line:not(:disabled):not(.active)`)).toBe(true)
  })
})

/** The nine menus, each opened the way a coach opens it. */
const MENUS: { name: string; setup: () => HTMLElement }[] = [
  { name: 'play', setup: () => { open(pane('Inside Zone Rt')); return topBar().querySelector('.play-btn') as HTMLElement } },
  { name: 'Formation', setup: () => { open(pane('Inside Zone Rt')); return btnIn(strip(), /^Formation/) } },
  {
    name: 'More',
    setup: () => {
      const play = pane('Inside Zone Rt')
      open(play)
      select(play, byLabel(play, 'RB').id)
      return btnIn(strip(), /^More/)
    },
  },
  {
    name: 'Blocks',
    setup: () => {
      const play = withBlock()
      open(play)
      select(play, play.engagements[0].a)
      return btnIn(strip(), /^Blocks \w+/)
    },
  },
  { name: 'Ball', setup: () => { open(pane('Inside Zone Rt')); return ballBtn() } },
  { name: 'rate', setup: () => { open(pane('Inside Zone Rt')); return dock().querySelector('.rate-pill') as HTMLElement } },
  { name: 'Situation', setup: () => { open(pane('Inside Zone Rt')); return dock().querySelector('.sit-chip') as HTMLElement } },
  { name: 'Display', setup: () => { open(pane('Inside Zone Rt')); return btnIn(dock(), /^Display/) } },
  {
    name: 'Change',
    setup: () => {
      const play = pane('Inside Zone Rt')
      open(play)
      fireEvent.click(btnIn(topBar(), 'Player'))
      select(play, byLabel(play, 'FS').id)
      return btnIn(strip(), 'Change ▾')
    },
  },
]

describe('an open menu\'s button is not gold (SPEC §1.4)', () => {
  it('while open it takes the hover tone, in its own ink', () => {
    const r = rule(OPEN)
    expect(decl(r, 'background')).toBe('var(--btn-hover)')
    expect(decl(r, 'border-color')).toBe('var(--border)')
    expect(decl(r, 'color')).toBe('var(--text)')
    expect(wins(OPEN, `${R} button.active`)).toBe(true)
    expect(wins(OPEN, `${R} .bar button.gold-line`)).toBe(true)
    // Gold-line (Set the ball) keeps its outline and words while its menu is open.
    const goldOpen = rule(`${R} button.gold-line.active[aria-expanded='true']`)
    expect([decl(goldOpen, 'border-color'), decl(goldOpen, 'color')]).toEqual(['var(--accent)', 'var(--accent)'])
  })

  it.each(MENUS)('$name: the rule reaches its button while open, and lets go when it closes', ({ setup }) => {
    const trigger = setup()
    expect(trigger.matches(OPEN)).toBe(false)
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger.matches(OPEN)).toBe(true)
    key('Escape')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger.matches(OPEN)).toBe(false)
  })

  it('a chosen segment is still gold: it is not a menu', () => {
    open(pane('Inside Zone Rt'))
    const overhead = btnIn(topBar(), 'Overhead')
    expect(overhead).toHaveClass('active')
    expect(overhead.matches(OPEN)).toBe(false)
  })
})

describe('the keyboard\'s focus ring', () => {
  it('is Motion Lab\'s own: gold, 2 px, clear of the control - and out-ranks PEIRA\'s currentColor ring', () => {
    const r = rule(`${R} :focus-visible`)
    expect(decl(r, 'outline')).toBe('2px solid var(--accent)')
    expect(decl(r, 'outline-offset')).toBe('2px')
    expect(cmp(specificity(`${R} :focus-visible`), specificity(':focus-visible'))).toBeGreaterThan(0)
    // Nothing in Motion Lab rings in currentColor, and nothing styles plain :focus.
    expect(RULES.filter((x) => /outline[^;]*currentColor/i.test(x.body))).toEqual([])
    expect(RULES.flatMap((x) => x.selectors).filter((s) => /:focus(?!-visible)/.test(s))).toEqual([])
  })

  it('is drawn inside a segment, where .seg would clip it - in ink on the chosen one', () => {
    expect(decl(rule(`${R} .seg button:focus-visible`), 'outline-offset')).toBe('-2px')
    expect(decl(rule(`${R} .seg button.active:focus-visible`), 'outline-color')).toBe('var(--accent-ink)')
    expect(decl(rule(`${R} .seg`), 'overflow')).toBe('hidden') // why

    const play = pane('Inside Zone Rt')
    open(play)
    select(play, byLabel(play, 'RB').id)
    for (const b of [btnIn(topBar(), '↶'), btnIn(topBar(), 'Overhead'), strip().querySelector('.seg button.active') as HTMLElement]) {
      expect(b.matches(`${R} .seg button`)).toBe(true)
    }
    expect(playBtn().matches(`${R} .seg button`)).toBe(false) // Play keeps the outside ring
  })
})

describe('menus fade in (120 ms), and only in', () => {
  it('one animation on every .popover, opacity only, switched off for reduced motion', () => {
    expect(decl(rule(`${R} .popover`), 'animation')).toBe('motion-lab-popover-in 120ms ease-out')
    const frames = RULES.find((r) => r.selectors[0] === '@keyframes motion-lab-popover-in')!
    expect(frames.body.replace(/\s+/g, ' ').trim()).toBe('from { opacity: 0; } to { opacity: 1; }')
    expect(decl(rule(`${R} .popover`, '@media (prefers-reduced-motion: reduce)'), 'animation')).toBe('none')
  })

  it.each(MENUS)('$name: its menu is a .popover, and it is gone the moment it closes', ({ setup }) => {
    const trigger = setup()
    const before = document.querySelectorAll('.popover').length
    fireEvent.click(trigger)
    const pops = [...document.querySelectorAll('.popover')]
    expect(pops.length).toBe(before + 1)
    expect(pops.every((p) => p.matches(`${R} .popover`))).toBe(true)
    key('Escape')
    // No closing animation: nothing lingers to fade out.
    expect(document.querySelectorAll('.popover').length).toBe(before)
  })
})

describe('what did not move, and what did', () => {
  it('Present is still gold-line and the strip chip still not a button; no button is named for its key any more', () => {
    const play = pane('Inside Zone Rt')
    open(play)
    expect(btnIn(topBar(), 'Present')).toHaveClass('gold-line')
    select(play, byLabel(play, 'RB').id)
    expect(strip().querySelector('.chip-static')!.tagName).toBe('SPAN')
    expect(screen.queryAllByRole('button', { name: /Space|^B$/ })).toEqual([])
  })
})
