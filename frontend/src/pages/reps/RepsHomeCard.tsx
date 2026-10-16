import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRepsSummary, type RepSummary } from '../../api/reps';
import nb from '../../styles/notebook.module.css';
import { pluralFor } from './audiences';
import { ConceptTrends } from './ConceptTrends';
import styles from './RepsHomeCard.module.css';

/**
 * SITUATIONAL REPS ON HOME: the next useful action, said in football.
 *
 * Each recent Rep is one line - how many have run it - and, when anyone
 * missed anything, its worst problem: "MOTION ADJUSTMENT 4 of 11 missed ·
 * most chose 'Stay boundary'". One tap opens the Rep, where View players,
 * Teach and Retest are. With no Reps yet, the one thing to do: make one.
 */
/** "Red zone check - still missed by 2 after the retest · 63% -> 80%". */
function Signal({ signal }: { signal: NonNullable<RepSummary['signal']> }) {
  const change =
    signal.before_pct !== null && signal.now_pct !== null && signal.responded > 0 ? (
      <span className={styles.change}>
        {' '}
        · {signal.before_pct}% → {signal.now_pct}%
      </span>
    ) : null;
  const fixed = signal.kind === 'retest_fixed' || (signal.kind === 'retested' && signal.responded > 0 && signal.missed === 0);
  if (fixed) {
    return (
      <span className={styles.clean}>
        ✓ <strong className={styles.problemName}>{signal.concept}</strong> fixed on the retest{change}
      </span>
    );
  }
  if (signal.kind === 'retested' && signal.responded === 0) {
    return (
      <span className={styles.problem}>
        <strong className={styles.problemName}>{signal.concept}</strong> retest is out - nobody has run it yet
      </span>
    );
  }
  return (
    <span className={styles.problem}>
      <strong className={styles.problemName}>{signal.concept}</strong> still missed by {signal.missed} of {signal.responded} after
      the retest{change}
    </span>
  );
}

export function RepsHomeCard({ inviteWhenEmpty = true }: { inviteWhenEmpty?: boolean }) {
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
  if (reps.length === 0 && !inviteWhenEmpty) return null;

  /* NEXT UP: the one football problem to deal with now - a miss nobody has
     retested yet, else a retest that still has misses. */
  const fresh = reps.find((r) => r.open_problem);
  const lingering = fresh ? null : reps.find((r) => r.signal?.kind === 'retest_missing');

  return (
    <section className={styles.card} aria-label="Reps">
      <div className={styles.head}>
        <h2 className={styles.title}>Reps</h2>
        <Link to="/reps" className={styles.all}>
          All reps
        </Link>
      </div>
      {fresh?.open_problem && (
        <div className={styles.nextUp} aria-label="Next up">
          <span className={styles.nextLead}>Next up</span>
          <span className={styles.nextProblem}>
            <strong className={styles.problemName}>{fresh.open_problem.name}</strong> {fresh.open_problem.missed} of{' '}
            {fresh.open_problem.responded}{' '}
            {fresh.audience_label
              ? fresh.audience_label.toLowerCase()
              : (pluralFor(fresh.audience_positions ?? []) ?? 'players')}{' '}
            missed{fresh.open_problem.taught ? ' · taught' : ''}
          </span>
          <span className={styles.nextActions}>
            {/* Taught already (by anyone): the next step is Retest, on the Rep page. */}
            {fresh.open_problem.taught ? (
              <Link to={`/reps/${fresh.id}`} className={nb.btnPrimary}>
                Retest it
              </Link>
            ) : (
              <Link to={`/reps/${fresh.id}?teach=${fresh.open_problem.concept_id ?? 'general'}`} className={nb.btnPrimary}>
                Teach it
              </Link>
            )}
          </span>
        </div>
      )}
      {lingering?.signal && (
        <div className={styles.nextUp} aria-label="Next up">
          <span className={styles.nextLead}>Next up</span>
          <span className={styles.nextProblem}>
            <strong className={styles.problemName}>{lingering.signal.concept}</strong> still missed by {lingering.signal.missed} after the
            retest
          </span>
          <span className={styles.nextActions}>
            <Link to={`/reps/${lingering.id}`} className={nb.btnPrimary}>
              Open it
            </Link>
          </span>
        </div>
      )}
      {reps.length > 0 && <ConceptTrends limit={3} />}
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
            const who = rep.audience_label
              ? rep.audience_label.toLowerCase()
              : (pluralFor(rep.audience_positions ?? []) ?? 'players');
            return (
              <li key={rep.id}>
                <Link to={`/reps/${rep.id}`} className={rep.worst ? `${styles.row} ${styles.hurting}` : styles.row}>
                  <span className={styles.repTitle}>
                    {rep.title}
                    <span className={styles.meta}>
                      {rep.live ? ' · out now' : ''} · {rep.ran} of {rep.invited} ran it
                    </span>
                  </span>
                  {rep.signal ? (
                    <Signal signal={rep.signal} />
                  ) : rep.worst ? (
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
