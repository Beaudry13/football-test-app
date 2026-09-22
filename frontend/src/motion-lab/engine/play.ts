// A PLAY is the coach's intent, and nothing else: who is on the field,
// where they line up, what each one is asked to do, what the ball does,
// which pairs engage, and the down/distance/spot it is taught in. Every
// meeting time, release, flight, continuation and facing is recomputed
// from this when the play opens. Nothing derived is ever stored.
//
// A LOOK is just the starting arrangement - players, sides, labels,
// alignments - reusable as the seed of any number of plays. Once loaded
// into a play it is an independent copy.

import type { BallAction } from './ball'
import { HASH_LEFT, HASH_RIGHT, FIELD_WIDTH } from './field'
import { initialPlayers, type Player, type PlayerRole } from './formation'
import type { Engagement } from './interactions'

/**
 * 1: the prototype's play. 2: players may carry a `role` (who throws it, who
 * snaps it), so labels are the coach's to change.
 *
 * The number is what stops an OLDER tab from silently undoing this: its
 * loader rebuilds players without a role and would save them away, so the
 * server refuses a write whose version is below the one already stored.
 */
export const SCHEMA_VERSION = 2

export type Hash = 'left' | 'middle' | 'right'
export type PathFilter = 'all' | 'offense' | 'defense' | 'none'

export interface Situation {
  /** Yards from the offense's own goal line, 1..99. Labels and the line to gain hang off it. */
  losYard: number
  hash: Hash
  down: 1 | 2 | 3 | 4
  distance: number
  /** Down, distance and line to gain drawn on the field. */
  show: boolean
}

export interface Play {
  v: number
  id: string
  name: string
  createdAt: number
  updatedAt: number
  players: Player[]
  ball: BallAction | null
  ballThen: BallAction | null
  engagements: Engagement[]
  situation: Situation
  /** Display preference that belongs to the play: which paths are shown when teaching. */
  filter: PathFilter
}

export interface Look {
  v: number
  id: string
  name: string
  updatedAt: number
  players: Player[]
}

export const defaultSituation = (): Situation => ({ losYard: 35, hash: 'middle', down: 1, distance: 10, show: true })

