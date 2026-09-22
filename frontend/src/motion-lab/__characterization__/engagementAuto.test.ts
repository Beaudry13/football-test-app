import { describe, expect, it } from 'vitest'
import { sanitizePlay, SCHEMA_VERSION } from '../engine/play'
import { panePlays } from './fixtures'
import type { Engagement } from '../engine/interactions'

/**
 * THE ENGAGEMENT.AUTO CONTRACT (ML-UX-5).
 *
 * `auto` is the one field PEIRA has ever added to the preserved engine, and
 * the only reason it is there rather than in the editor is that it has to
 * survive a reload: `sanitizePlay` rebuilds engagements field by field and
 * drops anything it does not name.
 *
 * So these tests are the justification for that decision, written down. If
 * they ever stop being true, the engine change has stopped earning its place.
 */

const play = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

/** The same play, with its engagements' `auto` replaced by whatever is given. */
function withAuto(raw: unknown) {
  const p = play()
  return {
    ...p,
    engagements: p.engagements.map((e) => ({ ...e, auto: raw })),
  }
}

const firstEngagement = (doc: unknown): Engagement => sanitizePlay(doc)!.engagements[0]

describe('reading auto back', () => {
  it('the fixture actually has an engagement to test with', () => {
    expect(play().engagements.length).toBeGreaterThan(0)
  })

  it('true survives', () => {
    expect(firstEngagement(withAuto(true)).auto).toBe(true)
  })

  it('false survives', () => {
    expect(firstEngagement(withAuto(false)).auto).toBe(false)
  })

  it('missing stays missing, and reads as not-auto', () => {
    // A play written before ML-UX-5 must come back EXACTLY as it was written,
    // so the sanitizer does not add the key. Absent is falsy, which is the
    // safe reading: nobody can now say the coach did not place that point.
    const p = play()
    const legacy = {
      ...p,
      engagements: p.engagements.map((e) => {
        const rest = { ...(e as Engagement & { auto?: boolean }) }
        delete rest.auto
        return rest
      }),
    }
    expect('auto' in (legacy.engagements[0] as object)).toBe(false)

    const out = firstEngagement(legacy)
    expect('auto' in out).toBe(false)
    expect(out.auto).toBeFalsy()
  })

  it.each([['a string', 'true'], ['a number', 1], ['null', null], ['an object', {}], ['undefined', undefined]])(
    'a present but nonsense value is normalised to false: %s',
    (_name, raw) => {
      expect(firstEngagement(withAuto(raw)).auto).toBe(false)
    },
  )
})

describe('what the field did NOT change', () => {
  it('a legacy play still loads, with everything else intact', () => {
    const p = play()
    const legacy = { ...p, engagements: p.engagements.map(({ id, kind, a, b, point, release }) => ({ id, kind, a, b, point, release })) }
    const out = sanitizePlay(legacy)!

    expect(out.engagements).toHaveLength(p.engagements.length)
    expect(out.engagements[0]).toMatchObject({
      id: p.engagements[0].id,
      a: p.engagements[0].a,
      b: p.engagements[0].b,
      point: p.engagements[0].point,
    })
    expect(out.players).toHaveLength(p.players.length)
  })

  it('auto did not move the schema version - roles did', () => {
    // ML-UX-5's point stands: `auto` needed no version, because a reader that
    // has never heard of it is correct anyway. The version is 2 because P3.1
    // added roles, which an older reader WOULD strip - and a play read here
    // still carries its auto exactly as written.
    expect(SCHEMA_VERSION).toBe(2)
    const back = sanitizePlay(play())!
    expect(back.v).toBe(SCHEMA_VERSION)
    expect(back.engagements).toEqual(play().engagements)
  })

  it('an engagement that was invalid before is still rejected, auto or not', () => {
    const p = play()
    const broken = { ...p, engagements: [{ ...p.engagements[0], b: 'nobody', auto: true }] }
    expect(sanitizePlay(broken)!.engagements).toEqual([])
  })

  it('auto is optional on the type', () => {
    // If `auto` were required this would not compile; the assertion is the
    // compile, and the runtime check keeps the test honest about it.
    const e: Engagement = { id: 'e1', kind: 'engage', a: 'x', b: 'y', point: { x: 1, y: 2 } }
    expect(e.auto).toBeUndefined()
  })
})
