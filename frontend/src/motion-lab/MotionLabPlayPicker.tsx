import { useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '../api/client'
import { listMotionPlays } from '../api/motionLab'
import type { QuestionInput } from '../api/questions'
import type { Play } from './engine/play'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { ballChoices, playImageFile, playQuestionInput, SHOWS_ROUTES, type PlayQuestionKind } from './playQuestion'
import { playFromRow } from './storage/apiPlayRepository'
import styles from './MotionLabPlayPicker.module.css'

/**
 * QUIZ -> MOTION LAB: add a question to this quiz from one of the coach's
 * saved Motion Lab plays. Each play is shown as a small diagram with the
 * questions it can become ("Draw your assignment"; "Who gets the ball?" when
 * the play gives someone the ball) - one click adds it, picture and all,
 * through the quiz editor's own create path. Built by the same builder as
 * Motion Lab's "Make question" (playQuestion.ts).
 */
export default function MotionLabPlayPicker({ onPick, onClose }: { onPick: (input: QuestionInput, image: File) => Promise<void>; onClose: () => void }) {
  const [plays, setPlays] = useState<Play[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    listMotionPlays()
      .then((rows) => setPlays(rows.map(playFromRow).filter((p): p is Play => !!p).sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((err) => setError(getErrorMessage(err)))
  }, [])

  const pick = async (play: Play, kind: PlayQuestionKind) => {
    setBusy(`${play.id}:${kind}`)
    setError(null)
    try {
      await onPick(playQuestionInput(play, kind), await playImageFile(play, SHOWS_ROUTES[kind]))
    } catch (err) {
      setError(getErrorMessage(err))
      setBusy(null)
    }
  }

  return (
    <div className={styles.picker}>
      <h2 className={styles.title}>Add a question from Motion Lab</h2>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {plays === null && !error && <p className={styles.hint}>Loading your plays…</p>}
      {plays?.length === 0 && <p className={styles.hint}>No saved Motion Lab plays yet. Draw one in Motion Lab and save it.</p>}
      <ul className={styles.list} aria-label="Motion Lab plays">
        {(plays ?? []).map((play) => (
          <li key={play.id} className={styles.row}>
            <Thumb play={play} />
            <div className={styles.body}>
              <span className={styles.name}>{play.name}</span>
              <div className={styles.actions}>
                <button className={styles.action} disabled={busy !== null} onClick={() => void pick(play, 'draw')} aria-label={`Draw your assignment: ${play.name}`}>
                  {busy === `${play.id}:draw` ? 'Adding…' : 'Draw your assignment'}
                </button>
                {ballChoices(play) && (
                  <button className={styles.action} disabled={busy !== null} onClick={() => void pick(play, 'ball')} aria-label={`Who gets the ball: ${play.name}`}>
                    {busy === `${play.id}:ball` ? 'Adding…' : 'Who gets the ball?'}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className={styles.foot}>
        <button className={styles.cancel} onClick={onClose} disabled={busy !== null}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The play, small: what the coach recognises before the name. */
function Thumb({ play }: { play: Play }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ref.current!.width / IMAGE_WIDTH, 0, 0, ref.current!.height / IMAGE_HEIGHT, 0, 0)
    drawPlay(ctx, play, { routes: true })
  }, [play])
  return <canvas ref={ref} className={styles.thumb} width={172} height={90} aria-hidden="true" />
}
