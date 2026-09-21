import { describe, expect, it } from 'vitest'
import type { BallAction } from '../engine/ball'
import { initialPlayers, type Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import { applyEngagements, type Engagement } from '../engine/interactions'
import { buildSchedule } from '../engine/timeline'
import { catchDepth } from './ballSentence'
import { playerSummary } from './playerSummary'

/**
 * THE SELECTED PLAYER'S SUMMARY (ML-UX-7, SPEC §4.4 with §4.2, §7.8, §12.6,
 * and the owner's six ML-UX-7 decisions).
 *
 * Every case is built on the default 22 and run through the engine exactly as
 * the editor runs it - buildSchedule, then applyEngagements - so the summary
 * is always read from the schedule a player really runs, never from a
 * hand-made stand-in.
 */

interface Setup {
  paths?: Record<string, [number, number][]>
  edit?: Record<string, Partial<Player>>
  without?: string[]
  engagements?: Engagement[]
  ball?: BallAction | null
  ballThen?: BallAction | null
}

/** Ids of the default 22, by label: `id('DE', 1)` is the second DE. */
const id = (label: string, nth = 0) => initialPlayers().filter((p) => p.label === label)[nth].id
const at = (label: string, nth = 0) => initialPlayers().filter((p) => p.label === label)[nth]

/** Anchors from his own alignment, each leg relative to the one before. */
function legs(p: Player, moves: [number, number][]): Pt[] {
  const out: Pt[] = [{ x: p.x, y: p.y }]
  for (const [dx, dy] of moves) out.push({ x: out[out.length - 1].x + dx, y: out[out.length - 1].y + dy })
  return out
}

function summary(of: string, setup: Setup = {}): string {
  const players = initialPlayers()
    .filter((p) => !setup.without?.includes(p.id))
    .map((p) => ({ ...p, ...(setup.paths?.[p.id] ? { path: legs(p, setup.paths[p.id]) } : {}), ...setup.edit?.[p.id] }))
  const engagements = setup.engagements ?? []
  const built = buildSchedule(players)
  const eng = applyEngagements(built.schedule, players, engagements, built.snapAt)
  const player = players.find((p) => p.id === of)!
  return playerSummary({ player, players, drawn: eng.schedule.get(of), engagements, derived: eng.derived, ball: setup.ball ?? null, ballThen: setup.ballThen ?? null })
}

const LT = id('LT'), C = id('C'), QB = id('QB'), RB = id('RB'), X = id('X'), H = id('H'), Z = id('Z'), Y = id('Y')
const DE = id('DE'), NB = id('NB'), CB = id('CB')
const block = (a: string, b: string, point: Pt, extra: Partial<Engagement> = {}): Engagement => ({ id: `e_${a}_${b}`, kind: 'engage', a, b, point, ...extra })

describe("the SPEC's four examples, exactly", () => {
  it('Route · 9 yds up, then out', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 6], [3, 0]] } })).toBe('Route · 9 yds up, then out')
  })

  it('Drop · 5 yds back', () => {
    expect(summary(QB, { paths: { [QB]: [[0, -5]] } })).toBe('Drop · 5 yds back')
  })

  it('Path · 3 yds up · blocks DE · releases', () => {
    const lt = at('LT')
    const point = { x: lt.x, y: lt.y + 3 }
    expect(summary(LT, { paths: { [LT]: [[0, 3]] }, engagements: [block(LT, DE, point, { release: LT })] })).toBe(
      'Path · 3 yds up · blocks DE · releases',
    )
  })

  it('Path · 12 yds across · pre-snap', () => {
    expect(summary(NB, { paths: { [NB]: [[-12, 0]] }, edit: { [NB]: { timing: 'pre-snap' } } })).toBe('Path · 12 yds across · pre-snap')
  })
})

