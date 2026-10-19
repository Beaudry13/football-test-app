import { Link } from 'react-router-dom';
import type { RetestSummary } from '../../api/types';
import styles from './MissActions.module.css';

/**
 * DID IT STICK? - on the ORIGINAL's Results, beside the concept or question a
 * retest re-asked: how the players it went to did this time, in the retest
 * card's own careful words (answered correctly this time; still missed; not
 * answered yet - never folded into a miss), and the retest one tap away.
 */
export function RetestStatus({ retest }: { retest: RetestSummary }) {
  const waiting = retest.not_submitted_count + retest.ungraded_count;
  return (
    <span className={styles.retest}>
      <span className={styles.retestLead}>Retest:</span>{' '}
      {retest.correct_count + retest.incorrect_count === 0 ? (
        <>sent to {retest.targeted_total} - nobody has answered yet</>
      ) : (
        <>
          <strong>{retest.correct_count}</strong> of {retest.targeted_total} answered correctly this time
          {retest.incorrect_count > 0 && (
            <>
              {' · '}
              <span className={styles.retestStill}>{retest.incorrect_count} still missed</span>
            </>
          )}
          {waiting > 0 && <> · {waiting} still to come</>}
        </>
      )}{' '}
      <Link to={`/quizzes/${retest.quiz_id}?tab=results`} className={styles.retestLink}>
        Open retest
      </Link>
    </span>
  );
}
