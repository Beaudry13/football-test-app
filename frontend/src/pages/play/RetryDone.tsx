import { Link } from 'react-router-dom';
import { Icon } from '../../components/ui/Icon';
import styles from './PlayPage.module.css';

/**
 * TRY THE MISSES AGAIN, WITH NOTHING LEFT TO TRY. He asked for his misses, so
 * PEIRA never quietly hands him a different task: it says so, and the full
 * practice is his to choose - quietly - not something that starts on its own.
 *
 *   fixed        the server found no misses left to retry
 *   unavailable  the run can no longer be retried from here
 */
export function RetryDone({
  reason,
  onRunFull,
  isRep = false,
}: {
  reason: 'fixed' | 'unavailable';
  onRunFull: () => void;
  isRep?: boolean;
}) {
  return (
    <div className={styles.practiceComplete}>
      {reason === 'fixed' && (
        <div className={styles.celebrationBadge}>
          <Icon name="check" size={30} strokeWidth={3} />
        </div>
      )}
      <h1>{reason === 'fixed' ? 'You fixed them all.' : "This one can't be tried again now."}</h1>
      <Link to="/play" className="btn btn-primary">
        Done
      </Link>
      <button type="button" className={styles.quietAction} onClick={onRunFull}>
        {isRep ? 'Run the whole rep again' : 'Start the whole quiz over'}
      </button>
    </div>
  );
}
