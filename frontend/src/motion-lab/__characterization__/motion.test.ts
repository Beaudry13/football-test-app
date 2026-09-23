import { describe, expect, it } from 'vitest'
import { derive } from './capture'
import { engineUnderTest } from './engineUnderTest'
import { posAt, resolveEnd, buildSchedule } from '../engine/timeline'
import { projectOntoPath, projectOntoRoute } from '../engine/ball'
import { orientationAt } from '../engine/orientation'
import { initialPlayers, type Player } from '../engine/formation'
import { newPlay, sanitizePlay, type Play } from '../engine/play'
import type { Pt } from '../engine/geometry'
import type { Engagement } from '../engine/interactions'
import { panePlays } from './fixtures'

/**
 * PEIRA'S OWN FIXTURES FOR MOTION (P3.4, approved divergence 3).
 *
 * The prototype never had pre-snap motion AND a route on one man, so none of
 * the preserved goldens can speak for it - and none of them may be
 * regenerated to make room. These fixtures are built here, in code, and pin
 * the behaviour the owner approved:
 *
 *   PRE-SNAP MOTION -> SNAP -> POST-SNAP ROUTE, one line, one speed.
 *
 * Motion ends AT the snap; the longest one sets the snap and shorter ones
 * start later; a delayed route waits at the snap point; anything post-snap
 * (a catch, a throw, a block, its release) is projected onto the ROUTE only.
 */

