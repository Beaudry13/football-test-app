import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listMotionPlays } from '../api/motionLab'
import { useAuth } from '../auth/AuthContext'
import type { Play } from './engine/play'
import { PlayThumb } from './PlayThumb'
import { peekScratch, playFromRow } from './storage/apiPlayRepository'
import nb from '../styles/notebook.module.css'
import styles from './MotionLabHomeCard.module.css'

/** How many saved plays Home shows. The Library has the rest. */
export const HOME_PLAYS = 4

/**
 * MOTION LAB ON HOME - one card, for coaches who have Motion Lab.
 *
 * Home is where a coach lands, so the way onto the field starts here: "Draw a
 * play" opens Motion Lab on the field (nothing is created until he saves). An
 * unsaved play on this device comes back with one click ("Continue"), and his
 * latest saved plays sit underneath as pictures, each one click from the
 * editor. Everything else - folders, every play - is the Library's.
 *
 * Nothing here writes. Loaded only for coaches with Motion Lab (see
 * DashboardPage), so other coaches never download the play picture code.
 */
export default function MotionLabHomeCard() {
  const { coach } = useAuth()
  const unsaved = coach ? peekScratch(`${coach.organization_id}:${coach.id}`) : null
  const [recent, setRecent] = useState<{ id: number; play: Play }[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listMotionPlays(HOME_PLAYS)
      .then((rows) => {
        if (cancelled) return
        const plays = [...rows]
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
          .slice(0, HOME_PLAYS)
          .flatMap((row) => {
            const play = playFromRow(row)
            return play ? [{ id: row.id, play }] : []
          })
        setRecent(plays)
      })
      // Home does not fail over Motion Lab: no list, no pictures, the buttons still work.
      .catch(() => !cancelled && setRecent([]))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className={styles.card} aria-label="Motion Lab">
      <div className={styles.head}>
        <h2 className={styles.title}>Motion Lab</h2>
        <Link to="/motion-lab/library" className={styles.libraryLink}>
          All plays
        </Link>
      </div>

      <div className={styles.actions}>
        {unsaved ? (
          <>
            <Link to="/motion-lab" className={nb.btnSecondary}>
              Continue “{unsaved.name}”
            </Link>
            <span className={styles.unsavedTag}>not saved</span>
            <Link to="/motion-lab" state={{ fresh: true }} className={nb.btnSecondary}>
              + New play
            </Link>
          </>
        ) : (
          /* Secondary on Home: Next up (above) holds the one gold action. */
          <Link to="/motion-lab" className={nb.btnSecondary}>
            Draw a play
          </Link>
        )}
      </div>

      {recent && recent.length > 0 && (
        <ul className={styles.plays} aria-label="Recent plays">
          {recent.map(({ id, play }) => (
            <li key={id}>
              <Link to={`/motion-lab/plays/${id}`} className={styles.play}>
                <PlayThumb play={play} width={160} height={84} className={styles.thumb} />
                <span className={styles.playName}>{play.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {recent?.length === 0 && !unsaved && <p className={styles.hint}>Draw a formation, give it routes, then turn it into a quiz question.</p>}
    </section>
  )
}
