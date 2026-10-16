import { useEffect, useState } from 'react'
import { getErrorMessage } from '../api/client'
import { listMotionPlays } from '../api/motionLab'
import type { QuestionInput } from '../api/questions'
import type { Play } from './engine/play'
import { PlayThumb } from './PlayThumb'
import { ballChoices, playImageFile, playQuestionInput, SHOWS_ROUTES, type PlayQuestionKind } from './playQuestion'
import { hasPresnapMotion, presnapOf } from './presnap'
import { playFromRow } from './storage/apiPlayRepository'
import styles from './MotionLabPlayPicker.module.css'

/**
 * QUIZ -> MOTION LAB: add a question to this quiz from one of the coach's
 * saved Motion Lab plays. Each play is shown as a small diagram with the
 * questions it can become ("Draw your assignment"; "Who gets the ball?" when
 * the play gives someone the ball) - one click adds it, picture and all,
 * through the quiz editor's own create path. Built by the same builder as
 * Motion Lab's "Make question" (playQuestion.ts), with its defaults: a play
 * with pre-snap motion plays it and the player decides at the snap (a Draw
 * question); "Who gets the ball?" is a still with the routes.
 */
export default function MotionLabPlayPicker({ onPick, onClose }: { onPick: (input: QuestionInput, image: File) => Promise<void>; onClose: () => void }) {
  const [plays, setPlays] = useState<{ play: Play; serverId: number }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    listMotionPlays()
      .then((rows) =>
        setPlays(
          rows
            .map((row) => ({ play: playFromRow(row), serverId: row.id }))
            .filter((r): r is { play: Play; serverId: number } => !!r.play)
            .sort((a, b) => b.play.updatedAt - a.play.updatedAt),
        ),
      )
      .catch((err) => setError(getErrorMessage(err)))
  }, [])

  const pick = async (play: Play, serverId: number, kind: PlayQuestionKind) => {
    setBusy(`${play.id}:${kind}`)
    setError(null)
    try {
      const presnap = SHOWS_ROUTES[kind] ? null : presnapOf(play, null)
      await onPick(
        { ...playQuestionInput(play, kind), motion_play_id: serverId, ...(presnap ? { presnap } : {}) },
        await playImageFile(play, SHOWS_ROUTES[kind], null, presnap),
      )
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
        {(plays ?? []).map(({ play, serverId }) => (
          <li key={play.id} className={styles.row}>
            <PlayThumb play={play} width={172} height={90} className={styles.thumb} />
            <div className={styles.body}>
              <span className={styles.name}>
                {play.name}
                {hasPresnapMotion(play) && <span className={styles.motionTag}> · motion plays</span>}
              </span>
              <div className={styles.actions}>
                <button className={styles.action} disabled={busy !== null} onClick={() => void pick(play, serverId, 'draw')} aria-label={`Draw your assignment: ${play.name}`}>
                  {busy === `${play.id}:draw` ? 'Adding…' : 'Draw your assignment'}
                </button>
                {ballChoices(play) && (
                  <button className={styles.action} disabled={busy !== null} onClick={() => void pick(play, serverId, 'ball')} aria-label={`Who gets the ball: ${play.name}`}>
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
