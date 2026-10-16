import { lazy, Suspense, useState } from 'react'
import { MOMENT_LABEL, type DecisionMoment, type PresnapClip } from './presnap'
import styles from './MomentPicker.module.css'

const PresnapPicture = lazy(() => import('./PresnapPicture'))

/** What the player sees before he decides, in a coach's words. */
const MOMENT_NOTE: Record<DecisionMoment, string> = {
  before: 'Players see the alignment and decide before anyone moves.',
  mid: 'Players watch the motion and decide halfway through it.',
  snap: 'Players watch the motion, then decide at the snap.',
  after: 'Players watch the motion and the snap, then decide a beat after it.',
}

/**
 * WHEN THE PLAYER DECIDES: one row of choices from the moments this play's
 * authored movement actually has, snap first by default - and a Preview that
 * plays exactly what the player will see, up to the freeze.
 */
export function MomentPicker({
  moments,
  value,
  onChange,
  clip,
}: {
  moments: DecisionMoment[]
  value: DecisionMoment
  onChange: (moment: DecisionMoment) => void
  clip: PresnapClip | null
}) {
  const [previewing, setPreviewing] = useState(false)
  if (moments.length === 0 || !clip) return null
  return (
    <div className={styles.picker}>
      <div className={styles.row} role="radiogroup" aria-label="Decide at">
        <span className={styles.lead}>Decide at</span>
        {moments.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            className={value === m ? `${styles.moment} ${styles.on}` : styles.moment}
            onClick={() => {
              onChange(m)
              setPreviewing(false)
            }}
          >
            {MOMENT_LABEL[m]}
          </button>
        ))}
        <button type="button" className={styles.preview} aria-pressed={previewing} onClick={() => setPreviewing((p) => !p)}>
          {previewing ? 'Hide preview' : '▶ Preview'}
        </button>
      </div>
      <div className={styles.note}>{MOMENT_NOTE[value]}</div>
      {previewing && (
        <Suspense fallback={null}>
          <PresnapPicture key={`${value}`} clip={clip} />
        </Suspense>
      )}
    </div>
  )
}
