/// <reference types="node" />
// File-scoped Node types, matching styles/buttonContrast.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { capturePlay } from './capture'
import { engineUnderTest } from './engineUnderTest'
import { prototypeEngine } from './prototypeEngine'
import { gapPlays, panePlays } from './fixtures'

/**
 * P1 RULE: THE ENGINE MOVED, IT DID NOT CHANGE.
 *
 * The goldens prove behaviour on the fixtures. This proves it for every play
 * a coach could author, by showing there is nothing different to behave
 * differently: PEIRA's engine files ARE the preserved prototype's files.
 *
 * If a later phase changes the engine on purpose, this test is where that
 * decision becomes visible - update it deliberately, with the reason, never
 * to make a diff go away.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PROTOTYPE = resolve(here, '../../../../prototypes/motion-lab/src')
const ENGINE = resolve(here, '../engine')
const VIEW = resolve(here, '../view')
// Line endings are a checkout setting (core.autocrlf), not source.
const read = (path: string) => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')

/** Three of the nine, still byte-for-byte the prototype's. */
const VERBATIM_FILES = ['field', 'geometry', 'perspective']
/** All nine. Listed, not derived: a file must never leave this list by being
 *  taken off the verbatim one. */
const ALL_ENGINE_FILES = ['field', 'geometry', 'formation', 'timeline', 'ball', 'orientation', 'perspective', 'interactions', 'play']

/**
 * APPROVED DIVERGENCE 3 (P3.4, owner decision, 22 September 2026): MOTION.
 *
 * A player may have PRE-SNAP MOTION and a separate POST-SNAP route. The
 * prototype had one path per man, so "jet motion, then a wheel" could not be
 * said. `motion` is optional: the schedule stitches it in front of the route
 * (it ends at the snap, the route starts where it ends) and records how much
 * of the line is motion as `preLength`. Everything that projects a post-snap
 * point onto a man's line - the catch, the throw point, a block and its
 * release direction - now searches from `preLength` on, so none of them can
 * land on where he was before the snap.
 *
 * WHAT KEEPS THIS SAFE: a man with no motion takes the prototype's branch,
 * unchanged, and `projectOntoRoute` with no `preLength` IS `projectOntoPath`.
 * No fixture here has motion, so the goldens and the engine-against-prototype
 * comparison below prove the old behaviour on real plays.
 *
 * APPROVED DIVERGENCE 2 (P3.1, owner decision, 22 September 2026): ROLES.
 *
 * The prototype found the two men the engine must know - who throws it, who
 * snaps it - by LABEL: the offensive player called QB, the one called C. That
 * made a coach's label the engine's source of truth, so renaming his
 * quarterback "Q" or "12" left the ball with nobody to throw it and the snap
 * at midfield. A player may now carry a `role`, and `roleHolder` reads it.
 *
 * WHAT KEEPS THIS SAFE: when no offensive player carries a role - every play
 * written before this, and every fixture in this file - `roleHolder` IS the
 * prototype's lookup, line for line. The goldens and the engine-against-
 * prototype comparison at the bottom prove it on real plays.
 *
 * APPROVED DIVERGENCE 1 (ML-UX-5, owner decision, 20 September 2026).
 *
 * `Engagement` gained a single optional field, `auto`, meaning "PEIRA chose
 * this meeting point, not the coach" - so the editor can keep an inferred
 * point on the end of a blocker's path as that path is redrawn. It had to go
 * on the STORED object: `sanitizePlay` rebuilds engagements field by field
 * and drops anything it does not name, so an editor-side flag would not have
 * survived a reload, and reload behaviour is the whole point of the field.
 *
 * These two files are NOT exempted. Their diff against the prototype is taken
 * line by line, every added line must match one of the patterns below, and
 * nothing may be removed or reworded. A second change - to these files, or
 * smuggled in under this one's name - fails here.
 */
