// A SITUATIONAL REP FROM A MOTION LAB PLAY - the football-native shortcuts
// behind Motion Lab's "Make rep" panel.
//
// A Rep decision is: who you are ("Boundary safety"), the situation ("#3
// motions across. What is your check?"), two to five answers with the coach's
// one right answer, a concept ("Motion adjustment") and an optional reason.
// It is stored as an ordinary multiple-choice question (see api/reps.ts), so
// everything here only saves the coach typing.

import { ballTargetOf } from './engine/ball'
import { FIELD_WIDTH } from './engine/field'
import type { Player } from './engine/formation'
import type { Pt } from './engine/geometry'
import { hashX, type Play } from './engine/play'

/** "FS" -> "Free safety": what a coach would call the man he tapped. Editable. */
const ROLE_NAMES: Record<string, string> = {
  FS: 'Free safety',
  SS: 'Strong safety',
  S: 'Safety',
  CB: 'Corner',
  NB: 'Nickel',
  DB: 'Defensive back',
  LB: 'Linebacker',
  MLB: 'Mike',
  M: 'Mike',
  MIKE: 'Mike',
  W: 'Will',
  WILL: 'Will',
  SAM: 'Sam',
  DE: 'Defensive end',
  DT: 'Defensive tackle',
  NT: 'Nose',
  QB: 'Quarterback',
  RB: 'Running back',
  TB: 'Tailback',
  FB: 'Fullback',
  TE: 'Tight end',
  C: 'Center',
  LT: 'Left tackle',
  LG: 'Left guard',
  RG: 'Right guard',
  RT: 'Right tackle',
  X: 'X receiver',
  Z: 'Z receiver',
  Y: 'Y',
  H: 'H',
}

export function roleName(player: Pick<Player, 'label'>): string {
  return ROLE_NAMES[player.label.toUpperCase()] ?? player.label
}

/** A one-tap set of answers for the decisions coaches ask most. */
export interface AnswerSet {
  id: string
  label: string
  answers: (play: Play) => string[]
}

const OFFENSE_NOT_A_TARGET = new Set(['QB', 'C', 'LT', 'LG', 'RG', 'RT', 'OL', 'G', 'T'])

/** Places on the field an answer can name - and the player can tap. */
const GAP_SPOTS = ['A gap', 'B gap', 'C gap', 'D gap']
const ZONE_SPOTS = ['Flat', 'Curl', 'Hook', 'Deep third']

export const ANSWER_SETS: AnswerSet[] = [
  { id: 'coverage', label: 'Coverage', answers: () => ['Cover 1', 'Cover 2', 'Cover 3', 'Quarters'] },
  { id: 'leverage', label: 'Leverage', answers: () => ['Inside', 'Outside', 'Head up'] },
  { id: 'gap', label: 'Gap', answers: () => [...GAP_SPOTS] },
  { id: 'zone', label: 'Zone drop', answers: () => [...ZONE_SPOTS] },
  { id: 'run-fit', label: 'Run fit', answers: () => ['Force', 'Spill', 'Alley', 'Cutback'] },
  { id: 'run-pass', label: 'Run / pass', answers: () => ['Run', 'Pass'] },
  {
    id: 'players',
    label: 'Players',
    // The men who could get the ball, once each - as "Who gets the ball?" uses.
    answers: (play) => {
      const labels: string[] = []
      for (const p of play.players) {
        if (p.side !== 'offense' || OFFENSE_NOT_A_TARGET.has(p.label.toUpperCase()) || labels.includes(p.label)) continue
        labels.push(p.label)
      }
      return labels.slice(0, 5)
    },
  },
]

/**
 * TAP THE MAN: when every answer names exactly one man in the play ("X",
 * "Z", "H"), where each stands in the picture - one {x, y} per answer, as
 * fractions of the picture - so the player can tap him instead of a button.
 * Null when any answer is not a man, or names two (two "WR"s).
 */
export function tapTargets(play: Play, answers: string[], at: (p: Player) => { x: number; y: number }): { x: number; y: number }[] | null {
  if (answers.length < 2) return null
  const out: { x: number; y: number }[] = []
  for (const text of answers) {
    const men = play.players.filter((p) => p.label.toUpperCase() === text.trim().toUpperCase())
    if (men.length !== 1) return null
    out.push(at(men[0]))
  }
  return out
}

/**
 * TAP THE SPOT: when every answer names a place on the field - a gap ("A gap"
 * ... "D gap") or a zone ("Flat", "Curl", "Hook", "Deep third") - where each
 * is, in field yards, ON THE SIDE OF THE MAN the decision is about (his gaps,
 * his drops). Gaps sit between that side's linemen as the coach aligned them;
 * zones by the ball and the sideline. Null when any answer is not a place.
 */
export function fieldSpots(play: Play, answers: string[], whoId: string | null): Pt[] | null {
  if (answers.length < 2) return null
  const ball = ballX(play)
  const man = play.players.find((p) => p.id === whoId)
  const side = man && man.x < ball ? -1 : 1
  const out: Pt[] = []
  for (const text of answers) {
    const key = text.trim().toLowerCase()
    const gap = GAP_SPOTS.findIndex((g) => g.toLowerCase() === key)
    const zone = ZONE_SPOTS.findIndex((z) => z.toLowerCase() === key)
    if (gap >= 0) out.push(gapSpots(play, ball, side)[gap])
    else if (zone >= 0) out.push(zoneSpots(ball, side)[zone])
    else return null
  }
  return out
}

