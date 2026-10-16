// A QUIZ QUESTION FROM A MOTION LAB PLAY - the one builder behind Motion Lab's
// "Make question" and the quiz editor's "From Motion Lab".
//
//   draw  "Draw your assignment": a Draw question on a picture of the
//         formation. Routes are hidden, so the picture is not the answer.
//         The coach can name the man it is about ("You're the X."), and the
//         picture rings him.
//   ball  "Who gets the ball?": multiple choice, offered when the play gives
//         the ball to someone. The receivers and backs (never the QB or the
//         line) are the choices; the play's own target is the answer. The
//         picture shows the routes, so the concept can be read.

import type { QuestionInput } from '../api/questions'
import { ballTargetOf } from './engine/ball'
import type { Play } from './engine/play'
import { playImage } from './playImage'
import { freezePicture, type PresnapClip } from './presnap'

export type PlayQuestionKind = 'draw' | 'ball'

export const QUESTION_TEXT: Record<PlayQuestionKind, string> = {
  draw: 'Draw your assignment on this play.',
  ball: 'Who gets the ball on this play?',
}

/** The Draw question's words: about one man when the coach names him. */
export function drawText(label?: string | null): string {
  return label ? `You're the ${label}. Draw your assignment.` : QUESTION_TEXT.draw
}

/** Whether `text` is words this builder wrote (so naming a man may rewrite them), not the coach's own. */
export function isBuiltDrawText(text: string): boolean {
  return text.trim() === QUESTION_TEXT.draw || /^You're the .+\. Draw your assignment\.$/.test(text.trim())
}

/** Whether the picture shows the routes, by default, for each kind. */
export const SHOWS_ROUTES: Record<PlayQuestionKind, boolean> = { draw: false, ball: true }

/** The quarterback and the line: never the answer to "who gets the ball". */
const NOT_A_TARGET = new Set(['QB', 'C', 'LT', 'LG', 'RG', 'RT', 'OL', 'G', 'T'])

/** The choices for "Who gets the ball?" - offensive men who could, by label, once each - or null when the play gives the ball to nobody. */
export function ballChoices(play: Play): { target: string; choices: string[] } | null {
  const targetId = ballTargetOf(play.ball) ?? (play.ball?.kind === 'handoff' ? play.ball.carrierId : null)
  const target = play.players.find((p) => p.id === targetId)
  if (!target) return null
  const labels: string[] = []
  for (const p of play.players) {
    if (p.side !== 'offense' || NOT_A_TARGET.has(p.label.toUpperCase()) || labels.includes(p.label)) continue
    labels.push(p.label)
  }
  if (!labels.includes(target.label) || labels.length < 2) return null
  const six = labels.slice(0, 6)
  return { target: target.label, choices: six.includes(target.label) ? six : [...labels.slice(0, 5), target.label] }
}

/** The question to create (without its picture). */
export function playQuestionInput(play: Play, kind: PlayQuestionKind, text = QUESTION_TEXT[kind]): QuestionInput {
  const ball = kind === 'ball' ? ballChoices(play) : null
  if (ball) {
    return { question_text: text.trim(), question_type: 'multiple_choice', options: ball.choices.map((c) => ({ option_text: c, is_correct_answer: c === ball.target })) }
  }
  return { question_text: text.trim(), question_type: 'draw_response', options: [] }
}

/** The play's picture, as the PNG file the question is created with. With
 *  the motion playing it is the play AT THE DECISION MOMENT - the frame the
 *  player is left looking at, so a drawing goes on exactly what he saw. */
export async function playImageFile(
  play: Play,
  routes: boolean,
  highlight: string | null = null,
  presnap: PresnapClip | null = null,
): Promise<File> {
  const frozen = presnap ? freezePicture(presnap) : null
  const blob = await (frozen ? playImage(frozen.play, frozen.options) : playImage(play, highlight ? { routes, highlight } : { routes }))
  return new File([blob], `${play.name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'play'}.png`, { type: 'image/png' })
}