const APPROVED_DIVERGENCE = [
  {
    file: 'formation',
    // The role, its type and the lookup. Additive: the fallback branch is the
    // prototype's own find(), which is what keeps role-less plays identical.
    added: [
      /^export type PlayerRole = 'passer' \| 'snapper'$/,
      /^export function roleHolder\(players: Player\[\], role: PlayerRole, legacyLabel: string\): Player \| undefined \{$/,
      /^\s*const byRole = players\.find\(\(p\) => p\.side === 'offense' && p\.role === role\)$/,
      /^\s*if \(byRole\) return byRole$/,
      /^\s*if \(players\.some\(\(p\) => p\.side === 'offense' && p\.role\)\) \{$/,
      /^\s*return undefined$/,
      /^\s*return players\.find\(\(p\) => p\.side === 'offense' && p\.label === legacyLabel\)$/,
      /^\s*role\?: PlayerRole$/,
      /^\s*motion\?: Pt\[\]$/,
      /^\s*\}$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    removed: [],
  },
  {
    file: 'ball',
    // The same two lookups, by role instead of by label.
    added: [
      /^import \{ roleHolder, type Player \} from '\.\/formation'$/,
      /^\s*const center = roleHolder\(players, 'snapper', 'C'\)$/,
      /^\s*const qb = roleHolder\(players, 'passer', 'QB'\)$/,
      // P3.4: the same projection, onto the post-snap route only.
      /^export function projectOntoRoute\(s: \{ pts: Pt\[\]; cum: number\[\]; preLength\?: number \}, p: Pt\): \{ pt: Pt; along: number; gap: number \} \{$/,
      /^\s*if \(!s\.preLength\) return projectOntoPath\(s\.pts, s\.cum, p\)$/,
      /^\s*let i = 0$/,
      /^\s*while \(i < s\.cum\.length - 1 && s\.cum\[i\] < s\.preLength - 1e-9\) i\+\+$/,
      /^\s*const proj = projectOntoPath\(s\.pts\.slice\(i\), s\.cum\.slice\(i\)\.map\(\(c\) => c - s\.cum\[i\]\), p\)$/,
      /^\s*return \{ \.\.\.proj, along: proj\.along \+ s\.cum\[i\] \}$/,
      /^\s*\}$/,
      /^\s*const along = override \? projectOntoRoute\(sq, override\)\.along : sq\.length$/,
      /^\s*const proj = projectOntoRoute\(s, requested\)$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    removed: [
      /^\s*const along = override \? projectOntoPath\(sq\.pts, sq\.cum, override\)\.along : sq\.length$/,
      /^\s*const proj = projectOntoPath\(s\.pts, s\.cum, requested\)$/,
      /^import type \{ Player \} from '\.\/formation'$/,
      /^\s*const center = players\.find\(\(p\) => p\.side === 'offense' && p\.label === 'C'\)$/,
      /^\s*const qb = players\.find\(\(p\) => p\.side === 'offense' && p\.label === 'QB'\)$/,
    ],
  },
  {
    file: 'orientation',
    // The passer is found once and carried into his table as a flag; the rule
    // that read his label reads that flag.
    added: [
      /^import \{ roleHolder, type Player \} from '\.\/formation'$/,
      /^\s*isPasser: boolean,?$/,
      /^\s*if \(s\.isPasser\) return ball\.phase === 'flight' \|\| ball\.phase === 'pitch' \? ballDir : fwd$/,
      /^\s*const s: Situation = \{ p, at, partner, fwd, move, speed, movingFor, preSnap: t < snapAt, ball, targetIds, isPasser \}$/,
      /^\s*const passerId = roleHolder\(players, 'passer', 'QB'\)\?\.id \?\? null$/,
      /^\s*return new Map\(players\.map\(\(p\) => \[p\.id, buildTable\(p, schedule, snapAt, end, ballAt, targetIds, engagements\.get\(p\.id\), byId, p\.id === passerId\)\]\)\)$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    removed: [
      /^import type \{ Player \} from '\.\/formation'$/,
      /^\s*if \(p\.label === 'QB'\) return ball\.phase === 'flight' \|\| ball\.phase === 'pitch' \? ballDir : fwd$/,
      /^\s*const s: Situation = \{ p, at, partner, fwd, move, speed, movingFor, preSnap: t < snapAt, ball, targetIds \}$/,
      /^\s*return new Map\(players\.map\(\(p\) => \[p\.id, buildTable\(p, schedule, snapAt, end, ballAt, targetIds, engagements\.get\(p\.id\), byId\)\]\)\)$/,
    ],
  },
  {
    file: 'timeline',
    // The motion branch, the delay held at the snap, and a motion-only man
    // settling. Purely additive: the prototype's own branch runs untouched
    // for every man without motion.
    added: [
      /^\s*preLength\?: number$/,
      /^\s*if \(p\.motion && p\.motion\.length >= 2\) \{$/,
      /^\s*const pre = renderPath\(p\.motion\)$/,
      /^\s*const post = p\.path\.length >= 2 \? renderPath\(p\.path\) : \[\]$/,
      /^\s*const end = pre\[pre\.length - 1\]$/,
      /^\s*const joined = post\.length && Math\.hypot\(post\[0\]\.x - end\.x, post\[0\]\.y - end\.y\) < 1e-6 \? post\.slice\(1\) : post$/,
      /^\s*const pts = \[\.\.\.pre, \.\.\.joined\]$/,
      /^\s*const cum = cumulativeLength\(pts\)$/,
      /^\s*const length = cum\[cum\.length - 1\]$/,
      /^\s*const preLength = cumulativeLength\(pre\)\[pre\.length - 1\]$/,
      /^\s*const speed = SPEED_YPS\[p\.speed\]$/,
      /^\s*base\.set\(p\.id, \{ pts, cum, length, speed, drawnLength: length, preLength \}\)$/,
      /^\s*longestPre = Math\.max\(longestPre, preLength \/ speed\)$/,
      /^\s*continue$/,
      /^\s*\}$/,
      /^\s*if \(b\.preLength !== undefined\) \{$/,
      /^\s*const start = snapAt - b\.preLength \/ b\.speed$/,
      /^\s*const wait = p\.timing === 'delayed' && b\.length > b\.preLength \? Math\.max\(0, p\.delay\) : 0$/,
      /^\s*const moving = b\.length \/ b\.speed$/,
      /^\s*schedule\.set\(p\.id, \{ \.\.\.b, start, end: start \+ moving \+ wait, \.\.\.\(wait > 0 \? \{ hold: \{ from: snapAt, until: snapAt \+ wait \} \} : null\) \}\)$/,
      /^\s*playersEnd = Math\.max\(playersEnd, start \+ moving \+ wait\)$/,
      /^\s*if \(s\.preLength !== undefined && s\.length - s\.preLength < 1e-6\) return 'settle'$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    removed: [],
  },
  {
    file: 'interactions',
    // Divergence 1: the auto field and its comment. Divergence 3: the block
    // point and the release direction project onto the post-snap route only.
    added: [
      /^\s*auto\?: boolean$/,
      /^import \{ projectOntoRoute \} from '\.\/ball'$/,
      /^\s*const proj = projectOntoRoute\(s, point\)$/,
      /^\s*const back = pointAtDistance\(s\.pts, s\.cum, Math\.max\(s\.preLength \?\? 0, proj\.along - 1\)\)$/,
      /^\s*const from = s \? pointAtDistance\(s\.pts, s\.cum, Math\.max\(s\.preLength \?\? 0, projectOntoRoute\(s, e\.point\)\.along - 1\)\) : \{ x: p\.x, y: p\.y \}$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    removed: [
      /^import \{ projectOntoPath \} from '\.\/ball'$/,
      /^\s*const proj = projectOntoPath\(s\.pts, s\.cum, point\)$/,
      /^\s*const back = pointAtDistance\(s\.pts, s\.cum, Math\.max\(0, proj\.along - 1\)\)$/,
      /^\s*const from = s \? pointAtDistance\(s\.pts, s\.cum, Math\.max\(0, projectOntoPath\(s\.pts, s\.cum, e\.point\)\.along - 1\)\) : \{ x: p\.x, y: p\.y \}$/,
    ],
  },
  {
    file: 'play',
    // Normalise it when present, leave it absent when absent, carry it
    // through, and explain why.
    added: [
      /^\s*const auto = 'auto' in x \? \{ auto: x\.auto === true \} : null$/,
      /^\s*return \{ id: .*, release, \.\.\.auto \}$/,
      // Roles: kept on read (absent stays absent), one of each, and carried
      // by a saved formation - plus the version that tells an older tab so.
      /^export const SCHEMA_VERSION = 2$/,
      /^import \{ initialPlayers, type Player, type PlayerRole \} from '\.\/formation'$/,
      /^\s*const role = side === 'offense' && \(r\.role === 'passer' \|\| r\.role === 'snapper'\) \? \{ role: r\.role as PlayerRole \} : null$/,
      /^\s*return \{ id: r\.id, side, label, .*, timing: phased, .*, endBehavior, \.\.\.role, \.\.\.motion \}$/,
      /^\s*const motionPts = Array\.isArray\(r\.motion\) \? \(r\.motion\.filter\(isPt\) as Player\['path'\]\) : \[\]$/,
      /^\s*const motion = motionPts\.length >= 2 \? \{ motion: motionPts \} : null$/,
      /^\s*const phased = motion && timing === 'pre-snap' \? 'on-snap' : timing$/,
      /^\s*const taken = new Set<string>\(\)$/,
      /^\s*const withRoles = unique\.map\(\(p\) => \{$/,
      /^\s*if \(!p\.role\) return p$/,
      /^\s*if \(taken\.has\(p\.role\)\) \{$/,
      /^\s*const \{ role: _dropped, \.\.\.rest \} = p$/,
      /^\s*return rest$/,
      /^\s*taken\.add\(p\.role\)$/,
      /^\s*return p$/,
      /^\s*\}\)?$/,
      /^\s*players: withRoles,$/,
      /^\s*players: players\.map\(\(p\) => \(\{ id: p\.id, .*speed: p\.speed, \.\.\.\(p\.role \? \{ role: p\.role \} : null\) \}\)\),$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
    // The prototype lines these replace, and nothing else in the file.
    removed: [
      /^\s*return \{ id: .*, point: x\.point, release \}$/,
      /^export const SCHEMA_VERSION = 1$/,
      /^import \{ initialPlayers, type Player \} from '\.\/formation'$/,
      /^\s*return \{ id: r\.id, side, label, .*, endBehavior \}$/,
      /^\s*players: unique,$/,
      /^\s*players: players\.map\(\(p\) => \(\{ id: p\.id, .*speed: p\.speed \}\)\),$/,
      /^\s*(\/\*\*.*|\*\/|\*(\s.*)?|\/\/.*)$/,
    ],
  },
]

/** Lines in `after` that are not in `before`, counting duplicates. */
function addedLines(before: string, after: string): string[] {
  const seen = new Map<string, number>()
  for (const line of before.split('\n')) seen.set(line, (seen.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of after.split('\n')) {
    const n = seen.get(line) ?? 0
    if (n > 0) seen.set(line, n - 1)
    else out.push(line)
  }
  return out
}

const diverges = (name: string) => read(resolve(ENGINE, `${name}.ts`)) !== read(resolve(PROTOTYPE, `${name}.ts`))

describe('engine source', () => {
  it.each(VERBATIM_FILES)('%s.ts is byte-identical to the preserved prototype', (name) => {
    expect(read(resolve(ENGINE, `${name}.ts`))).toBe(read(resolve(PROTOTYPE, `${name}.ts`)))
  })

  it('exactly the approved files diverge, and no others', () => {
    expect(ALL_ENGINE_FILES.filter(diverges).sort()).toEqual(['ball', 'formation', 'interactions', 'orientation', 'play', 'timeline'])
  })

  it.each(APPROVED_DIVERGENCE)('$file.ts differs only by what was approved', ({ file, added, removed }) => {
    const proto = read(resolve(PROTOTYPE, `${file}.ts`))
    const peira = read(resolve(ENGINE, `${file}.ts`))

    // Nothing the prototype says may be dropped or reworded, beyond the one
    // line each entry above names.
    for (const line of addedLines(peira, proto).filter((l) => l.trim())) {
      expect(
        removed.some((re) => re.test(line)),
        `${file}.ts removed or changed a prototype line outside the approved contract:\n  ${line}`,
      ).toBe(true)
    }

    const newLines = addedLines(proto, peira).filter((l) => l.trim())
    expect(newLines.length, `${file}.ts added nothing`).toBeGreaterThan(0)
    for (const line of newLines) {
      expect(
        added.some((re) => re.test(line)),
        `${file}.ts added a line outside the approved contract:\n  ${line}`,
      ).toBe(true)
    }
  })

  it('the engine reads a role only through roleHolder', () => {
    // A role IS engine behaviour - deliberately, and in three places only.
    // Anywhere else reading `.role` would be a second decision travelling
    // under this one's name.
    const allowed: Record<string, RegExp[]> = {
      formation: [/p\.role === role/, /p\.side === 'offense' && p\.role/, /^\s*role\?: PlayerRole$/, /^export type PlayerRole = /, /^export function roleHolder\(/],
      ball: [/roleHolder\(players, '(passer|snapper)', '(QB|C)'\)/],
      orientation: [/roleHolder\(players, 'passer', 'QB'\)/],
      play: [/r\.role/, /p\.role/, /const \{ role: _dropped/, /taken\.(has|add)\(p\.role\)/, /endBehavior, \.\.\.role, \.\.\.motion \}$/],
    }
    for (const name of ALL_ENGINE_FILES) {
      const lines = read(resolve(ENGINE, `${name}.ts`))
        .split('\n')
        .filter((l) => /\brole\b/i.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const line of lines) {
        expect(
          (allowed[name] ?? []).some((re) => re.test(line)),
          `${name}.ts reads a role outside the approved contract:\n  ${line}`,
        ).toBe(true)
      }
    }
  })

  it('the engine reads motion in the schedule and the loader, nowhere else', () => {
    // Everything downstream reads the stitched SCHEDULE (and its preLength),
    // never p.motion itself - so the ball, blocks and orientation cannot each
    // grow their own idea of what motion means.
    const allowed: Record<string, RegExp[]> = {
      formation: [/^\s*motion\?: Pt\[\]$/],
      timeline: [/p\.motion/],
      play: [/r\.motion/, /const motion = motionPts/, /const phased = motion/, /\.\.\.motion \}$/],
    }
    for (const name of ALL_ENGINE_FILES) {
      const lines = read(resolve(ENGINE, `${name}.ts`))
        .split('\n')
        .filter((l) => /\bmotion\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const line of lines) {
        expect(
          (allowed[name] ?? []).some((re) => re.test(line)),
          `${name}.ts reads motion outside the approved contract:\n  ${line}`,
        ).toBe(true)
      }
    }
  })

  it('the auto divergence is a type and a default, never engine behaviour', () => {
    // `auto` is coach intent, and the editor owns every behaviour attached to
    // it. The moment an engine module READS it, the engine has gained
    // behaviour it did not have, and this stops being a paper change.
    const allowed: Record<string, RegExp[]> = {
      interactions: [/^\s*auto\?: boolean$/],
      play: [/const auto = 'auto' in x \? \{ auto: x\.auto === true \} : null$/, /, release, \.\.\.auto \}$/],
    }
    for (const name of ALL_ENGINE_FILES) {
      const lines = read(resolve(ENGINE, `${name}.ts`))
        .split('\n')
        .filter((l) => /\bauto\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      for (const line of lines) {
        expect(
          (allowed[name] ?? []).some((re) => re.test(line)),
          `${name}.ts uses \`auto\` in engine code:\n  ${line}`,
        ).toBe(true)
      }
    }
  })
})

describe('field views', () => {
  // The only change: they now import the engine from ../engine/ instead of
  // sitting beside it.
  it.each(['FieldMarkings', 'FieldView'])('%s.tsx differs from the prototype only in its engine import paths', (name) => {
    const peira = read(resolve(VIEW, `${name}.tsx`)).replace(/from '\.\.\/engine\//g, "from './")
    expect(peira).toBe(read(resolve(PROTOTYPE, `${name}.tsx`)))
  })
})

describe('prototype and PEIRA engines agree', () => {
  it.each([...panePlays(), ...gapPlays()].map((p) => [p.name, p] as const))('%s', (_name, play) => {
    expect(capturePlay(engineUnderTest, play)).toEqual(capturePlay(prototypeEngine, play))
  })
})
