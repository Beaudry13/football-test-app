import { describe, expect, it } from 'vitest'
import { newPlay, type Play } from './engine/play'
import { freezeSpots, momentsFor, presnapFrame, presnapOf, presnapTimeline, snapSpots } from './presnap'

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

describe('the decision moment', () => {
  it('offers the moments the authored play has - after the snap only when someone moves after it', () => {
    const play = withMotion()
    expect(momentsFor(play)).toEqual(['before', 'mid', 'snap', 'after'])
    const noRoutes = { ...play, players: play.players.map((p) => ({ ...p, path: [] })) }
    expect(momentsFor(noRoutes)).toEqual(['before', 'mid', 'snap'])
    expect(momentsFor(newPlay('Still'))).toEqual([])
  })

  it('before motion is the alignment, with no trail giving the motion away', () => {
    const play = withMotion()
    const h = play.players.find((p) => p.label === 'H')!
    const clip = presnapOf(play, null, 'before')!
    expect(freezeSpots(clip).get(h.id)!.x).toBeCloseTo(h.x)
    const line = presnapTimeline(clip)
    expect(presnapFrame(clip, line, line.freezeAt).players.find((p) => p.id === h.id)!.motion).toBeUndefined()
  })

  it('mid-motion freezes halfway along the authored motion', () => {
    const play = withMotion()
    const h = play.players.find((p) => p.label === 'H')!
    const clip = presnapOf(play, null, 'mid')!
    const line = presnapTimeline(clip)
    expect(line.freezeAt).toBeGreaterThan(line.firstMove)
    expect(line.freezeAt).toBeLessThan(line.snapAt)
    const at = freezeSpots(clip).get(h.id)!
    expect(at.x).toBeLessThan(h.x)
    expect(at.x).toBeGreaterThan(h.x - 14)
  })

  it('after the snap carries the engine\'s own beat - and nothing past it', () => {
    const play = withMotion()
    const x = play.players.find((p) => p.label === 'X')!
    const clip = presnapOf(play, null, 'after')!
    expect(clip.freeze).toBe('after')
    const xs = clip.after!.samples.find((s) => s.id === x.id)!
    // 0.8 s in tenths: 9 samples, and the man has only begun his route.
    expect(xs.pts).toHaveLength(9)
    expect(xs.pts[8].y).toBeGreaterThan(x.y)
    expect(xs.pts[8].y).toBeLessThan(15)
    expect(freezeSpots(clip).get(x.id)!.y).toBeCloseTo(xs.pts[8].y)
    // Men who do not move after the snap carry nothing.
    expect(clip.after!.samples.every((s) => play.players.find((p) => p.id === s.id)!.path.length >= 2)).toBe(true)
  })
})

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
