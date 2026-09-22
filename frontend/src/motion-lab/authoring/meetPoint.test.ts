import { describe, expect, it } from 'vitest'
import { inferMeetPoint, meetPointCameFromPath } from './meetPoint'
import { BOUNDS } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'

/**
 * THE INFERRED MEETING POINT (SPEC §7.3).
 *
 * The guess PEIRA makes so that telling it who blocks whom is one click.
 */

const BASE = { id: 'p', label: 'Z', side: 'offense', x: 20, y: 0, path: [], timing: 'on-snap', speed: 'normal' }
const make = (over: Partial<Player>): Player => ({ ...BASE, ...over }) as unknown as Player
const pt = (x: number, y: number): Pt => ({ x, y })

describe('when the blocker has a path', () => {
  it('meets him where that path ends', () => {
    const blocker = make({ x: 20, y: 0, path: [pt(20, 0), pt(21, 2), pt(24, 5)] })
    const partner = make({ id: 'd', side: 'defense', x: 30, y: 8 })

    expect(inferMeetPoint(blocker, partner)).toEqual(pt(24, 5))
  })

  it('does not care where the defender is', () => {
    const blocker = make({ path: [pt(20, 0), pt(24, 5)] })
    const near = make({ id: 'd', side: 'defense', x: 21, y: 1 })
    const far = make({ id: 'd', side: 'defense', x: 50, y: 15 })

    expect(inferMeetPoint(blocker, near)).toEqual(inferMeetPoint(blocker, far))
  })

  it('does not care what the defender runs', () => {
    const blocker = make({ path: [pt(20, 0), pt(24, 5)] })
    const still = make({ id: 'd', side: 'defense', x: 30, y: 8, path: [] })
    const running = make({ id: 'd', side: 'defense', x: 30, y: 8, path: [pt(30, 8), pt(10, 14)] })

    expect(inferMeetPoint(blocker, running)).toEqual(inferMeetPoint(blocker, still))
  })

  it('a single stray point is not a path', () => {
    // path.length >= 2 is what counts as somewhere to go.
    const blocker = make({ x: 20, y: 0, path: [pt(20, 0)] })
    const partner = make({ id: 'd', side: 'defense', x: 30, y: 4 })

    expect(inferMeetPoint(blocker, partner)).toEqual(pt(25, 2))
  })
})

describe('when he has no path', () => {
  it('meets him halfway', () => {
    const blocker = make({ x: 20, y: 0, path: [] })
    const partner = make({ id: 'd', side: 'defense', x: 30, y: 4 })

    expect(inferMeetPoint(blocker, partner)).toEqual(pt(25, 2))
  })

  it('halfway is halfway whichever way round they stand', () => {
    const a = make({ x: 12, y: -2, path: [] })
    const b = make({ id: 'd', side: 'defense', x: 40, y: 9 })

    expect(inferMeetPoint(a, b)).toEqual(inferMeetPoint(b, a))
  })
})

describe('the point is always on the field', () => {
  it('clamps a path that ends out of bounds', () => {
    const blocker = make({ x: 20, y: 0, path: [pt(20, 0), pt(999, 999)] })
    const partner = make({ id: 'd', side: 'defense', x: 30, y: 8 })

    const p = inferMeetPoint(blocker, partner)
    expect(p.x).toBeLessThanOrEqual(BOUNDS.maxX)
    expect(p.y).toBeLessThanOrEqual(BOUNDS.maxY)
  })

  it('clamps a midpoint that lands off the back', () => {
    const blocker = make({ x: 1, y: -60, path: [] })
    const partner = make({ id: 'd', side: 'defense', x: 1, y: -60 })

    const p = inferMeetPoint(blocker, partner)
    expect(p.y).toBeGreaterThanOrEqual(BOUNDS.minY)
    expect(p.x).toBeGreaterThanOrEqual(BOUNDS.minX)
  })
})

describe('which case was used', () => {
  it('says so, because the two cases are explained differently to the coach', () => {
    expect(meetPointCameFromPath(make({ path: [pt(0, 0), pt(1, 1)] }))).toBe(true)
    expect(meetPointCameFromPath(make({ path: [pt(0, 0)] }))).toBe(false)
    expect(meetPointCameFromPath(make({ path: [] }))).toBe(false)
  })
})
