// A SITUATIONAL REP FROM A MOTION LAB PLAY - the football-native shortcuts
// behind Motion Lab's "Make rep" panel.
//
// A Rep decision is: who you are ("Boundary safety"), the situation ("#3
// motions across. What is your check?"), two to five answers with the coach's
// one right answer, a concept ("Motion adjustment") and an optional reason.
// It is stored as an ordinary multiple-choice question (see api/reps.ts), so
// everything here only saves the coach typing.

import type { Player } from './engine/formation'
import type { Play } from './engine/play'

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

export const ANSWER_SETS: AnswerSet[] = [
  { id: 'coverage', label: 'Coverage', answers: () => ['Cover 1', 'Cover 2', 'Cover 3', 'Quarters'] },
  { id: 'leverage', label: 'Leverage', answers: () => ['Inside', 'Outside', 'Head up'] },
  { id: 'gap', label: 'Gap', answers: () => ['A gap', 'B gap', 'C gap', 'D gap'] },
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

/** Whether anyone in the play moves before the snap (so the picture should show it). */
export function hasMotion(play: Play): boolean {
  return play.players.some((p) => (p.motion?.length ?? 0) >= 2)
}

/** The new Rep's name: "Trips Jet - Boundary safety". */
export function repTitle(play: Play, role: string): string {
  const name = play.name.trim() || 'Rep'
  return role.trim() ? `${name} - ${role.trim()}` : name
}
