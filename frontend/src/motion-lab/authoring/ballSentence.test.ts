import { describe, expect, it } from 'vitest'
import { ballSentence, catchDepth, fullBallSentence, thenClause } from './ballSentence'
import type { BallAction } from '../engine/ball'
import type { Player } from '../engine/formation'

/**
 * THE BALL, SAID OUT LOUD (SPEC §6.2).
 *
 * Every sentence the dock's ball control can show, and the two things it must
 * never say: "Ball:" (a label, not speech) and "→" (a diagram, not speech).
 */

const p = (id: string, label: string): Player =>
  ({ id, label, side: 'offense', x: 0, y: 0, path: [], timing: 'on-snap', speed: 'normal' }) as unknown as Player

const PLAYERS: Player[] = [p('qb', 'QB'), p('rb', 'RB'), p('h', 'H'), p('z', 'Z'), p('x', 'X')]

const pt = (x: number, y: number) => ({ x, y })

describe('the first action', () => {
  const cases: [string, BallAction | null, string][] = [
    ['nothing set yet', null, 'Set the ball'],
    ['keep', { kind: 'keep' }, 'QB keeps it'],
    ['handoff', { kind: 'handoff', carrierId: 'rb' }, 'Handoff to RB'],
    ['pitch', { kind: 'pitch', targetId: 'h' }, 'Pitch to H'],
    ['pass', { kind: 'pass', targetId: 'z', catchPoint: pt(0, 9) }, 'Pass to Z'],
    [
      'play action',
      { kind: 'play-action', fakeId: 'rb', targetId: 'z', catchPoint: pt(0, 9) },
      'Play action to RB, pass to Z',
    ],
  ]
  it.each(cases)('%s', (_name, action, expected) => {
    expect(ballSentence(action, PLAYERS)).toBe(expected)
  })
})

describe('the second action', () => {
  const cases: [string, BallAction, string][] = [
    ['then handoff', { kind: 'handoff', carrierId: 'x' }, 'then hand off to X'],
    ['then pitch', { kind: 'pitch', targetId: 'h' }, 'then pitch to H'],
    ['then pass', { kind: 'pass', targetId: 'z', catchPoint: pt(0, 5) }, 'then throw to Z'],
  ]
  it.each(cases)('%s', (_name, then, expected) => {
    expect(thenClause(then, PLAYERS)).toBe(expected)
  })

  it('is nothing at all when there is no second action', () => {
    expect(thenClause(null, PLAYERS)).toBeNull()
  })

  it('joins onto the first with a comma', () => {
    expect(fullBallSentence({ kind: 'handoff', carrierId: 'rb' }, { kind: 'pitch', targetId: 'h' }, PLAYERS)).toBe(
      'Handoff to RB, then pitch to H',
    )
    expect(
      fullBallSentence(
        { kind: 'play-action', fakeId: 'rb', targetId: 'z', catchPoint: pt(0, 9) },
        { kind: 'pass', targetId: 'x', catchPoint: pt(0, 4) },
        PLAYERS,
      ),
    ).toBe('Play action to RB, pass to Z, then throw to X')
  })

  it('an unset ball never grows a tail', () => {
    expect(fullBallSentence(null, { kind: 'pitch', targetId: 'h' }, PLAYERS)).toBe('Set the ball')
  })
})

describe('names are the players’ labels', () => {
  it('uses the label, not the id', () => {
    expect(ballSentence({ kind: 'handoff', carrierId: 'rb' }, PLAYERS)).toContain('RB')
    expect(ballSentence({ kind: 'handoff', carrierId: 'rb' }, PLAYERS)).not.toContain('rb"')
  })

  it('a man who is no longer on the field does not crash the sentence', () => {
    expect(ballSentence({ kind: 'pitch', targetId: 'gone' }, PLAYERS)).toBe('Pitch to ?')
  })
})

describe('what a sentence must never contain', () => {
  const every: (BallAction | null)[] = [
    null,
    { kind: 'keep' },
    { kind: 'handoff', carrierId: 'rb' },
    { kind: 'pitch', targetId: 'h' },
    { kind: 'pass', targetId: 'z', catchPoint: pt(0, 9) },
    { kind: 'play-action', fakeId: 'rb', targetId: 'z', catchPoint: pt(0, 9) },
  ]
  const thens: (BallAction | null)[] = [
    null,
    { kind: 'handoff', carrierId: 'x' },
    { kind: 'pitch', targetId: 'h' },
    { kind: 'pass', targetId: 'z', catchPoint: pt(0, 5) },
  ]

  it('never says "Ball:" and never draws an arrow', () => {
    for (const a of every) {
      for (const t of thens) {
        const s = fullBallSentence(a, t, PLAYERS)
        expect(s, s).not.toContain('Ball:')
        expect(s, s).not.toContain('→')
        expect(s, s).not.toContain('->')
      }
    }
  })
})

describe('catch depth, for the Now card', () => {
  it('reads downfield yards off the stored catch point', () => {
    expect(catchDepth({ kind: 'pass', targetId: 'z', catchPoint: pt(12, 9) })).toBe('caught 9 yds downfield')
    expect(catchDepth({ kind: 'play-action', fakeId: 'rb', targetId: 'z', catchPoint: pt(12, 14.4) })).toBe(
      'caught 14 yds downfield',
    )
  })

  it('says behind the line rather than a negative number', () => {
    expect(catchDepth({ kind: 'pass', targetId: 'z', catchPoint: pt(12, -3) })).toBe('caught 3 yds behind the line')
  })

  it('a catch at the line is neither', () => {
    expect(catchDepth({ kind: 'pass', targetId: 'z', catchPoint: pt(12, 0.2) })).toBe('caught at the line')
  })

  it('only passes have a catch depth', () => {
    expect(catchDepth(null)).toBeNull()
    expect(catchDepth({ kind: 'keep' })).toBeNull()
    expect(catchDepth({ kind: 'handoff', carrierId: 'rb' })).toBeNull()
    expect(catchDepth({ kind: 'pitch', targetId: 'h' })).toBeNull()
  })
})
