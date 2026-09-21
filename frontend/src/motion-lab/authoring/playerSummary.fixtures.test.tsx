import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MotionLabEditor } from './MotionLabEditor'
import { createLocalPlayRepository, CURRENT_KEY, PLAYS_KEY } from '../storage/localPlayRepository'
import { gapPlays, panePlays } from '../__characterization__/fixtures'
import { board, installPointerStubs, playerMarker } from '../testing/pointerStubs'
import { U, Y_MAX } from '../engine/field'
import type { Play } from '../engine/play'

/**
 * ML-UX-7's OWN REGRESSION: "verify strings for A–E plays" (SPEC §15).
 *
 * Every player in each play is selected in the real editor, and what the strip
 * says about him is pinned - so this proves the editor hands the summary the
 * right schedule, engagements and ball, not just that the grammar works.
 * Players not listed must read "No assignment yet."
 *
 * THE A–E MAPPING (SPEC §16's test plays, as they exist in the preserved
 * fixtures - nothing was renamed or edited to fit):
 *   A  inside zone        → "Inside Zone Rt"
 *   B  trips out          → "Trips Out"
 *   C  chip and flat      → NO EXACT FIXTURE. The closest is the gap fixture
 *                           "Y chip & release, delayed RB handoff": it has the
 *                           chip-and-release block and delayed timing, but the
 *                           ball is a handoff, not the flat pass.
 *   D  reverse            → "Reverse"
 *   E  look independence  → the plays made from the "Trips Rt" look
 *
 * Each string was produced by the summary and then checked by hand against
 * the rules before being pinned - noun by the §4.2 table, length from the
 * schedule he runs (a block with no release is cut at the block point, hence
 * the 2-yard blockers), a break only at 60° or more, speed only when not his
 * default. The grammar itself is tested from first principles in
 * playerSummary.test.ts; this file pins what a coach actually sees.
 */

installPointerStubs()

const client = (x: number, y: number) => ({ clientX: x * U, clientY: (Y_MAX - y) * U })

function open(play: Play) {
  localStorage.setItem(PLAYS_KEY, JSON.stringify({ v: 1, items: [play] }))
  localStorage.setItem(CURRENT_KEY, play.id)
  render(<MotionLabEditor repository={createLocalPlayRepository()} />)
}

function select(play: Play, id: string) {
  const p = play.players.find((pl) => pl.id === id)!
  fireEvent.pointerDown(playerMarker(id), { button: 0, pointerId: 1, ...client(p.x, p.y) })
  fireEvent.pointerUp(board(), { pointerId: 1, ...client(p.x, p.y) })
}

const summaryEl = () => document.querySelector('.bar.context .strip-summary') as HTMLElement

/** Select each man in turn; return what the strip says, and its tooltip. */
function everySummary(play: Play) {
  open(play)
  const out: Record<string, string> = {}
  for (const p of play.players) {
    select(play, p.id)
    const el = summaryEl()
    expect(el, `${play.name}: no summary for ${p.label}`).not.toBeNull()
    // The visible text may ellipsize; the tooltip always carries all of it.
    expect(el.getAttribute('title')).toBe(el.textContent)
    out[p.id] = el.textContent!
  }
  return out
}

function expectPlay(play: Play, expected: Record<string, string>) {
  const got = everySummary(play)
  const quiet = Object.fromEntries(play.players.filter((p) => !(p.id in expected)).map((p) => [p.id, 'No assignment yet.']))
  expect(got).toEqual({ ...quiet, ...expected })
}

const pane = (id: string) => panePlays().find((p) => p.id === id)!
const gap = (id: string) => gapPlays().find((p) => p.id === id)!

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('A–E: what the strip says about every man', () => {
  it('A · Inside Zone Rt: blocks cut to the block point; engaged defenders with no path say their job', () => {
    expectPlay(pane('play_mu43uoun5um'), {
      O3: 'Path · 2 yds up · blocks NT',
      O4: 'Path · 2 yds up · blocks DE',
      O6: 'Path · 2 yds across',
      O7: 'Path · 12 yds up · gets the handoff',
      D2: 'Engages RG',
      D3: 'Engages RT',
    })
  })

  it('B · Trips Out: a drop, three breaks out/in/back, a non-default speed, the catch', () => {
    expectPlay(pane('play_mu4422if2hx'), {
      O5: 'Route · 16 yds up, then in · fast',
      O6: 'Drop · 4 yds back',
      O8: 'Route · 16 yds up, then out',
      O9: 'Route · 16 yds up, then out',
      O10: 'Route · 16 yds up, then back · catches it 12 yds downfield',
    })
  })

  it('C (closest fixture) · Y chip & release, delayed RB handoff', () => {
    expectPlay(gap('fx_engage_release_delayed'), {
      O5: 'Route · 13 yds up, then out · blocks DE · releases',
      O7: 'Path · 14 yds up · delayed 0.8 s · gets the handoff',
      D3: 'Path · 1 yds back · engages Y',
    })
  })

  it('D · Reverse: the second handoff counts, and a receiver who gets it still runs a Route', () => {
    expectPlay(pane('play_mu442t0j4ki'), {
      O6: 'Path · 2 yds across',
      O7: 'Path · 12 yds across · gets the handoff',
      O10: 'Route · 40 yds across · gets the handoff',
    })
  })

  it('E · the plays made from the Trips Rt look', () => {
    expectPlay(pane('play_mu445m462gk'), { O9: 'Route · 12 yds up' })
    cleanup()
    localStorage.clear()
    expectPlay(pane('play_mu446gpi5us'), { O9: 'Route · 12 yds up' })
    cleanup()
    localStorage.clear()
    expectPlay(pane('play_mu443qt72w5'), { O8: 'Route · 12 yds up' })
  })
})
