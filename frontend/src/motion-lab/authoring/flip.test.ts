import { describe, expect, it } from 'vitest'
import { FIELD_WIDTH } from '../engine/field'
import { newPlay, type Play } from '../engine/play'
import { flipPlay } from './flip'

/**
 * FLIP THE PLAY: mirrored across the middle of the field - men, routes,
 * motion, catch point, blocks, hash - with the line keeping its names on its
 * sides and three-point stances changing hands.
 */

function sample(): Play {
  const play = newPlay('Trips Jet')
  const x = play.players.find((p) => p.label === 'X')!
  x.path = [{ x: x.x, y: x.y }, { x: x.x, y: 10 }, { x: x.x + 8, y: 12 }]
  const h = play.players.find((p) => p.label === 'H')!
  h.motion = [{ x: h.x, y: h.y }, { x: h.x - 12, y: h.y }]
  const lt = play.players.find((p) => p.label === 'LT')!
  lt.presnapStance = 'OL_3_POINT_LEFT'
  return {
    ...play,
    ball: { kind: 'pass', targetId: x.id, catchPoint: { x: 20, y: 12 }, releasePoint: { x: 26, y: -5 } },
    engagements: [{ id: 'e1', kind: 'engage', a: lt.id, b: play.players.find((p) => p.side === 'defense')!.id, point: { x: 22, y: 0.5 } }],
    situation: { ...play.situation, hash: 'left' },
  }
}

const flipOf = (play: Play) => ({ ...play, ...flipPlay(play) })

describe('Flip the play', () => {
  it('mirrors every man, route and motion across the middle of the field', () => {
    const play = sample()
    const flipped = flipOf(play)
    const x0 = play.players.find((p) => p.label === 'X')!
    const x1 = flipped.players.find((p) => p.id === x0.id)!
    expect(x1.x).toBeCloseTo(FIELD_WIDTH - x0.x)
    expect(x1.path.map((p) => +p.x.toFixed(2))).toEqual(x0.path.map((p) => +(FIELD_WIDTH - p.x).toFixed(2)))
    const h1 = flipped.players.find((p) => p.label === 'H')!
    expect(h1.motion![1].x).toBeCloseTo(FIELD_WIDTH - (play.players.find((p) => p.label === 'H')!.motion![1].x))
  })

  it('flips the hash, the catch and release points and where blocks meet', () => {
    const flipped = flipOf(sample())
    expect(flipped.situation.hash).toBe('right')
    expect(flipped.ball).toMatchObject({ catchPoint: { x: FIELD_WIDTH - 20, y: 12 }, releasePoint: { x: FIELD_WIDTH - 26, y: -5 } })
    expect(flipped.engagements[0].point.x).toBeCloseTo(FIELD_WIDTH - 22)
  })

  it('keeps the line named for its side, and a three-point stance changes hands', () => {
    const play = sample()
    const lt = play.players.find((p) => p.label === 'LT')!
    const flipped = flipOf(play)
    const moved = flipped.players.find((p) => p.id === lt.id)!
    // He is now on the right side of the ball, so he is the right tackle.
    expect(moved.label).toBe('RT')
    expect(moved.presnapStance).toBe('OL_3_POINT_RIGHT')
    // Defense keeps its names.
    expect(flipped.players.filter((p) => p.side === 'defense').map((p) => p.label)).toEqual(
      play.players.filter((p) => p.side === 'defense').map((p) => p.label),
    )
  })

  it('flipped twice is the play it started as', () => {
    const play = sample()
    const twice = flipOf(flipOf(play))
    expect(twice.situation).toEqual(play.situation)
    twice.players.forEach((p, i) => {
      expect(p.label).toBe(play.players[i].label)
      expect(p.x).toBeCloseTo(play.players[i].x)
    })
  })
})
