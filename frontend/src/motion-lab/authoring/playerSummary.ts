import type { BallAction } from '../engine/ball'
import { FIELD_WIDTH } from '../engine/field'
import { defaultSpeed, type Player } from '../engine/formation'
import { cumulativeLength, endDirection, renderPath, SHARP_BREAK_DEG, turnAngle, type Pt } from '../engine/geometry'
import type { DerivedEngagement, Engagement } from '../engine/interactions'
import type { Schedule } from '../engine/timeline'
import { catchDepthWords } from './ballSentence'
import { passerOf, snapperOf } from './roles'

/**
 * WHAT HE IS DOING, IN ONE LINE (ML-UX-7, SPEC §4.4 with §4.2, §7.8, §12.6).
 *
 * The right end of the selected player's strip answers "what is he doing"
 * without the coach having to read the field: "Route · 9 yds up, then out",
 * "Drop · 5 yds back", "Path · 3 yds up · blocks DE · releases".
 *
 * DERIVED EVERY RENDER, NEVER STORED (§4.4). Everything here is read from
 * state the editor already has - the play, the schedule the players actually
 * run, the engagements the engine derived, the ball. Nothing is written back.
 *
 * WHY THIS IS NOT IN THE ENGINE. The same reason as ballSentence.ts: it is
 * wording for the authoring UI, and the engine is pinned byte-for-byte against
 * the preserved prototype. The geometry is the engine's own - `turnAngle`,
 * `SHARP_BREAK_DEG`, `endDirection` - called, never copied.
 */

export interface SummaryInput {
  player: Player
  players: Player[]
  /** His entry in the editor's `drawnSchedule`: the path he actually runs,
   *  after engagements, before any continuation the ball asks for. */
  drawn: Schedule | undefined
  engagements: Engagement[]
  /** What the engine made of those engagements (`applyEngagements().derived`). */
  derived: DerivedEngagement[]
  ball: BallAction | null
  ballThen: BallAction | null
}

type Heading = 'up' | 'back' | 'across'

const OFFENSIVE_LINE = new Set(['LT', 'LG', 'C', 'RG', 'RT'])
const BACKS = new Set(['RB', 'FB', 'H'])

/**
 * Which way a step mostly goes, by the larger of its two components; a tie
 * counts as vertical. "Up" is +y and "back" is -y for BOTH sides - the SPEC
 * defines them on the field's axis, not on the player's facing (§4.4; §17.1
 * makes the same choice for the route handle).
 */
function heading(d: Pt): Heading {
  if (Math.abs(d.y) >= Math.abs(d.x)) return d.y >= 0 ? 'up' : 'back'
  return 'across'
}

/** The direction of his first drawn step: the first anchor pair (§4.4). */
function firstStep(path: Pt[]): Pt {
  for (let i = 1; i < path.length; i++) {
    const d = { x: path[i].x - path[0].x, y: path[i].y - path[0].y }
    if (d.x !== 0 || d.y !== 0) return d
  }
  return { x: 0, y: 1 }
}

/**
 * The finishing direction, after a break. Vertical reads up / back; lateral
 * reads OUT when it heads away from the center and IN when it heads toward
 * him - judged from where the finishing leg starts. A man breaking laterally
 * from exactly the center's x has no out or in, so he goes "across".
 */
function finish(dir: Pt, fromX: number, centerX: number): 'up' | 'back' | 'out' | 'in' | 'across' {
  if (Math.abs(dir.y) >= Math.abs(dir.x)) return dir.y >= 0 ? 'up' : 'back'
  const side = Math.sign(fromX - centerX)
  if (side === 0) return 'across'
  return Math.sign(dir.x) === side ? 'out' : 'in'
}

/**
 * The noun, by the §4.2 TABLE (owner decision, ML-UX-7). The prose under the
 * table contradicts it - and its own "Drop · 5 yds back" example - so the
 * table, which matches every worked example, is the rule:
 *   defense → Path; QB → Drop if his first step is back, else Path;
 *   offensive line → Path; backs → Path when they get the ball, else Route;
 *   receivers, tight ends and any other offensive label → Route.
 */
