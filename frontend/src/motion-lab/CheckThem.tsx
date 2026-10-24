import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { MadeFromPlay } from '../api/reps'
import styles from './CheckThem.module.css'

/**
 * TEACH -> CHECK THEM, from the play on the screen: what is already made from
 * it first (open the Rep or the quiz), then the two ways to make the check
 * from this same football - a Rep with him in it, or a quiz question (Draw
 * his job: his authored route becomes the answer). Making one leaves Teach for
 * the panel that makes it, the man already chosen.
 */
export function CheckThem({
  made,
  who,
  onMake,
  linkState = null,
}: {
  made: MadeFromPlay[]
  /** The man being taught ("Boundary safety"), when there is one. */
  who: string | null
  onMake: (kind: 'rep' | 'question') => void
  /** The way back here for the Rep or quiz it opens (navigation/backTo). */
  linkState?: object | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className={styles.wrap}>
      <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        Check them ▾
      </button>
      {open && (
        <span className={styles.menu} role="menu" aria-label="Check them">
          {made.length > 0 && (
            <>
              <span className={styles.head}>Made from this play</span>
              {made.slice(0, 3).map((m) => (
                <Link
                  key={m.id}
                  role="menuitem"
                  className={styles.item}
                  to={m.kind === 'REP' ? `/reps/${m.id}` : `/quizzes/${m.id}`}
                  state={linkState}
                >
                  <span className={styles.kind}>{m.kind === 'REP' ? 'Rep' : 'Quiz'}</span> {m.title}
                </Link>
              ))}
              <span className={styles.head}>Or make the check</span>
            </>
          )}
          <button type="button" role="menuitem" className={styles.item} onClick={() => onMake('rep')}>
            Make a rep <span className={styles.why}>{who ? `put the ${who} in it` : 'put a player in it'}</span>
          </button>
          <button type="button" role="menuitem" className={styles.item} onClick={() => onMake('question')}>
            Make a quiz question <span className={styles.why}>{who ? `draw his job - his route is the answer` : 'draw your job, or who gets the ball'}</span>
          </button>
        </span>
      )}
    </span>
  )
}
