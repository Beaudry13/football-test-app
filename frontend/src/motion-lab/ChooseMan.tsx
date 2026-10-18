import { useMemo, useState } from 'react'
import { PlayPicture } from '../components/football/PlayPicture'
import { drawStill, menAt } from './decisionMan'
import { drawPlay } from './playImage'
import { retargetOne, type Choice, type Retarget } from './retargetRep'
import styles from './ChooseMan.module.css'

/**
 * TWO CBs - WHICH ONE? A decision whose play has more than one man with the
 * label the coach asked for: its field, a ring on each of them, tap the one
 * he means. The same rings a player taps (TapOverlay). Never guessed.
 */
export default function ChooseMan({ choice, label, onChosen }: { choice: Choice; label: string; onChosen: (r: Retarget) => void }) {
  const [busy, setBusy] = useState(false)
  const still = useMemo(
    () => drawStill(choice.clip, choice.play, choice.decision.subject_man?.id ?? null),
    [choice.clip, choice.play, choice.decision.subject_man],
  )
  const targets = useMemo(
    () => menAt(choice.clip, choice.play, choice.candidates.map((m) => m.id)),
    [choice.clip, choice.play, choice.candidates],
  )
  if (!still) return null
  // "CB, left" / "CB, right": a name for each, by where he stands.
  const options = choice.candidates.map((m, i) => ({
    id: i,
    option_text: `${m.label}, ${targets[i].x < 0.5 ? 'left' : 'right'}${choice.candidates.length > 2 ? ` ${i + 1}` : ''}`,
  }))
  return (
    <div className={styles.choose} role="group" aria-label={`Decision ${choice.decision.number}: which ${label}?`}>
      <span className={styles.ask}>
        Decision {choice.decision.number} has {choice.candidates.length} {label}s - tap the one you mean.
      </span>
      <PlayPicture
        drawn={{ width: still.width, height: still.height, draw: (ctx) => drawPlay(ctx, still.still, still.options) }}
        targets={targets}
        options={options}
        disabled={busy}
        onTap={async (i) => {
          setBusy(true)
          onChosen(await retargetOne(choice.decision, choice.candidates[i], choice.clip, choice.play))
        }}
      />
    </div>
  )
}
