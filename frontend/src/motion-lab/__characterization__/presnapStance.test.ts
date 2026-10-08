/// <reference types="node" />
// File-scoped Node types: the vocabulary test reads the server's file from disk.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { initialPlayers, STANCE_IDS, type Player, type StanceId } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import { lookFromPlayers, newPlay, sanitizeLook, sanitizePlay, SCHEMA_VERSION, type Play } from '../engine/play'
import { capturePlay } from './capture'
import { engineUnderTest } from './engineUnderTest'
import { gapPlays, panePlays } from './fixtures'

/**
 * THE PRE-SNAP STANCE CONTRACT (V6, approved divergence 4).
 *
 * A stance is the coach's choice of how a man stands before the snap. The
 * engine's only jobs are to KEEP it - through a reload, a saved formation and
 * an older tab (the version) - and to keep its absence absent. It must never
 * change how a play runs: the 3D viewer draws stances; the engine ignores
 * them. These tests are that decision, written down.
 */

const here = dirname(fileURLToPath(import.meta.url))
const roundTrip = (play: Play) => sanitizePlay(JSON.parse(JSON.stringify(play)))!
const withStances = (play: Play, stances: Record<string, unknown>): Play => ({
  ...play,
  players: play.players.map((p) => (p.id in stances ? ({ ...p, presnapStance: stances[p.id] } as Player) : p)),
})
const inside = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!

describe('the vocabulary', () => {
  it('is the 3D viewer\'s 27 stances, each once', () => {
    expect(STANCE_IDS).toHaveLength(27)
    expect(new Set(STANCE_IDS).size).toBe(27)
  })

  it('is word for word the server\'s (motion_documents.py STANCES)', () => {
    // Two languages, one vocabulary. If either list gains, loses or renames a
    // stance, a coach's choice would be accepted by one side and refused - or
    // silently dropped - by the other.
    const python = readFileSync(resolve(here, '../../../../backend/app/services/motion_documents.py'), 'utf-8')
    const block = python.match(/^STANCES = \(([\s\S]*?)^\)/m)
    expect(block, 'STANCES tuple not found in motion_documents.py').not.toBeNull()
    const server = [...block![1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1])
    expect(server).toEqual([...STANCE_IDS])
  })

  it('moved the schema to 3, so an older tab cannot strip it', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })
})

describe('reading a stance back', () => {
  it.each(STANCE_IDS.map((s) => [s]))('%s survives a reload', (stance) => {
    const out = roundTrip(withStances(inside(), { [inside().players[0].id]: stance }))
    expect(out.players[0].presnapStance).toBe(stance)
  })

  it('absent stays absent - on every man of every preserved play', () => {
    // A play written before V6 must come back exactly as it was written: the
    // viewer's position default is never stored in the coach's place.
    for (const play of [...panePlays(), ...gapPlays()]) {
      for (const p of roundTrip(play).players) expect('presnapStance' in p).toBe(false)
    }
  })

  it.each([['MADE_UP'], ['ol_2_point'], [7], [null], [true], [{ id: 'OL_2_POINT' }]])('drops %j rather than guessing', (raw) => {
    const out = roundTrip(withStances(inside(), { [inside().players[0].id]: raw }))
    expect('presnapStance' in out.players[0]).toBe(false)
  })

  it('keeps a stance whatever side or label the man has - suiting him is the coach\'s call', () => {
    const play = inside()
    const cb = play.players.find((p) => p.side === 'defense')!
    const out = roundTrip(withStances(play, { [cb.id]: 'OL_4_POINT' }))
    expect(out.players.find((p) => p.id === cb.id)!.presnapStance).toBe('OL_4_POINT')
  })

  it('changes nothing else about the man or the play', () => {
    const play = inside()
    const plain = roundTrip(play)
    const stanced = roundTrip(withStances(play, Object.fromEntries(play.players.map((p) => [p.id, 'WR_STANDARD']))))
    const strip = (pl: Play) => ({ ...pl, createdAt: 0, updatedAt: 0, players: pl.players.map(({ presnapStance: _s, ...rest }) => rest) })
    expect(strip(stanced)).toEqual(strip(plain))
  })
})

describe('a saved formation', () => {
  it('carries a stance onto the next play, and carries absence as absence', () => {
    const players = initialPlayers().map((p, i) => (i === 0 ? { ...p, presnapStance: 'OL_2_POINT' as StanceId } : p))
    const look = sanitizeLook(JSON.parse(JSON.stringify(lookFromPlayers('Ace', players))))!
    expect(look.players[0].presnapStance).toBe('OL_2_POINT')
    expect(look.players.slice(1).some((p) => 'presnapStance' in p)).toBe(false)
    const next = newPlay('From Ace', look.players)
    expect(next.players[0].presnapStance).toBe('OL_2_POINT')
  })
})

describe('the engine never reads it', () => {
  // The whole of what the engine derives - schedule, engagements, the ball,
  // body and look orientation - on real plays, with a stance on every man and
  // without. Identical, or a stance has started to change the football.
  it.each([...panePlays(), ...gapPlays()].map((p) => [p.name, p] as const))('%s runs identically with every man stanced', (_n, play) => {
    const stanced = withStances(play, Object.fromEntries(play.players.map((p, i) => [p.id, STANCE_IDS[i % STANCE_IDS.length]])))
    expect(capturePlay(engineUnderTest, stanced)).toEqual(capturePlay(engineUnderTest, play))
  })

  it('a man in pre-snap motion keeps his stance AND his motion, and runs exactly as without it', () => {
    // Stance is how he stands BEFORE the motion starts; the motion's timing
    // and path are the engine's, untouched.
    const JET: Pt[] = [{ x: 38, y: -1.6 }, { x: 31, y: -1.6 }]
    const WHEEL: Pt[] = [{ x: 31, y: -1.6 }, { x: 35, y: -2.5 }, { x: 44, y: 2 }, { x: 46, y: 14 }]
    const players = initialPlayers().map((p) => (p.id === 'O9' ? { ...p, motion: JET, path: WHEEL } : p))
    const plain: Play = { ...newPlay('jet', players), players }
    const stanced = withStances(plain, { O9: 'WR_STAGGERED' })
    const back = roundTrip(stanced).players.find((p) => p.id === 'O9')!
    expect(back.presnapStance).toBe('WR_STAGGERED')
    expect(back.motion).toEqual(JET)
    expect(capturePlay(engineUnderTest, stanced)).toEqual(capturePlay(engineUnderTest, plain))
  })
})
