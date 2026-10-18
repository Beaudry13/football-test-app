// THE TESTED MAN, KEPT TOGETHER - which man a decision is about, the coach's
// words for him ("You're the Free safety"), the ring in its moving picture,
// and the ring in its still. Changing the man changes all four; nothing here
// changes one without the others.
//
// Read from the decision's own pre-snap moment when it has one (every motion
// decision does), else from the Motion Lab play it came from when the coach
// can open it. Loaded only when a coach edits a decision.

import type { TapTarget } from '../components/football/tapTargets'
import type { Play } from './engine/play'
import { IMAGE_HEIGHT, IMAGE_WIDTH, playImage } from './playImage'
import { px } from './playImageLayout'
import { fieldSpots, roleName, tapTargets } from './playRep'
import { freezeSpots, hasPresnapMotion, presnapFrame, presnapTimeline, type PresnapClip } from './presnap'

export interface Man {
  id: string
  label: string
  side: 'offense' | 'defense'
}

/** Every man the decision's picture has, from its moment or its play. */
export function menOf(clip: PresnapClip | null, play: Play | null): Man[] {
  const men = clip?.players ?? play?.players ?? []
  return men.map((m) => ({ id: m.id, label: m.label, side: m.side }))
}

/** The one man with this label ("NB"), or null when there is none - or two. */
export function manLabelled(men: Man[], label: string): Man | null {
  const found = men.filter((m) => m.label.toUpperCase() === label.trim().toUpperCase())
  return found.length === 1 ? found[0] : null
}

/** What a coach calls him: "NB" -> "Nickel". */
export const wordsFor = (man: Pick<Man, 'label'>) => roleName(man)

/** The same moment with the ring on another man. */
export function ringOn(clip: PresnapClip, manId: string): PresnapClip {
  return { ...clip, highlight: manId }
}

/** The picture a player taps on, as a play and the man ringed: the moment's
 *  alignment frame (with its motion), else the play itself. */
function stillOf(clip: PresnapClip | null, play: Play | null): Play | null {
  if (clip) {
    const line = presnapTimeline(clip)
    return presnapFrame({ ...clip, freeze: 'before' }, { ...line, moment: 'snap' }, line.from)
  }
  return play
}

/** The decision's still, redrawn with the ring on `manId` - the uploaded
 *  picture Teach, results and the fallback show. Null with nothing to draw. */
export async function redrawStill(clip: PresnapClip | null, play: Play | null, manId: string, name = 'rep'): Promise<File | null> {
  const still = stillOf(clip, play)
  if (!still) return null
  const motion = clip ? true : hasPresnapMotion(still)
  const blob = await playImage(still, { routes: false, motion, highlight: manId })
  return new File([blob], `${name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'rep'}.png`, { type: 'image/png' })
}

/** Where the men a decision's answers name stand at its decision moment - for
 *  re-placing "tap the man" spots when the moment changes. Null when the
 *  answers are not all men. */
export function menSpotsAt(clip: PresnapClip, answers: string[]): TapTarget[] | null {
  const spots = freezeSpots(clip)
  const players = clip.players.map((m) => ({ ...m, path: [], delay: 0 })) as unknown as Play['players']
  return tapTargets({ players } as Play, answers, (p) => {
    const at = spots.get(p.id) ?? p
    return { x: px(at).x / IMAGE_WIDTH, y: px(at).y / IMAGE_HEIGHT }
  })
}

/** PEIRA's SUGGESTED places for this man (his gaps, his drops) - geometry
 *  from the alignment, a starting point for the coach, never football truth.
 *  Null when the answers are not places PEIRA knows. */
export function suggestPlaces(clip: PresnapClip | null, play: Play | null, answers: string[], manId: string | null): TapTarget[] | null {
  const still = stillOf(clip, play)
  if (!still) return null
  const spots = fieldSpots({ ...still, situation: clip?.situation ?? still.situation } as Play, answers, manId)
  return spots ? spots.map((at) => ({ x: px(at).x / IMAGE_WIDTH, y: px(at).y / IMAGE_HEIGHT, zone: true })) : null
}

/** Where these men stand in the still (picture fractions), in the order given. */
export function menAt(clip: PresnapClip | null, play: Play | null, ids: string[]): TapTarget[] {
  const still = stillOf(clip, play)
  return ids.map((id) => {
    const p = still?.players.find((m) => m.id === id)
    return p ? { x: px(p).x / IMAGE_WIDTH, y: px(p).y / IMAGE_HEIGHT } : { x: 0.5, y: 0.5 }
  })
}

/** The man drawn nearest a point in the still (picture fractions), or null. */
export function manAt(clip: PresnapClip | null, play: Play | null, at: { x: number; y: number }): Man | null {
  const still = stillOf(clip, play)
  if (!still) return null
  let best: Man | null = null
  let bestD = 0.035
  for (const p of still.players) {
    const c = px(p)
    const d = Math.hypot(c.x / IMAGE_WIDTH - at.x, (c.y / IMAGE_HEIGHT - at.y) * (IMAGE_HEIGHT / IMAGE_WIDTH))
    if (d <= bestD) {
      best = { id: p.id, label: p.label, side: p.side }
      bestD = d
    }
  }
  return best
}

/** The still as a drawable, for the man picker (the ring where it is now). */
export function drawStill(clip: PresnapClip | null, play: Play | null, manId: string | null) {
  const still = stillOf(clip, play)
  return still
    ? { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, still, options: { routes: false, motion: clip ? true : hasPresnapMotion(still), highlight: manId } }
    : null
}