describe('the noun, by the §4.2 table', () => {
  it('receivers and the tight end run a Route', () => {
    expect(summary(X, { paths: { [X]: [[0, 10]] } })).toBe('Route · 10 yds up')
    expect(summary(Y, { paths: { [Y]: [[0, 10]] } })).toBe('Route · 10 yds up')
  })

  it('the QB: Drop when his first step is back, Path when it is not', () => {
    expect(summary(QB, { paths: { [QB]: [[0, -7], [4, 0]] } })).toMatch(/^Drop · /)
    expect(summary(QB, { paths: { [QB]: [[4, 0]] } })).toBe('Path · 4 yds across')
    expect(summary(QB, { paths: { [QB]: [[0, 3]] } })).toBe('Path · 3 yds up')
  })

  it('the offensive line runs a Path, never a Route', () => {
    expect(summary(LT, { paths: { [LT]: [[0, 4]] } })).toBe('Path · 4 yds up')
    expect(summary(C, { paths: { [C]: [[0, 2]] } })).toBe('Path · 2 yds up')
  })

  it('a back is on a Path when he gets the ball, and runs a Route when he does not', () => {
    const paths = { [RB]: [[0, 8]] as [number, number][] }
    expect(summary(RB, { paths, ball: { kind: 'handoff', carrierId: RB } })).toBe('Path · 8 yds up · gets the handoff')
    expect(summary(RB, { paths, ball: { kind: 'pitch', targetId: RB } })).toBe('Path · 8 yds up · gets the pitch')
    expect(summary(RB, { paths })).toBe('Route · 8 yds up')
    // A pass is not "getting the ball" in the table's sense: he runs a route to it.
    expect(summary(RB, { paths, ball: { kind: 'pass', targetId: RB, catchPoint: { x: 25, y: 2 } } })).toMatch(/^Route · /)
  })

  it('H is a back too', () => {
    expect(summary(H, { paths: { [H]: [[0, 8]] } })).toBe('Route · 8 yds up')
    expect(summary(H, { paths: { [H]: [[0, 8]] }, ball: { kind: 'handoff', carrierId: H } })).toMatch(/^Path · /)
  })

  it('defense is on a Path', () => {
    expect(summary(CB, { paths: { [CB]: [[0, 6]] } })).toBe('Path · 6 yds up')
  })

  it('custom labels follow their side', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 10]] }, edit: { [Z]: { label: 'SL' } } })).toMatch(/^Route · /)
    expect(summary(NB, { paths: { [NB]: [[0, 5]] }, edit: { [NB]: { label: 'STAR' } } })).toMatch(/^Path · /)
  })
})

describe('the shape', () => {
  it('length is his drawn length, rounded', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 8.4]] } })).toBe('Route · 8 yds up')
    expect(summary(Z, { paths: { [Z]: [[0, 8.6]] } })).toBe('Route · 9 yds up')
  })

  it('the first step reads up, back or across, by whichever way it mostly goes', () => {
    expect(summary(Z, { paths: { [Z]: [[1, 6]] } })).toMatch(/ up$/)
    expect(summary(Z, { paths: { [Z]: [[1, -3]] } })).toMatch(/ back$/)
    expect(summary(Z, { paths: { [Z]: [[-5, 1]] } })).toMatch(/ across$/)
    // A dead heat counts as vertical.
    expect(summary(Z, { paths: { [Z]: [[-3, 3]] } })).toMatch(/ up$/)
  })

  it('a break of 60° or more adds where he finishes; a gentler bend adds nothing', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 5], [1, 5]] } })).toBe('Route · 10 yds up')
    expect(summary(Z, { paths: { [Z]: [[0, 6], [3, 0]] } })).toBe('Route · 9 yds up, then out')
  })

  it('out is away from the center and in is toward him, on either side of the ball', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 6], [3, 0]] } })).toMatch(/up, then out$/) // right side, heading right
    expect(summary(Z, { paths: { [Z]: [[0, 6], [-3, 0]] } })).toMatch(/up, then in$/) // right side, heading left
    expect(summary(X, { paths: { [X]: [[0, 6], [-3, 0]] } })).toMatch(/up, then out$/) // left side, heading left
    expect(summary(X, { paths: { [X]: [[0, 6], [3, 0]] } })).toMatch(/up, then in$/) // left side, heading right
  })

  it('finishing back, or up', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 10], [1, -3]] } })).toMatch(/up, then back$/)
    expect(summary(Z, { paths: { [Z]: [[-4, 0], [0, 6]] } })).toMatch(/across, then up$/)
  })

  it('an out-and-up says "up, then up" - two words, whatever the route (owner decision)', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 5], [3, 0], [0, 5]] } })).toBe('Route · 13 yds up, then up')
  })

  it('with no center on the field, out and in are judged from the middle of the field', () => {
    expect(summary(Z, { paths: { [Z]: [[0, 6], [3, 0]] }, without: [C] })).toMatch(/up, then out$/)
  })

  it('a lateral finish from exactly the center has no out or in', () => {
    // The QB lines up on the center's x and breaks sideways from there.
    expect(summary(QB, { paths: { [QB]: [[0, -3], [3, 0]] } })).toBe('Drop · 6 yds back, then across')
  })
})

