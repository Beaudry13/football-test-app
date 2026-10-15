import { describe, expect, it } from 'vitest'
import { newPlay, type Play } from './engine/play'
import { presnapFrame, presnapOf, presnapTimeline, snapSpots } from './presnap'

/**
 * THE PRE-SNAP MOMENT: the authored motion and nothing else - no route, no
 * ball, no block - run on Motion Lab's own timeline and frozen at the snap.
 */

function withMotion(): Play {
  const play = newPlay('Jet')
  const h = play.players.find((p) => p.label === 'H')!
  h.motion = [{ x: h.x, y: h.y }, { x: h.x - 14, y: h.y }]
  h.path = [{ x: h.x - 14, y: h.y }, { x: h.x - 14, y: 12 }] // his route after the snap
  const x = play.players.find((p) => p.label === 'X')!
  x.path = [{ x: x.x, y: x.y }, { x: x.x, y: 15 }]
  return { ...play, ball: { kind: 'pass', targetId: x.id, catchPoint: { x: x.x, y: 15 } } }
}

describe('the pre-snap moment', () => {
  it('is nothing when nobody moves before the snap', () => {
    expect(presnapOf(newPlay('Still'), null)).toBeNull()
  })

  it('carries alignment and authored motion, never a route, the ball or blocks', () => {
    const play = withMotion()
    const clip = presnapOf(play, 'D9')!
    const h = clip.players.find((p) => p.label === 'H')!
    expect(h.motion).toHaveLength(2)
    expect(h).not.toHaveProperty('path')
    expect(clip.players.find((p) => p.label === 'X')).not.toHaveProperty('path')
    expect(clip).not.toHaveProperty('ball')
    expect(clip).not.toHaveProperty('engagements')
    expect(clip.highlight).toBe('D9')
    expect(JSON.stringify(clip)).not.toContain('catchPoint')
  })

  it('starts on the alignment and freezes with the motion man where his motion ends, at the snap', () => {
    const play = withMotion()
    const clip = presnapOf(play, null)!
    const h0 = play.players.find((p) => p.label === 'H')!
    const line = presnapTimeline(clip)
    const first = presnapFrame(clip, line, line.from).players.find((p) => p.id === h0.id)!
    expect(first.x).toBeCloseTo(h0.x)
    const atSnap = snapSpots(clip).get(h0.id)!
    expect(atSnap.x).toBeCloseTo(h0.x - 14)
    // Nobody else moves before the snap.
    const x0 = play.players.find((p) => p.label === 'X')!
    expect(snapSpots(clip).get(x0.id)!.y).toBeCloseTo(x0.y)
    // The frame never draws a route.
    expect(presnapFrame(clip, line, line.snapAt).players.every((p) => p.path.length === 0)).toBe(true)
  })
})
