import { beforeAll, describe, expect, it } from 'vitest'
import { capturePlay, type PlayRecord } from './capture'
import { engineUnderTest, modelUnderTest } from './engineUnderTest'
import { prototypeEngine, prototypeModel } from './prototypeEngine'
import { buildGapFixtures } from './gapFixtures'
import { WRITE_GOLDEN, gapPlays, hasGolden, paneLooks, panePlays, readGolden, writeGapPlays, writeGolden } from './fixtures'
import type { Play } from '../engine/play'

/**
 * MOTION LAB ENGINE CHARACTERIZATION.
 *
 * Every fixture play is derived by the engine under test and compared, number
 * for number, with a golden record of what the PRESERVED PROTOTYPE produced.
 * A difference is a change in football behaviour. It is to be explained and
 * fixed, not re-baselined: the goldens can only be regenerated from the
 * prototype's engine, never from PEIRA's copy.
 *
 * Regenerate (prototype engine only):
 *   MOTION_LAB_WRITE_GOLDEN=1 npx vitest run src/motion-lab/__characterization__
 */

if (WRITE_GOLDEN) {
  // Gap fixtures are intent built on the prototype's own default formation.
  writeGapPlays(buildGapFixtures(prototypeModel))
}

const pane = panePlays()
const gaps = gapPlays()
const all: Play[] = [...pane, ...gaps]

beforeAll(() => {
  if (!WRITE_GOLDEN) return
  for (const play of all) writeGolden(play.id, capturePlay(prototypeEngine, play))
})

describe('fixture set', () => {
  it('holds the 8 preserved browser-pane plays and the 3 gap plays', () => {
    expect(pane).toHaveLength(8)
    expect(gaps.map((p) => p.id)).toEqual(['fx_motion_pitch', 'fx_engage_release_delayed', 'fx_settle_throw_from_here'])
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length)
    for (const play of all) expect(hasGolden(play.id), play.id).toBe(true)
  })
})

describe.each(all.map((play) => [play.name, play] as const))('%s', (_name, play) => {
  it('derives exactly what the preserved prototype derived', () => {
    expect(capturePlay(engineUnderTest, play)).toEqual(readGolden(play.id))
  })

  it('survives the sanitizer unchanged (stored intent round-trips)', () => {
    // `v` is the MODEL's stamp, not the coach's intent: a play is read by
    // whatever version opens it and re-stamped with that one (P3.1 raised it
    // to 2 for roles). Everything a coach authored still has to come back
    // exactly as it was written, including from these version 1 fixtures.
    const back = modelUnderTest.sanitizePlay(JSON.parse(JSON.stringify(play)))!
    expect({ ...back, v: play.v }).toEqual(play)
    expect(back.v).toBe(modelUnderTest.SCHEMA_VERSION)
  })
})

describe('preserved look', () => {
  it('survives the sanitizer unchanged', () => {
    const looks = paneLooks()
    expect(looks.map((l) => l.name)).toEqual(['Trips Rt'])
    for (const look of looks) {
      const back = modelUnderTest.sanitizeLook(JSON.parse(JSON.stringify(look)))!
      expect({ ...back, v: look.v }).toEqual(look)
      expect(back.v).toBe(modelUnderTest.SCHEMA_VERSION)
    }
  })
})

/**
 * A fixture that silently stopped exercising its behaviour would keep passing
 * while proving nothing. These pin WHAT each record demonstrates, read from
 * the golden itself.
 */
describe('each behaviour the fixtures claim is actually exercised', () => {
  const golden = (id: string) => readGolden(id) as PlayRecord
  const byName = (name: string) => pane.find((p) => p.name === name)!
  const moving = (rec: PlayRecord, id: string) => rec.samples.some((s, i) => i > 0 && (s.players[id].x !== rec.samples[0].players[id].x || s.players[id].y !== rec.samples[0].players[id].y))

  it('normal pass + QB drop with a derived release: Trips Out', () => {
    const play = byName('Trips Out')
    const rec = golden(play.id)
    expect(play.ball?.kind).toBe('pass')
    expect(rec.ball.warning).toBeNull()
    expect(rec.ball.releaseIsManual).toBe(false)
    expect(rec.ball.releasePoint).not.toBeNull()
    expect(rec.samples.some((s) => s.ball.phase === 'flight')).toBe(true)
  })

  it('handoff + engage: Inside Zone Rt', () => {
    const play = byName('Inside Zone Rt')
    const rec = golden(play.id)
    expect(play.ball?.kind).toBe('handoff')
    expect(rec.engagements.filter((e) => e.valid)).toHaveLength(2)
    expect(rec.samples.some((s) => s.ball.phase === 'handoff')).toBe(true)
  })

  it('two-step possession chain: Reverse', () => {
    const play = byName('Reverse')
    const rec = golden(play.id)
    expect([play.ball?.kind, play.ballThen?.kind]).toEqual(['handoff', 'handoff'])
    expect(rec.ball.chain).not.toBeNull()
    expect(new Set(rec.samples.map((s) => s.ball.carrierId).filter(Boolean)).size).toBeGreaterThanOrEqual(3)
  })

  it('play action: Regression', () => {
    const play = byName('Regression')
    const rec = golden(play.id)
    expect(play.ball?.kind).toBe('play-action')
    expect(rec.samples.some((s) => s.ball.phase === 'fake')).toBe(true)
  })

  it('explicit Continue: Untitled Play', () => {
    const play = byName('Untitled Play')
    const rec = golden(play.id)
    const cont = play.players.filter((p) => p.endBehavior === 'continue')
    expect(cont).toHaveLength(1)
    expect(rec.schedule[cont[0].id].endBehavior).toBe('continue')
  })

  it('pre-snap motion + pitch: fx_motion_pitch', () => {
    const rec = golden('fx_motion_pitch')
    expect(rec.schedule.O10.end).toBeLessThanOrEqual(rec.snapAt)
    expect(rec.schedule.O10.start).toBeLessThan(rec.snapAt)
    expect(rec.snapAt).toBeGreaterThan(0.5)
    expect(rec.ball.warning).toBeNull()
    expect(rec.samples.some((s) => s.ball.phase === 'pitch')).toBe(true)
    expect(rec.samples.some((s) => s.ball.carrierId === 'O7')).toBe(true)
  })

  it('engage -> release + delayed timing: fx_engage_release_delayed', () => {
    const rec = golden('fx_engage_release_delayed')
    const [e] = rec.engagements
    expect(e.valid).toBe(true)
    expect(e.until).not.toBeNull()
    expect(rec.schedule.O5.hold).not.toBeNull()
    expect(moving(rec, 'O5')).toBe(true)
    expect(rec.schedule.O7.start).toBeCloseTo(rec.snapAt + 0.8, 6)
    expect(rec.ball.warning).toBeNull()
    expect(rec.samples.some((s) => s.ball.carrierId === 'O7')).toBe(true)
  })

  it('explicit Settle + Throw From Here: fx_settle_throw_from_here', () => {
    const rec = golden('fx_settle_throw_from_here')
    expect(rec.schedule.O8.endBehavior).toBe('settle')
    expect(rec.ball.releaseIsManual).toBe(true)
    expect(rec.ball.releasePoint).toEqual({ x: 26.665, y: -6 })
    expect(rec.ball.warning).toBeNull()
    expect(rec.samples.some((s) => s.ball.phase === 'flight')).toBe(true)
  })
})
