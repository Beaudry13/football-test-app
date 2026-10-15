import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRepsSummary, type RepSummary } from '../../api/reps';
import nb from '../../styles/notebook.module.css';
import styles from './RepsHomeCard.module.css';

/**
 * SITUATIONAL REPS ON HOME: the next useful action, said in football.
 *
 * Each recent Rep is one line - how many have run it - and, when anyone
 * missed anything, its worst problem: "MOTION ADJUSTMENT 4 of 11 missed ·
 * most chose 'Stay boundary'". One tap opens the Rep, where View players,
 * Teach and Retest are. With no Reps yet, the one thing to do: make one.
 */
export function RepsHomeCard() {
  const [reps, setReps] = useState<RepSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRepsSummary()
      .then((list) => !cancelled && setReps(list))
      // Home does not fail over Reps: no summary, no card.
      .catch(() => !cancelled && setReps(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (reps === null) return null;

  return (
    <section className={styles.card} aria-label="Reps">
      <div className={styles.head}>
        <h2 className={styles.title}>Reps</h2>
        <Link to="/reps" className={styles.all}>
          All reps
        </Link>
      </div>
      {reps.length === 0 ? (
        <div className={styles.empty}>
          <span>Put a player in a play. See who knows his job.</span>
          <Link to="/motion-lab" className={nb.btnPrimary}>
            Make a rep
          </Link>
        </div>
      ) : (
        <ul className={styles.list}>
          {reps.map((rep) => {
            const who = rep.audience_label ? rep.audience_label.toLowerCase() : 'players';
            return (
              <li key={rep.id}>
                <Link to={`/reps/${rep.id}`} className={rep.worst ? `${styles.row} ${styles.hurting}` : styles.row}>
                  <span className={styles.repTitle}>
                    {rep.title}
                    <span className={styles.meta}>
                      {rep.live ? ' · out now' : ''} · {rep.ran} of {rep.invited} ran it
                    </span>
                  </span>
                  {rep.worst ? (
                    <span className={styles.problem}>
                      <strong className={styles.problemName}>{rep.worst.name}</strong> {rep.worst.missed} of{' '}
                      {rep.worst.responded} {who} missed
                      {rep.worst.most_common_wrong ? ` · most chose “${rep.worst.most_common_wrong}”` : ''}
                    </span>
                  ) : rep.ran > 0 ? (
                    <span className={styles.clean}>Nobody missed a decision</span>
                  ) : (
                    <span className={styles.waiting}>{rep.live ? 'Waiting on players' : 'Not sent yet'}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