function noun(p: Player, first: Heading, carries: boolean, isPasser: boolean): 'Route' | 'Drop' | 'Path' {
  if (p.side === 'defense') return 'Path'
  // The passer by role, so "Drop" still reads right when he is called Q or 12.
  if (isPasser) return first === 'back' ? 'Drop' : 'Path'
  if (OFFENSIVE_LINE.has(p.label)) return 'Path'
  if (BACKS.has(p.label)) return carries ? 'Path' : 'Route'
  return 'Route'
}

/**
 * What he does with the ball, in either action (owner decision: the second
 * action counts). A pass target with no route catches it where he stands
 * (§12.6). The QB's keep and the play-action fake target get no phrase: the
 * SPEC gives them none.
 */
function ballRoles(id: string, hasPath: boolean, actions: (BallAction | null)[]): string[] {
  const out: string[] = []
  for (const a of actions) {
    if (!a) continue
    if (a.kind === 'handoff' && a.carrierId === id) out.push('gets the handoff')
    else if (a.kind === 'pitch' && a.targetId === id) out.push('gets the pitch')
    else if ((a.kind === 'pass' || a.kind === 'play-action') && a.targetId === id) {
      out.push(hasPath ? `catches it ${catchDepthWords(a)}` : 'catches it where he stands')
    }
  }
  return out
}

const carriesIn = (id: string, actions: (BallAction | null)[]) =>
  actions.some((a) => (a?.kind === 'handoff' && a.carrierId === id) || (a?.kind === 'pitch' && a.targetId === id))

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function playerSummary({ player, players, drawn, engagements, derived, ball, ballThen }: SummaryInput): string {
  const id = player.id
  const hasPath = player.path.length >= 2
  const actions = [ball, ballThen]

  // HIS JOB, beyond the path: who he meets, whether he comes off it, what he
  // does with the ball - and, always last (§7.8), that he cannot get there.
  const job: string[] = []
  const engagement = engagements.find((e) => e.a === id || e.b === id)
  const partner = engagement && players.find((p) => p.id === (engagement.a === id ? engagement.b : engagement.a))
  if (engagement && partner) {
    job.push(`${player.side === 'offense' ? 'blocks' : 'engages'} ${partner.label}`)
    if (engagement.release === id) job.push('releases')
  }
  job.push(...ballRoles(id, hasPath, actions))
  if (engagement && partner && derived.find((d) => d.id === engagement.id)?.valid === false) job.push("can't reach the block")

  // NO PATH (owner decision, ML-UX-7). "No assignment yet." only when he truly
  // has nothing to do; a man with a block or a ball role but no path is
  // described by that job - "Engages RG", "Gets the handoff" - because saying
  // he has no assignment would be false. Timing and speed describe how he runs
  // a path, so a man without one gets neither.
  if (!hasPath) return job.length ? [capitalize(job[0]), ...job.slice(1)].join(' · ') : 'No assignment yet.'

  // The path he actually runs. Always present for a man with a path; the
  // fallback derives the same thing from his anchors with the engine's own
  // helpers, so a caller that has no schedule still gets the truth.
  const pts = drawn?.pts ?? renderPath(player.path)
  const cum = drawn?.cum ?? cumulativeLength(pts)
  const length = drawn?.drawnLength ?? cum[cum.length - 1]

  const first = heading(firstStep(player.path))
  let lastBreak = -1
  for (let i = 1; i < pts.length - 1; i++) if (turnAngle(pts[i - 1], pts[i], pts[i + 1]) >= SHARP_BREAK_DEG) lastBreak = i
  const centerX = snapperOf(players)?.x ?? FIELD_WIDTH / 2
  // Two words at most, even for a three-leg route: the SPEC's vocabulary is
  // first direction, then finishing direction - "up, then up" included.
  const shape = lastBreak < 0 ? first : `${first}, then ${finish(endDirection(pts, cum), pts[lastBreak].x, centerX)}`

  const parts = [`${noun(player, first, carriesIn(id, actions), player.id === passerOf(players)?.id)} · ${Math.round(length)} yds ${shape}`]
  if (player.timing === 'pre-snap') parts.push('pre-snap')
  else if (player.timing === 'delayed') parts.push(`delayed ${player.delay} s`)
  // Owner decision: any non-default tier is said, "normal" included - a
  // receiver slowed from his usual "fast" is exactly what a coach needs told.
  if (player.speed !== defaultSpeed(player.label)) parts.push(player.speed)
  return [...parts, ...job].join(' · ')
}
