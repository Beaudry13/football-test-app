import { describe, expect, it } from 'vitest'
import { FIELD_WIDTH } from './engine/field'
import { newPlay } from './engine/play'
import { ANSWER_SETS, fieldSpots } from './playRep'

/**
 * TAP THE SPOT: answers that are places on the field - his gap, his drop -
 * become spots on HIS side, placed from the play as the coach aligned it.
 */

const MID = FIELD_WIDTH / 2
const answers = (id: string) => ANSWER_SETS.find((s) => s.id === id)!.answers(newPlay('x'))

describe('tap the spot', () => {
  it('gaps sit between that side\'s linemen as aligned - the tight end included', () => {
    const play = newPlay('Base')
    const rightBacker = play.players.find((p) => p.side === 'defense' && p.label === 'LB' && p.x > MID)!
    const spots = fieldSpots(play, answers('gap'), rightBacker.id)!
    // C at MID, RG +1.8, RT +3.6, Y +5.6: A, B, C between them, D outside the Y.
    expect(spots.map((s) => +(s.x - MID).toFixed(2))).toEqual([0.9, 2.7, 4.6, 7.2])
    expect(spots.every((s) => s.y === 1)).toBe(true)
  })

  it('on the other side, with no tight end, an ordinary split stands in for him', () => {
    const play = newPlay('Base')
    const leftBacker = play.players.find((p) => p.side === 'defense' && p.label === 'LB' && p.x < MID)!
    const spots = fieldSpots(play, answers('gap'), leftBacker.id)!
    expect(spots.map((s) => +(MID - s.x).toFixed(2))).toEqual([0.9, 2.7, 4.35, 6.7])
  })

  it('drops are on his side: flat by the sideline, hook inside, curl between, the deep third behind', () => {
    const play = newPlay('Base')
    const corner = play.players.find((p) => p.label === 'CB' && p.x < MID)!
    const [flat, curl, hook, deep] = fieldSpots(play, answers('zone'), corner.id)!
    expect(flat).toEqual({ x: 6, y: 2.5 })
    expect(hook.x).toBeCloseTo(MID - 5)
    expect(curl.x).toBeGreaterThan(flat.x)
    expect(curl.x).toBeLessThan(hook.x)
    expect(deep.y).toBeGreaterThan(curl.y)
    expect(deep.x).toBeCloseTo(FIELD_WIDTH / 6)
  })

  it('answers that are not all places are not spots', () => {
    const play = newPlay('Base')
    expect(fieldSpots(play, ['A gap', 'Rotate down'], null)).toBeNull()
    expect(fieldSpots(play, ['Flat'], null)).toBeNull()
    expect(fieldSpots(play, ['flat', 'HOOK'], null)).toHaveLength(2)
  })
})
