import { describe, expect, it } from 'vitest'
import { BOUNDS } from '../engine/field'
import { initialPlayers, type Player } from '../engine/formation'
import { hashX } from '../engine/play'
import { DEFENSE_PRESETS, OFFENSE_PRESETS, presetPlayers } from './formationPresets'
import { alignmentOf } from './alignment'
import { defaultStanceFor, snapX, stanceFamilyOf } from './stances'

/**
 * QUICK FORMATIONS are football, not decoration: a legal offense (eleven men,
 * seven on the line, one snapper, one quarterback), positions Motion Lab reads,
 * every man on the field at every hash, nobody stacked on anybody, and a tight
 * end's default stance following where the set puts him.
 */

const defense = () => initialPlayers().filter((p) => p.side === 'defense')
const offense = () => initialPlayers().filter((p) => p.side === 'offense')
const HASHES = ['left', 'middle', 'right'] as const

describe('offensive sets', () => {
  it.each(OFFENSE_PRESETS.map((p) => [p.name, p] as const))('%s is eleven men, seven on the line, one C and one QB', (_name, preset) => {
    const men = presetPlayers(preset, hashX('middle'))
    expect(men).toHaveLength(11)
    expect(men.every((p) => p.side === 'offense' && p.path.length === 0)).toBe(true)
    expect(new Set(men.map((p) => p.id)).size).toBe(11)
    const center = men.find((p) => p.label === 'C')!
    expect(men.filter((p) => Math.abs(p.y - center.y) < 0.5)).toHaveLength(7)
    expect(men.filter((p) => p.label === 'QB')).toHaveLength(1)
    expect(men.filter((p) => p.label === 'C')).toHaveLength(1)
    expect(men.every((p) => p.y < 0)).toBe(true)
  })

  it('every man is a position Motion Lab (and the 3D viewer) reads', () => {
    for (const preset of OFFENSE_PRESETS) {
      const players = [...presetPlayers(preset, hashX('middle')), ...defense()]
      for (const man of players.filter((p) => p.side === 'offense')) expect(stanceFamilyOf(man, players), `${preset.name} ${man.label}`).not.toBeNull()
    }
  })

  it('a tight end stands the way his alignment says', () => {
    const at = (id: string, label: string) => {
      const players = [...presetPlayers(OFFENSE_PRESETS.find((p) => p.id === id)!, hashX('middle')), ...defense()]
      const te = players.find((p) => p.label === label)!
      return [alignmentOf(te, players), defaultStanceFor(te, players)]
    }
    expect(at('trips-rt', 'Y')).toEqual(['attached', 'TE_3_POINT'])
    expect(at('ace', 'U')).toEqual(['attached', 'TE_3_POINT'])
    expect(at('i-form', 'Y')).toEqual(['attached', 'TE_3_POINT'])
  })

  it('a shotgun QB defaults to the shotgun, an I-Form QB to under center', () => {
    const qb = (id: string) => {
      const players = [...presetPlayers(OFFENSE_PRESETS.find((p) => p.id === id)!, hashX('middle')), ...defense()]
      return defaultStanceFor(players.find((p) => p.label === 'QB')!, players)
    }
    expect(qb('spread')).toBe('QB_SHOTGUN')
    expect(qb('empty')).toBe('QB_SHOTGUN')
    expect(qb('i-form')).toBe('QB_UNDER_CENTER')
    expect(qb('ace')).toBe('QB_UNDER_CENTER')
  })

  it('Trips Lt is Trips Rt the other way round', () => {
    const rt = presetPlayers(OFFENSE_PRESETS.find((p) => p.id === 'trips-rt')!, hashX('middle'))
    const lt = presetPlayers(OFFENSE_PRESETS.find((p) => p.id === 'trips-lt')!, hashX('middle'))
    const side = (men: Player[]) => men.filter((p) => !['LT', 'LG', 'C', 'RG', 'RT', 'QB', 'RB'].includes(p.label)).map((p) => Math.sign(p.x - hashX('middle')))
    expect(side(rt).filter((s) => s > 0)).toHaveLength(3)
    expect(side(lt).filter((s) => s < 0)).toHaveLength(3)
  })
})

describe('defensive fronts', () => {
  it.each(DEFENSE_PRESETS.map((p) => [p.name, p] as const))('%s is eleven defenders, all on their side of the ball', (_name, preset) => {
    const men = presetPlayers(preset, hashX('middle'))
    expect(men).toHaveLength(11)
    expect(men.every((p) => p.side === 'defense' && p.y > 0)).toBe(true)
    const players = [...offense(), ...men]
    for (const man of men) expect(stanceFamilyOf(man, players), `${preset.name} ${man.label}`).not.toBeNull()
  })
})

describe('every set, at every hash', () => {
  it('stays on the field, on the football, and never stacks two men', () => {
    for (const preset of [...OFFENSE_PRESETS, ...DEFENSE_PRESETS]) {
      for (const hash of HASHES) {
        const men = presetPlayers(preset, hashX(hash))
        for (const p of men) {
          expect(p.x, `${preset.name} ${hash} ${p.label}`).toBeGreaterThanOrEqual(BOUNDS.minX)
          expect(p.x, `${preset.name} ${hash} ${p.label}`).toBeLessThanOrEqual(BOUNDS.maxX)
        }
        for (let i = 0; i < men.length; i++)
          for (let j = i + 1; j < men.length; j++) expect(Math.hypot(men[i].x - men[j].x, men[i].y - men[j].y), `${preset.name} ${men[i].label}/${men[j].label}`).toBeGreaterThan(1)
        if (preset.side === 'offense') expect(snapX([...men])).toBeCloseTo(hashX(hash), 6)
      }
    }
  })
})
