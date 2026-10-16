import type { Audience, Family } from './audiences';
import styles from './PositionChips.module.css';

/**
 * WHO, FROM THE ROSTER: one chip per position family ("Safeties FS, S, SS · 11")
 * or lone position, the players' own roster positions behind it - so nothing
 * is hidden behind a name. The family a Rep's "You're the..." points at is
 * marked "suggested". The same chips send a Rep and activate a quiz.
 */
export function PositionChips({
  audiences,
  chosen,
  onChange,
  likely = null,
  className,
}: {
  audiences: Audience[];
  chosen: string[];
  onChange: (keys: string[]) => void;
  likely?: Family | null;
  className?: string;
}) {
  if (audiences.length === 0) return null;
  return (
    <div className={className ? `${styles.chips} ${className}` : styles.chips} role="group" aria-label="Positions">
      {audiences.map((a) => {
        const on = chosen.includes(a.key);
        return (
          <button
            key={a.key}
            type="button"
            aria-pressed={on}
            className={on ? `${styles.chip} ${styles.on}` : styles.chip}
            onClick={() => onChange(on ? chosen.filter((k) => k !== a.key) : [...chosen, a.key])}
          >
            {a.name}
            {a.family && <span className={styles.count}> {a.positions.join(', ')}</span>}
            <span className={styles.count}> · {a.playerIds.length}</span>
            {a.family && a.family === likely && <span className={styles.suggested}>suggested</span>}
          </button>
        );
      })}
    </div>
  );
}
