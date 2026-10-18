import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { getMotionPlay } from '../api/motionLab'
import type { TapTarget } from '../components/football/tapTargets'
import { drawStill, manAt, menSpotsAt, redrawStill, ringOn, suggestPlaces, wordsFor, type Man } from './decisionMan'
import type { Play } from './engine/play'
import { MomentPicker } from './MomentPicker'
import { drawPlay } from './playImage'
import { clipMoments, withMoment, type DecisionMoment, type PresnapClip } from './presnap'
import { playFromRow } from './storage/apiPlayRepository'
import styles from './DecisionPlay.module.css'

export interface PlayDraft {
  clip: PresnapClip | null
  man: { id: string; label: string | null } | null
  role: string | null
  targets: TapTarget[] | null
  /** The man changed: the still, redrawn with his ring, to upload on save. */
  image: File | null
  /** The spots are PEIRA's suggestion: the coach confirms them before they are saved. */
  spotsSuggested?: boolean
}

/**
 * THE PLAY SIDE OF A DECISION, before players have it: WHICH MAN it tests
 * (tap him in the picture - the ring, the words and the picture all follow)
 * and WHEN the player decides (the same Decide at and Preview as Make rep).
 * Loaded only when a coach edits a decision that came from a play.
 */
export default function DecisionPlay({
  draft,
  onChange,
  playId,
  canOpenPlay,
  answers,
  firstMan,
}: {
  draft: PlayDraft
  onChange: (next: PlayDraft) => void
  playId: number | null
  /** Motion Lab is open to this coach, so the play itself can be read. */
  canOpenPlay: boolean
  answers: string[]
  /** The man the decision tested when editing began - "the man changed" is against him. */
  firstMan: string | null
}) {
  const [play, setPlay] = useState<Play | null>(null)
  const [picking, setPicking] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)

  // The play itself, when the coach can open it: a still decision's men, and
  // the beat after the snap for a motion decision.
  useEffect(() => {
    if (!canOpenPlay || playId === null) return
    let gone = false
    getMotionPlay(playId)
      .then((row) => !gone && setPlay(playFromRow(row)))
      .catch(() => undefined)
    return () => {
      gone = true
    }
  }, [canOpenPlay, playId])

  const still = useMemo(() => drawStill(draft.clip, play, draft.man?.id ?? null), [draft.clip, play, draft.man])

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!picking || !ctx || !still) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    drawPlay(ctx, still.still, still.options)
  }, [picking, still])

  const pick = (e: MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const man: Man | null = manAt(draft.clip, play, {
      x: (e.clientX - box.left) / box.width,
      y: (e.clientY - box.top) / box.height,
    })
    if (!man || man.id === draft.man?.id) return
    const clip = draft.clip ? ringOn(draft.clip, man.id) : null
    const next = { ...draft, man: { id: man.id, label: man.label }, role: wordsFor(man), clip }
    onChange({ ...next, image: draft.image })
    setPicking(false)
    // The still follows the ring: redrawn now, uploaded when he saves.
    void redrawStill(draft.clip, play, man.id)
      .then((image) => image && onChange({ ...next, image }))
      .catch(() => undefined)
  }

  /* SUGGEST SPOTS AGAIN - offered once the man has changed and the decision
     is answered by places: PEIRA's geometry for HIM, replacing the spots only
     because the coach asked, and still his to confirm. */
  const suggested = useMemo(
    () => (draft.man && draft.targets?.some((t) => t.zone) ? suggestPlaces(draft.clip, play, answers, draft.man.id) : null),
    [draft.man, draft.targets, draft.clip, play, answers],
  )
  const manChanged = !!draft.man && draft.man.id !== firstMan

  const moment: DecisionMoment = draft.clip?.freeze ?? 'snap'
  const setMoment = (m: DecisionMoment) => {
    if (!draft.clip) return
    const clip = withMoment(draft.clip, m, play)
    if (!clip) return
    // "Tap the man" spots move with the men; places stay where the coach put them.
    const men = draft.targets && !draft.targets.some((t) => t.zone) ? menSpotsAt(clip, answers) : null
    onChange({ ...draft, clip, targets: men ?? draft.targets })
  }

  return (
    <div className={styles.play}>
      {still && (
        <div className={styles.man}>
          <span>
            Testing the <strong>{draft.man?.label ?? 'nobody yet'}</strong>
            {draft.role ? ` - "${draft.role}"` : ''}
          </span>
          <button type="button" className={styles.link} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            {picking ? 'Keep him' : 'Change man'}
          </button>
        </div>
      )}
      {picking && still && (
        <>
          <span className={styles.hint}>Tap the man to test - his ring, his name and the picture follow.</span>
          <canvas
            ref={canvas}
            className={styles.pick}
            width={still.width}
            height={still.height}
            aria-label="Tap the man to test"
            onClick={pick}
          />
        </>
      )}
      {manChanged && suggested && suggested.length === draft.targets?.length && (
        <div className={styles.man}>
          <span className={styles.hint}>His spots are where you put them for the last man.</span>
          <button
            type="button"
            className={styles.link}
            onClick={() => onChange({ ...draft, targets: suggested, spotsSuggested: true })}
          >
            Suggest spots for the {draft.man?.label} again
          </button>
        </div>
      )}
      {draft.clip && <MomentPicker moments={clipMoments(draft.clip, play)} value={moment} onChange={setMoment} clip={draft.clip} />}
    </div>
  )
}