/** Spots for answers that name no man and no known place - an even row
 *  across the field for the coach to drag where he means each one. */
export function spreadSpots(count: number): Pt[] {
  const left = 12
  const right = FIELD_WIDTH - 12
  return Array.from({ length: count }, (_, i) => ({
    x: count === 1 ? FIELD_WIDTH / 2 : left + ((right - left) * i) / (count - 1),
    y: 8,
  }))
}

/** Where the football is: over the center, else the hash it is spotted on. */
function ballX(play: Play): number {
  const center = play.players.find((p) => p.side === 'offense' && p.label.toUpperCase() === 'C')
  return center ? center.x : hashX(play.situation.hash)
}

/** A, B, C, D on one side: between the center, guard, tackle and tight end as
 *  aligned - an ordinary split (1.5 yd) standing in for a man the play lacks. */
function gapSpots(play: Play, ball: number, side: 1 | -1): Pt[] {
  const out = play.players
    .filter((p) => p.side === 'offense' && p.y >= -1.6 && p.y <= 0.5)
    .map((p) => (p.x - ball) * side)
    .filter((d) => d >= -0.3 && d <= 6)
    .sort((a, b) => a - b)
  const edges: number[] = []
  for (const d of out) {
    // The line is contiguous; a man well apart from it is not on it.
    if (edges.length === 0 ? d <= 0.6 : d - edges[edges.length - 1] <= 2.5) edges.push(d)
  }
  const at = (k: number) => edges[k] ?? (edges.length ? edges[edges.length - 1] + 1.5 * (k - edges.length + 1) : 1.5 * k)
  const yards = [(at(0) + at(1)) / 2, (at(1) + at(2)) / 2, (at(2) + at(3)) / 2, at(3) + 1.6]
  return yards.map((d) => ({ x: ball + side * d, y: 1 }))
}

/** Flat, curl, hook and deep third on one side - by the ball and the sideline. */
function zoneSpots(ball: number, side: 1 | -1): Pt[] {
  const sideline = side < 0 ? 0 : FIELD_WIDTH
  const fromSideline = (yards: number) => sideline - side * yards
  const flat = fromSideline(6)
  const hook = ball + side * 5
  // Shallow and deep enough to stay clear of the men aligned there (a corner
  // at 6-7 yards, the picture's corner tag at its top edge).
  return [
    { x: flat, y: 2.5 },
    { x: (flat + hook) / 2, y: 10 },
    { x: hook, y: 7 },
    { x: fromSideline(FIELD_WIDTH / 6), y: 13 },
  ]
}

/**
 * THE QUESTIONS COACHES ASK, one tap each. A prompt that implies its answers
 * fills them too ("Identify the coverage." -> Cover 1 / 2 / 3 / Quarters).
 */
export const SITUATION_PROMPTS: { label: string; text: string; answers?: AnswerSet['id'] }[] = [
  { label: 'Your check?', text: 'What is your check?' },
  { label: 'Who do you have?', text: 'Who do you have?' },
  { label: 'Your leverage?', text: 'What is your leverage?', answers: 'leverage' },
  { label: 'The coverage?', text: 'Identify the coverage.', answers: 'coverage' },
  { label: 'Who gets the ball?', text: 'Who gets the ball?', answers: 'players' },
  { label: 'Your gap?', text: 'What is your gap?', answers: 'gap' },
  { label: 'Your drop?', text: 'Where is your drop?', answers: 'zone' },
  { label: 'Your run fit?', text: 'What is your run fit?', answers: 'run-fit' },
]

/** "#3 motions across." + "What is your check?" -> one situation; never the same question twice. */
export function addPrompt(current: string, text: string): string {
  const now = current.trim()
  if (!now) return text
  if (now.toLowerCase().endsWith(text.toLowerCase())) return now
  return `${now} ${text}`
}

/** The man the play gives the ball to, by label - the right answer to "Who gets the ball?" when PEIRA knows it. */
export function ballTargetLabel(play: Play): string | null {
  const id = ballTargetOf(play.ball) ?? (play.ball?.kind === 'handoff' ? play.ball.carrierId : null)
  return play.players.find((p) => p.id === id)?.label ?? null
}

/** WHAT THE COACH SAID LAST TIME, so the next decision does not start from nothing. */
export interface RepMemory {
  playId: string
  who: string | null
  role: string
  concept: string
  repId: number | null
  /** Concepts this coach used most recently, newest first. */
  recentConcepts: string[]
}

const MEMORY_KEY = 'peira.makeRep.v1'

export function readRepMemory(): RepMemory | null {
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY)
    return raw ? (JSON.parse(raw) as RepMemory) : null
  } catch {
    return null
  }
}

export function writeRepMemory(memory: RepMemory): void {
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory))
  } catch {
    // A private window: the next decision simply starts blank.
  }
}

/** Whether anyone in the play moves before the snap (so the picture should show it). */
export function hasMotion(play: Play): boolean {
  return play.players.some((p) => (p.motion?.length ?? 0) >= 2 || (p.timing === 'pre-snap' && p.path.length >= 2))
}

/** The new Rep's name: "Trips Jet - Boundary safety". */
export function repTitle(play: Play, role: string): string {
  const name = play.name.trim() || 'Rep'
  return role.trim() ? `${name} - ${role.trim()}` : name
}
