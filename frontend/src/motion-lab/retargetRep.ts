// SAME SITUATION, NOW TEST THE NICKEL - a variation's whole Rep re-pointed at
// another man by his label. Each decision that can be (not yet received)
// gets the new man, the words for him, the ring in its moment and a redrawn
// still - the same keep-them-together rules as Change man (decisionMan). A
// play with TWO such men (two CBs) goes to the coach to choose on the field;
// a play with none is said. Never guessed. Nothing is sent.

import { getMotionPlay } from '../api/motionLab'
import type { RepDecision } from '../api/reps'
import { manLabelled, menOf, redrawStill, ringOn, wordsFor, type Man } from './decisionMan'
import type { Play } from './engine/play'
import type { PresnapClip } from './presnap'
import { playFromRow } from './storage/apiPlayRepository'

/** A decision whose play has more than one man with the label: the coach picks. */
export interface Choice {
  decision: RepDecision
  clip: PresnapClip | null
  play: Play | null
  candidates: Man[]
}

export interface Retarget {
  questionId: number
  number: number
  body: { subject_man: string; subject_role: string; presnap?: PresnapClip }
  image: File | null
  /** Its spots are places: they stay where the coach put them - worth a look. */
  checkSpots: boolean
}

async function sourceOf(d: RepDecision, canOpenPlay: boolean, plays: Map<number, Play | null>) {
  const clip = (d.presnap as unknown as PresnapClip | null) ?? null
  if (clip || !canOpenPlay || d.motion_play_id === null) return { clip, play: null }
  if (!plays.has(d.motion_play_id)) {
    plays.set(d.motion_play_id, await getMotionPlay(d.motion_play_id).then(playFromRow).catch(() => null))
  }
  return { clip, play: plays.get(d.motion_play_id) ?? null }
}

/** The labels a coach can test across the Rep: every man the decisions' plays have, defense first. */
export async function testableLabels(decisions: RepDecision[], canOpenPlay: boolean): Promise<string[]> {
  const plays = new Map<number, Play | null>()
  const seen = new Map<string, 'offense' | 'defense'>()
  for (const d of decisions) {
    const { clip, play } = await sourceOf(d, canOpenPlay, plays)
    for (const m of menOf(clip, play)) if (!seen.has(m.label)) seen.set(m.label, m.side)
  }
  return [...seen.entries()]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'defense' ? -1 : 1))
    .map(([label]) => label)
}

/** Every decision re-pointed at the man labelled `label`, and why the others were not. */
export async function retargetRep(
  decisions: RepDecision[],
  label: string,
  canOpenPlay: boolean,
): Promise<{ changes: Retarget[]; skipped: { number: number; why: string }[]; choose: Choice[] }> {
  const plays = new Map<number, Play | null>()
  const changes: Retarget[] = []
  const skipped: { number: number; why: string }[] = []
  const choose: Choice[] = []
  for (const d of decisions) {
    if (d.delivered) {
      skipped.push({ number: d.number, why: 'players have it' })
      continue
    }
    const { clip, play } = await sourceOf(d, canOpenPlay, plays)
    const men = menOf(clip, play)
    if (men.length === 0) {
      skipped.push({ number: d.number, why: 'it is not from a play' })
      continue
    }
    const man = manLabelled(men, label)
    if (!man) {
      const same = men.filter((m) => m.label.toUpperCase() === label.trim().toUpperCase())
      if (same.length === 0) skipped.push({ number: d.number, why: `its play has no ${label}` })
      else choose.push({ decision: d, clip, play, candidates: same })
      continue
    }
    if (d.subject_man?.id === man.id) {
      skipped.push({ number: d.number, why: `it already tests the ${label}` })
      continue
    }
    changes.push(await retargetOne(d, man, clip, play))
  }
  return { changes, skipped, choose }
}

/** One decision re-pointed at one man - the man the coach chose, or the only one. */
export async function retargetOne(d: RepDecision, man: Man, clip: PresnapClip | null, play: Play | null): Promise<Retarget> {
  return {
    questionId: d.question_id,
    number: d.number,
    body: { subject_man: man.id, subject_role: wordsFor(man), ...(clip ? { presnap: ringOn(clip, man.id) } : {}) },
    image: await redrawStill(clip, play, man.id).catch(() => null),
    checkSpots: !!d.tap_targets?.some((t) => t.zone),
  }
}