describe('when he goes', () => {
  const paths = { [RB]: [[0, 6]] as [number, number][] }
  it('on the snap says nothing', () => {
    expect(summary(RB, { paths })).toBe('Route · 6 yds up')
  })
  it('pre-snap', () => {
    expect(summary(RB, { paths, edit: { [RB]: { timing: 'pre-snap' } } })).toBe('Route · 6 yds up · pre-snap')
  })
  it('delayed, by the seconds the editor shows', () => {
    expect(summary(RB, { paths, edit: { [RB]: { timing: 'delayed', delay: 0.5 } } })).toBe('Route · 6 yds up · delayed 0.5 s')
    expect(summary(RB, { paths, edit: { [RB]: { timing: 'delayed', delay: 1 } } })).toBe('Route · 6 yds up · delayed 1 s')
  })
})

describe('how fast - only when it is not his usual', () => {
  const paths = { [Z]: [[0, 6]] as [number, number][] }
  it('his default says nothing', () => {
    expect(summary(Z, { paths })).toBe('Route · 6 yds up')
  })
  it('controlled, normal and fast, when they differ (owner decision: "normal" included)', () => {
    expect(summary(Z, { paths, edit: { [Z]: { speed: 'controlled' } } })).toBe('Route · 6 yds up · controlled')
    expect(summary(Z, { paths, edit: { [Z]: { speed: 'normal' } } })).toBe('Route · 6 yds up · normal')
    expect(summary(LT, { paths: { [LT]: [[0, 3]] }, edit: { [LT]: { speed: 'fast' } } })).toBe('Path · 3 yds up · fast')
  })
  it('timing comes before speed', () => {
    expect(summary(Z, { paths, edit: { [Z]: { timing: 'pre-snap', speed: 'normal' } } })).toBe('Route · 6 yds up · pre-snap · normal')
  })
})

describe('blocks and engages', () => {
  const lt = at('LT')
  const point = { x: lt.x, y: lt.y + 3 }
  const setup = (extra: Partial<Engagement> = {}): Setup => ({ paths: { [LT]: [[0, 3]] }, engagements: [block(LT, DE, point, extra)] })

  it('offense blocks, defense engages - each names the other man', () => {
    expect(summary(LT, setup())).toBe('Path · 3 yds up · blocks DE')
    expect(summary(DE, setup())).toBe('Engages LT')
  })

  it('releases is said only by the man who releases', () => {
    expect(summary(LT, setup({ release: LT }))).toBe('Path · 3 yds up · blocks DE · releases')
    expect(summary(DE, setup({ release: LT }))).toBe('Engages LT')
    expect(summary(DE, setup({ release: DE }))).toBe('Engages LT · releases')
  })

  it("a block he cannot reach says so, and says it LAST (§7.8)", () => {
    // A cornerback 38 yards away, and a blocker with no path to get there.
    const far = block(LT, CB, { x: 8, y: 6.5 })
    expect(summary(LT, { engagements: [far] })).toBe("Blocks CB · can't reach the block")

    // Everything else he does, and still last.
    const rb = at('RB')
    const busy: Setup = {
      paths: { [RB]: [[0, 6]] },
      engagements: [block(RB, DE, { x: 5, y: 15 }, { release: RB })],
      ball: { kind: 'pass', targetId: RB, catchPoint: { x: rb.x, y: 0.5 } },
    }
    expect(summary(RB, busy)).toBe("Route · 6 yds up · blocks DE · releases · catches it 1 yds downfield · can't reach the block")
  })
})

