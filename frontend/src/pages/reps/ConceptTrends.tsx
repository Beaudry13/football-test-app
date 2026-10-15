import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConceptTrends, type ConceptTrend } from '../../api/reps';
import styles from './ConceptTrends.module.css';

/**
 * IS IT GETTING BETTER? One line per football problem, across the Reps that
 * tested it: "Motion adjustment 64% -> 82% - 3 reps", or "still missed by 2".
 * First tries only, as everywhere in Reps. A glance - each line opens the
 * latest Rep that tested it.
 */
export function ConceptTrends({ limit = 5 }: { limit?: number }) {
  const [trends, setTrends] = useState<ConceptTrend[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConceptTrends()
      .then((list) => !cancelled && setTrends(list))
      .catch(() => !cancelled && setTrends([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!trends || trends.length === 0) return null;

  return (
    <section className={styles.trends} aria-label="Concept trends">
      <h2 className={styles.title}>How the football problems are going</h2>
      <ul className={styles.list}>
        {trends.slice(0, limit).map((t) => {
          const up = t.reps > 1 && t.last_pct !== null && t.first_pct !== null && t.last_pct > t.first_pct;
          const down = t.reps > 1 && t.last_pct !== null && t.first_pct !== null && t.last_pct < t.first_pct;
          return (
            <li key={t.concept_id}>
              <Link to={`/reps/${t.last_rep_id}`} className={styles.row}>
                <span className={styles.name}>{t.name}</span>
                <span className={up ? styles.up : down ? styles.down : styles.flat}>
                  {t.reps > 1 ? `${t.first_pct}% → ${t.last_pct}%` : `${t.last_pct}%`}
                </span>
                <span className={styles.meta}>
                  {t.reps} {t.reps === 1 ? 'rep' : 'reps'}
                </span>
                {t.last_missed > 0 && <span className={styles.missed}>still missed by {t.last_missed}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