const near = (a: Pt, b: Pt, tol = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < tol
const H_ID = 'O9' // "H" in the default formation, at (38, -1.6)

/** The default 22, with H given motion and a route. */
function withH(motion: Pt[] | undefined, path: Pt[], patch: Partial<Player> = {}): Player[] {
  return initialPlayers().map((p) => (p.id === H_ID ? { ...p, path, ...(motion ? { motion } : null), timing: 'on-snap' as const, ...patch } : p))
}
function play(players: Player[], extra: Partial<Play> = {}): Play {
  return { ...newPlay('fixture', players), players, ...extra }
}
const H = (ps: Player[]) => ps.find((p) => p.id === H_ID)!

// A jet across the formation to just behind the right tackle, then a wheel.
const JET: Pt[] = [{ x: 38, y: -1.6 }, { x: 31, y: -1.6 }]
const WHEEL: Pt[] = [{ x: 31, y: -1.6 }, { x: 35, y: -2.5 }, { x: 44, y: 2 }, { x: 46, y: 14 }]

describe('jet motion, then a wheel', () => {
  const players = withH(JET, WHEEL)
  const d = derive(engineUnderTest, play(players))
  const s = d.schedule.get(H_ID)!

  it('is one stitched line whose first part is the motion', () => {
    expect(s.preLength).toBeCloseTo(7, 6)
    expect(near(s.pts[0], JET[0])).toBe(true)
    expect(near(s.pts[s.pts.length - 1], WHEEL[WHEEL.length - 1])).toBe(true)
  })

  it('ends the motion exactly at the snap, where the route begins', () => {
    expect(near(posAt(d.schedule, H(players), d.built.snapAt), JET[1], 1e-6)).toBe(true)
  })

  it('is moving across the formation before the snap', () => {
    const mid = posAt(d.schedule, H(players), d.built.snapAt - 0.3)
    expect(mid.x).toBeGreaterThan(31)
    expect(mid.x).toBeLessThan(38)
    expect(mid.y).toBeCloseTo(-1.6, 6)
  })

  it('runs the wheel after the snap, at the same speed', () => {
    const later = posAt(d.schedule, H(players), d.built.snapAt + 1)
    expect(later.y).toBeGreaterThan(-3)
    expect(later.x).toBeGreaterThan(31)
    expect(s.speed).toBe(8.5) // H's default: fast, both phases
  })

  it('sets the snap from the motion, the way a legacy pre-snap path always did', () => {
    // 7 yards at 8.5 yd/s is under the 2 s window, so the window stands.
    expect(d.built.snapAt).toBeCloseTo(2.0, 6)
  })
})

describe('the snap waits for the longest motion, and every motion ends on it', () => {
  const players = initialPlayers().map((p) => {
    if (p.id === H_ID) return { ...p, motion: [{ x: 38, y: -1.6 }, { x: 12, y: -1.6 }] } // 26 yd: longer than the window
    if (p.id === 'O10') return { ...p, motion: [{ x: 46, y: -1.6 }, { x: 43, y: -1.6 }] } // Z: 3 yd
    return p
  })
  const d = derive(engineUnderTest, play(players))

  it('snaps when the longest motion finishes', () => {
    expect(d.built.snapAt).toBeCloseTo(26 / 8.5 + 0.3, 6)
  })

  it('starts the shorter motion later, so both finish at the snap', () => {
    const h = d.schedule.get(H_ID)!
    const z = d.schedule.get('O10')!
    expect(z.start).toBeGreaterThan(h.start)
    const at = (id: string) => posAt(d.schedule, players.find((p) => p.id === id)!, d.built.snapAt)
    expect(near(at(H_ID), { x: 12, y: -1.6 })).toBe(true)
    expect(near(at('O10'), { x: 43, y: -1.6 })).toBe(true)
  })

  it('a motion with no route yet settles where the snap caught him', () => {
    const z = players.find((p) => p.id === 'O10')!
    expect(resolveEnd(z, d.schedule.get('O10')!)).toBe('settle')
    expect(near(posAt(d.schedule, z, d.built.snapAt + 3), { x: 43, y: -1.6 })).toBe(true)
  })
})

describe('a delayed route waits at the snap point (case B)', () => {
  const players = withH(JET, WHEEL, { timing: 'delayed', delay: 0.6 })
  const d = derive(engineUnderTest, play(players))

  it('stands at the end of his motion for the delay, then runs', () => {
    const at = (t: number) => posAt(d.schedule, H(players), t)
    expect(near(at(d.built.snapAt), JET[1])).toBe(true)
    expect(near(at(d.built.snapAt + 0.5), JET[1])).toBe(true)
    expect(near(at(d.built.snapAt + 0.9), JET[1])).toBe(false)
  })

  it('uses the schedule\'s one pause for it', () => {
    expect(d.schedule.get(H_ID)!.hold).toEqual({ from: d.built.snapAt, until: d.built.snapAt + 0.6 })
  })
})

describe('the ball meets him where he actually is', () => {
  it('jet motion, snap, handoff: the carry starts on HIS scheduled position', () => {
    // Jet just behind the QB's feet at the snap, then on across the formation.
    const players = withH([{ x: 38, y: -3.4 }, { x: 28, y: -3.4 }], [{ x: 28, y: -3.4 }, { x: 18, y: -3.4 }, { x: 10, y: 2 }])
    const d = derive(engineUnderTest, play(players, { ball: { kind: 'handoff', carrierId: H_ID } }))
    expect(d.ballTimeline.chain?.carrierId).toBe(H_ID)
    const t = d.ballTimeline.chain!.time + 0.05
    const frame = d.ballTimeline.at(t)
    expect(frame.carrierId).toBe(H_ID)
    const him = posAt(d.schedule, H(players), t)
    expect(frame.pos.x).toBeCloseTo(him.x + 0.7, 6) // HOLD: tucked just beside the marker
    expect(frame.pos.y).toBeCloseTo(him.y, 6)
    // And the handoff happens after the snap, on the route - not in motion.
    expect(d.ballTimeline.chain!.time).toBeGreaterThan(d.built.snapAt)
  })

  it('motion, then a pass: the catch is projected onto the ROUTE, never the motion', () => {
    const players = withH(JET, WHEEL)
    // Ask for the catch right on top of his MOTION - the nearest point of his
    // whole line - to prove it cannot be caught there.
    const onMotion = { x: 34.5, y: -1.6 }
    const d = derive(engineUnderTest, play(players, { ball: { kind: 'pass', targetId: H_ID, catchPoint: onMotion } }))
    const s = d.drawnSchedule.get(H_ID)!
    const catchAt = d.ballTimeline.requestedCatch!
    // The spot asked for sits ON the motion line, so a projection over the
    // whole line would return it unchanged. Over the route only, it cannot.
    expect(s.preLength).toBeGreaterThan(0)
    const whole = projectOntoPath(s.pts, s.cum, onMotion)
    const route = projectOntoRoute(s, onMotion)
    expect(whole.along).toBeLessThan(s.preLength!) // the bug this guards against
    expect(route.along).toBeGreaterThanOrEqual(s.preLength! - 1e-9)
    expect(near(route.pt, catchAt, 1e-6)).toBe(true)
  })

  it('the throw point is projected onto his route, not his motion', () => {
    // A QB with motion is rare but legal; his throw point must still be a
    // post-snap spot.
    const QB = 'O6'
    const players = initialPlayers().map((p) =>
      p.id === QB
        ? { ...p, motion: [{ x: 26.665, y: -2.4 }, { x: 26.665, y: -5 }], path: [{ x: 26.665, y: -5 }, { x: 26.665, y: -8 }] }
        : p,
    )
    const pass = { kind: 'pass' as const, targetId: 'O8', catchPoint: { x: 8, y: 10 }, releasePoint: { x: 26.665, y: -3.5 } } // on the MOTION
    const d = derive(engineUnderTest, play(players, { ball: pass }))
    const s = d.drawnSchedule.get(QB)!
    // He cannot throw before the snap, whatever point was asked for.
    const released = d.ballTimeline.at(d.ballTimeline.end)
    expect(released).toBeDefined()
    expect(d.ballTimeline.releasePoint!.y).toBeLessThanOrEqual(-5 + 1e-6)
    expect(s.preLength).toBeCloseTo(2.6, 6)
  })
})

describe('blocks project onto the route (cases A and C)', () => {
  const blocker = (motion: Pt[] | undefined, path: Pt[]) =>
    initialPlayers().map((p) => (p.id === 'O5' ? { ...p, ...(motion ? { motion } : null), path } : p)) // Y
  const Y_MOTION: Pt[] = [{ x: 32.265, y: -0.8 }, { x: 24, y: -0.8 }] // across, behind the line
  const Y_ROUTE: Pt[] = [{ x: 24, y: -0.8 }, { x: 22, y: 1.2 }, { x: 20, y: 7 }] // on through the block, so he has something to release into

  it('meets at a point on his route, with the release direction taken from the route', () => {
    const players = blocker(Y_MOTION, Y_ROUTE)
    const eng: Engagement = { id: 'e1', kind: 'engage', a: 'O5', b: 'D0', point: { x: 22, y: 1.2 }, release: 'O5' }
    const d = derive(engineUnderTest, play(players, { engagements: [eng] }))
    const e = d.eng.derived[0]
    expect(e.valid).toBe(true)
    // He arrives after the snap - the motion is not where the block happens.
    expect(e.time!).toBeGreaterThan(d.built.snapAt)
    // The release pause is the schedule's one pause (case C).
    expect(d.drawnSchedule.get('O5')!.hold).toBeDefined()
  })

  it('a block point dropped on his motion is still met on the route', () => {
    const players = blocker(Y_MOTION, Y_ROUTE)
    // Right on the motion's line, between 24 and 32.
    const eng: Engagement = { id: 'e1', kind: 'engage', a: 'O5', b: 'D3', point: { x: 28, y: -0.8 } }
    const d = derive(engineUnderTest, play(players, { engagements: [eng] }))
    const e = d.eng.derived[0]
    // Whatever the verdict, it is never a pre-snap meeting.
    if (e.valid) expect(e.time!).toBeGreaterThanOrEqual(d.built.snapAt)
    else expect(e.warning).toMatch(/never gets near/)
  })
})

describe('orientation through motion, snap and route', () => {
  it('faces the way he is moving in motion, and the way he runs after the snap', () => {
    const players = withH(JET, WHEEL)
    const d = derive(engineUnderTest, play(players))
    const inMotion = orientationAt(d.orientation, H(players), d.built.snapAt - 0.2)
    const onRoute = orientationAt(d.orientation, H(players), d.built.snapAt + 1.2)
    for (const o of [inMotion, onRoute]) for (const v of [o.body.x, o.body.y, o.look.x, o.look.y]) expect(Number.isFinite(v)).toBe(true)
    // Jet motion runs to -x: his body turns that way.
    expect(inMotion.body.x).toBeLessThan(0)
    // The wheel runs up the field: by now his body faces upfield.
    expect(onRoute.body.y).toBeGreaterThan(0)
  })
})

describe('what did NOT change', () => {
  it('a legacy pre-snap path runs exactly as before, with no preLength', () => {
    const legacy = panePlays().find((p) => p.players.some((q) => q.timing === 'pre-snap' && q.path.length >= 2))
    if (!legacy) return
    const man = legacy.players.find((q) => q.timing === 'pre-snap' && q.path.length >= 2)!
    const s = buildSchedule(legacy.players).schedule.get(man.id)!
    expect(s.preLength).toBeUndefined()
    expect(resolveEnd(man, s)).toBe(man.endBehavior ?? 'settle')
  })

  it('a player with no motion has no preLength at all', () => {
    const s = buildSchedule(withH(undefined, WHEEL)).schedule.get(H_ID)!
    expect(s.preLength).toBeUndefined()
  })
})

describe('the loader', () => {
  const doc = (motion: unknown, timing = 'on-snap') => ({
    ...newPlay('x'),
    players: initialPlayers().map((p) => (p.id === H_ID ? { ...p, motion, timing, path: WHEEL } : p)),
  })

  it('keeps a real motion', () => {
    expect(sanitizePlay(doc(JET))!.players.find((p) => p.id === H_ID)!.motion).toEqual(JET)
  })

  it('leaves no motion absent, and treats one point as none', () => {
    expect('motion' in sanitizePlay(doc(undefined))!.players.find((p) => p.id === H_ID)!).toBe(false)
    expect('motion' in sanitizePlay(doc([{ x: 1, y: 1 }]))!.players.find((p) => p.id === H_ID)!).toBe(false)
    expect('motion' in sanitizePlay(doc('garbage'))!.players.find((p) => p.id === H_ID)!).toBe(false)
  })

  it('reads a stray pre-snap timing beside motion as on-snap', () => {
    expect(sanitizePlay(doc(JET, 'pre-snap'))!.players.find((p) => p.id === H_ID)!.timing).toBe('on-snap')
  })
})
