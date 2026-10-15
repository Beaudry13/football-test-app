import { describe, expect, it } from 'vitest'
import { newPlay } from './engine/play'
import { IMAGE_HEIGHT, IMAGE_WIDTH, playerAt, px, U } from './playImageLayout'

/** Where a man sits in the play picture, and which man a tap on it lands on. */
describe('the play picture layout', () => {
  it('is the 1376 x 720 picture quiz questions use', () => {
    expect([IMAGE_WIDTH, IMAGE_HEIGHT]).toEqual([1376, 720])
  })

  it('finds the man under a tap - the nearest within reach - and nobody on open grass', () => {
    const play = newPlay('Jet Dig')
    const x = play.players.find((p) => p.label === 'X')!
    expect(playerAt(play, { x: px(x).x + 0.8 * U, y: px(x).y })).toBe(x.id)
    expect(playerAt(play, { x: px(x).x, y: px(x).y - 4 * U })).toBeNull()
    // In the crowded box, the closest man wins.
    const c = play.players.find((p) => p.label === 'C')!
    expect(playerAt(play, px(c))).toBe(c.id)
  })
})