export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`

/** The x a hash setting puts the football on. */
export const hashX = (h: Hash) => (h === 'left' ? HASH_LEFT : h === 'right' ? HASH_RIGHT : FIELD_WIDTH / 2)

/** "2nd & 7 · own 35 · L hash" - one glance. */
export function situationLabel(s: Situation): string {
  const ord = ['1st', '2nd', '3rd', '4th'][s.down - 1]
  const spot = s.losYard === 50 ? '50' : s.losYard < 50 ? `own ${s.losYard}` : `opp ${100 - s.losYard}`
  const togo = s.losYard + s.distance >= 100 ? 'goal' : String(s.distance)
  const hash = s.hash === 'middle' ? 'middle' : s.hash === 'left' ? 'L hash' : 'R hash'
  return `${ord} & ${togo} · ${spot} · ${hash}`
}

/** Field y of the line to gain, or null when it is past the goal line (the goal line is drawn instead). */
export function lineToGainY(s: Situation): number | null {
  if (!s.show) return null
  return s.losYard + s.distance >= 100 ? 100 - s.losYard : s.distance
}

export function newPlay(name = 'Untitled Play', players: Player[] = initialPlayers()): Play {
  const now = Date.now()
  return {
    v: SCHEMA_VERSION,
    id: newId('play_'),
    name,
    createdAt: now,
    updatedAt: now,
    players: players.map((p) => ({ ...p, path: [] })),
    ball: null,
    ballThen: null,
    engagements: [],
    situation: defaultSituation(),
    filter: 'all',
  }
}

/**
 * A look is the arrangement only: paths, timing and end behaviour don't
 * travel. Roles do: who snaps it and who throws it is part of how a formation
 * lines up, and a coach who saves "Trips Rt" and starts a play from it should
 * not have to say again which man is the quarterback.
 */
export function lookFromPlayers(name: string, players: Player[]): Look {
  return {
    v: SCHEMA_VERSION,
    id: newId('look_'),
    name,
    updatedAt: Date.now(),
    players: players.map((p) => ({ id: p.id, side: p.side, label: p.label, x: p.x, y: p.y, path: [], timing: 'on-snap' as const, delay: 0.5, speed: p.speed, ...(p.role ? { role: p.role } : null) })),
  }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const isPt = (p: unknown): p is { x: number; y: number } => !!p && typeof p === 'object' && isNum((p as { x: unknown }).x) && isNum((p as { y: unknown }).y)

function sanitizePlayer(raw: unknown): Player | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !isNum(r.x) || !isNum(r.y)) return null
  const side = r.side === 'defense' ? 'defense' : 'offense'
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 4) : side === 'offense' ? 'O' : 'D'
  const path = Array.isArray(r.path) ? (r.path.filter(isPt) as Player['path']) : []
  const timing = r.timing === 'pre-snap' || r.timing === 'delayed' ? r.timing : 'on-snap'
  const speed = r.speed === 'controlled' || r.speed === 'fast' ? r.speed : 'normal'
  const endBehavior = r.endBehavior === 'continue' || r.endBehavior === 'settle' ? r.endBehavior : undefined
  // ROLE: ABSENT STAYS ABSENT, the same rule as Engagement.auto. A play
  // written before roles existed must come back exactly as it was written, so
  // the engine keeps reading its labels; writing `role: undefined` in here
  // would be a change to every one of those documents. Defence carries no
  // role - nothing reads its labels.
  const role = side === 'offense' && (r.role === 'passer' || r.role === 'snapper') ? { role: r.role as PlayerRole } : null
  return { id: r.id, side, label, x: r.x, y: r.y, path: path.length >= 2 ? path : [], timing, delay: isNum(r.delay) ? r.delay : 0.5, speed, endBehavior, ...role }
}

/** A ball action is kept only if every player it names still exists. */
function sanitizeBall(raw: unknown, ids: Set<string>): BallAction | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  switch (a.kind) {
    case 'keep':
      return { kind: 'keep' }
    case 'handoff':
      return typeof a.carrierId === 'string' && ids.has(a.carrierId) ? { kind: 'handoff', carrierId: a.carrierId } : null
    case 'pitch':
      return typeof a.targetId === 'string' && ids.has(a.targetId) ? { kind: 'pitch', targetId: a.targetId } : null
    case 'pass':
      return typeof a.targetId === 'string' && ids.has(a.targetId) && isPt(a.catchPoint)
        ? { kind: 'pass', targetId: a.targetId, catchPoint: a.catchPoint, releasePoint: isPt(a.releasePoint) ? a.releasePoint : undefined }
        : null
    case 'play-action':
      return typeof a.targetId === 'string' && ids.has(a.targetId) && typeof a.fakeId === 'string' && ids.has(a.fakeId) && isPt(a.catchPoint)
        ? { kind: 'play-action', fakeId: a.fakeId, targetId: a.targetId, catchPoint: a.catchPoint, releasePoint: isPt(a.releasePoint) ? a.releasePoint : undefined }
        : null
    default:
      return null
  }
}

/**
 * Repair whatever we can and drop whatever we can't. A missing field gets
 * its default; a reference to a player who no longer exists is removed
 * rather than pointed at somebody else. Returns null only if there is no
 * usable play at all.
 */
export function sanitizePlay(raw: unknown): Play | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const players = Array.isArray(r.players) ? (r.players.map(sanitizePlayer).filter((p): p is Player => !!p) as Player[]) : []
  if (players.length === 0) return null
  // Duplicate ids would make every reference ambiguous; keep the first.
  const seen = new Set<string>()
  const unique = players.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
  // One passer, one snapper. Two of either would make `roleHolder` depend on
  // list order - the very thing roles exist to stop - so a second claim is
  // dropped and the first man keeps the job.
  const taken = new Set<string>()
  const withRoles = unique.map((p) => {
    if (!p.role) return p
    if (taken.has(p.role)) {
      const { role: _dropped, ...rest } = p
      return rest
    }
    taken.add(p.role)
    return p
  })
  const ids = new Set(unique.map((p) => p.id))
  const ball = sanitizeBall(r.ball, ids)
  const ballThen = ball ? sanitizeBall(r.ballThen, ids) : null
  const engagements: Engagement[] = Array.isArray(r.engagements)
    ? (r.engagements as unknown[])
        .map((e): Engagement | null => {
          if (!e || typeof e !== 'object') return null
          const x = e as Record<string, unknown>
          if (typeof x.a !== 'string' || typeof x.b !== 'string' || !ids.has(x.a) || !ids.has(x.b) || x.a === x.b || !isPt(x.point)) return null
          const release = typeof x.release === 'string' && (x.release === x.a || x.release === x.b) ? x.release : undefined
          // ML-UX-5: `auto` says PEIRA chose the point, not the coach. Carried
          // through so it survives a reload; no engine code reads it.
          //
          // ABSENT STAYS ABSENT. Writing `auto: false` into a play that never
          // had the key would break the round-trip every older play relies on
          // - a stored play must come back exactly as it was written. Absent
          // is falsy, so a play from before ML-UX-5 is read as the coach
          // having placed the point, which is the safe reading.
          const auto = 'auto' in x ? { auto: x.auto === true } : null
          return { id: typeof x.id === 'string' ? x.id : newId('e'), kind: 'engage', a: x.a, b: x.b, point: x.point, release, ...auto }
        })
        .filter((e): e is Engagement => !!e)
    : []
  const s = (r.situation && typeof r.situation === 'object' ? r.situation : {}) as Record<string, unknown>
  const d = defaultSituation()
  const situation: Situation = {
    losYard: isNum(s.losYard) ? Math.max(1, Math.min(99, Math.round(s.losYard))) : d.losYard,
    hash: s.hash === 'left' || s.hash === 'right' ? s.hash : 'middle',
    down: s.down === 2 || s.down === 3 || s.down === 4 ? s.down : 1,
    distance: isNum(s.distance) ? Math.max(1, Math.min(99, Math.round(s.distance))) : d.distance,
    show: typeof s.show === 'boolean' ? s.show : true,
  }
  const now = Date.now()
  return {
    v: SCHEMA_VERSION,
    id: typeof r.id === 'string' ? r.id : newId('play_'),
    name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Untitled Play',
    createdAt: isNum(r.createdAt) ? r.createdAt : now,
    updatedAt: isNum(r.updatedAt) ? r.updatedAt : now,
    players: withRoles,
    ball,
    ballThen,
    engagements,
    situation,
    filter: r.filter === 'offense' || r.filter === 'defense' || r.filter === 'none' ? r.filter : 'all',
  }
}

export function sanitizeLook(raw: unknown): Look | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const players = Array.isArray(r.players) ? (r.players.map(sanitizePlayer).filter((p): p is Player => !!p) as Player[]) : []
  if (players.length === 0) return null
  return {
    v: SCHEMA_VERSION,
    id: typeof r.id === 'string' ? r.id : newId('look_'),
    name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Untitled Look',
    updatedAt: isNum(r.updatedAt) ? r.updatedAt : Date.now(),
    players: players.map((p) => ({ ...p, path: [] })),
  }
}