describe('the ball', () => {
  const zPath = { [Z]: [[0, 10]] as [number, number][] }
  const pass = (y: number): BallAction => ({ kind: 'pass', targetId: Z, catchPoint: { x: 46, y } })

  it('a pass: where he catches it, in the ball menu\'s own words', () => {
    expect(summary(Z, { paths: zPath, ball: pass(9) })).toBe('Route · 10 yds up · catches it 9 yds downfield')
    expect(summary(Z, { paths: zPath, ball: pass(-3) })).toBe('Route · 10 yds up · catches it 3 yds behind the line')
    expect(summary(Z, { paths: zPath, ball: pass(0.2) })).toBe('Route · 10 yds up · catches it at the line')
    // One rule, two places: the strip and the ball menu's Now card agree.
    for (const y of [9, -3, 0.2]) expect(summary(Z, { paths: zPath, ball: pass(y) })).toContain(`catches it ${catchDepth(pass(y))!.replace(/^caught /, '')}`)
  })

  it('play action: the receiver catches it; the man faked to gets no phrase', () => {
    const pa: BallAction = { kind: 'play-action', fakeId: RB, targetId: Z, catchPoint: { x: 46, y: 12 } }
    expect(summary(Z, { paths: zPath, ball: pa })).toBe('Route · 10 yds up · catches it 12 yds downfield')
    expect(summary(RB, { paths: { [RB]: [[0, 3]] }, ball: pa })).toBe('Route · 3 yds up')
  })

  it("the QB's keep gets no phrase", () => {
    expect(summary(QB, { paths: { [QB]: [[3, 0]] }, ball: { kind: 'keep' } })).toBe('Path · 3 yds across')
  })

  it('the second action counts too (owner decision): handoff, pitch or pass', () => {
    const first: BallAction = { kind: 'handoff', carrierId: RB }
    const rbPath = { [RB]: [[4, 0]] as [number, number][] }
    expect(summary(Z, { paths: { ...rbPath, ...zPath }, ball: first, ballThen: { kind: 'handoff', carrierId: Z } })).toBe('Route · 10 yds up · gets the handoff')
    expect(summary(Z, { paths: { ...rbPath, ...zPath }, ball: first, ballThen: { kind: 'pitch', targetId: Z } })).toBe('Route · 10 yds up · gets the pitch')
    expect(summary(Z, { paths: { ...rbPath, ...zPath }, ball: first, ballThen: pass(9) })).toBe('Route · 10 yds up · catches it 9 yds downfield')
    // ...and a back who gets it second is on a Path, like one who gets it first.
    expect(summary(H, { paths: { ...rbPath, [H]: [[-4, 0]] }, ball: first, ballThen: { kind: 'handoff', carrierId: H } })).toMatch(/^Path · /)
  })
})

describe('no path', () => {
  it('nothing to do at all: No assignment yet.', () => {
    expect(summary(Z)).toBe('No assignment yet.')
    expect(summary(DE)).toBe('No assignment yet.')
  })

  it('a real job without a path is described by the job, never as "No assignment yet." (owner decision)', () => {
    expect(summary(Z, { ball: { kind: 'pass', targetId: Z, catchPoint: { x: 46, y: -1.6 } } })).toBe('Catches it where he stands')
    expect(summary(RB, { ball: { kind: 'handoff', carrierId: RB } })).toBe('Gets the handoff')
    expect(summary(RB, { ball: { kind: 'pitch', targetId: RB } })).toBe('Gets the pitch')
    const lt = at('LT')
    expect(summary(LT, { engagements: [block(LT, DE, { x: lt.x - 0.5, y: 0.5 })] })).toBe('Blocks DE')
  })

  it('timing and speed describe how he runs a path, so a man without one gets neither', () => {
    const lt = at('LT')
    expect(summary(LT, { engagements: [block(LT, DE, { x: lt.x - 0.5, y: 0.5 })], edit: { [LT]: { timing: 'pre-snap', speed: 'fast' } } })).toBe('Blocks DE')
  })
})

describe('it only reads', () => {
  it('writes nothing to what it is given', () => {
    const players = initialPlayers().map((p) => (p.id === Z ? { ...p, path: legs(p, [[0, 6], [3, 0]]) } : p))
    const engagements: Engagement[] = [block(LT, DE, { x: 23, y: 0.5 }, { release: LT, auto: true })]
    const built = buildSchedule(players)
    const eng = applyEngagements(built.schedule, players, engagements, built.snapAt)
    const ball: BallAction = { kind: 'pass', targetId: Z, catchPoint: { x: 49, y: 4.4 } }
    const before = JSON.stringify({ players, engagements, ball })
    const deepFreeze = <T,>(o: T): T => {
      Object.values(o as object).forEach((v) => v && typeof v === 'object' && deepFreeze(v))
      return Object.freeze(o)
    }
    deepFreeze(players)
    deepFreeze(engagements)
    deepFreeze(ball)
    for (const player of players) {
      playerSummary({ player, players, drawn: eng.schedule.get(player.id), engagements, derived: eng.derived, ball, ballThen: null })
    }
    expect(JSON.stringify({ players, engagements, ball })).toBe(before)
  })

  it('without a schedule it reads the same path from his anchors', () => {
    const players = initialPlayers().map((p) => (p.id === Z ? { ...p, path: legs(p, [[0, 6], [3, 0]]) } : p))
    const z = players.find((p) => p.id === Z)!
    const built = buildSchedule(players)
    const args = { player: z, players, engagements: [], derived: [], ball: null, ballThen: null }
    expect(playerSummary({ ...args, drawn: undefined })).toBe(playerSummary({ ...args, drawn: built.schedule.get(Z) }))
  })
})
