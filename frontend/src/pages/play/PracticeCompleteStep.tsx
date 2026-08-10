import type { PracticeFeedback } from '../../api/types';
import { Icon } from '../../components/ui/Icon';
import { summarisePractice } from './practiceSummary';
import styles from './PlayPage.module.css';

/** The end of a practice run.
 *
 * Deliberately NOT SubmittedStep. That screen fetches the player's official
 * results and offers a bookmarkable results link - both meaningless here,
 * because a practice attempt never becomes a result a coach reviews. Reusing
 * it would have shown a player a "your results" page for work that is not in
 * their results, which is precisely the confusion Practice Mode has to avoid.
 */
export function PracticeCompleteStep({
  feedback,
  onTryAgain,
}: {
  feedback: PracticeFeedback[];
  onTryAgain: () => void;
}) {
  const summary = summarisePractice(feedback);

  return (
    <div className={styles.practiceComplete}>
      <div className={styles.celebrationBadge}>
        <Icon name="check" size={30} strokeWidth={3} />
      </div>
      <h1>Practice complete</h1>

      {summary.percent !== null ? (
        <p className={styles.practiceScore}>
          <strong>
            {summary.correct} of {summary.scored}
          </strong>{' '}
          correct
        </p>
      ) : (
        // Nothing here was auto-scored, so there is no score to show. Saying
        // "0%" would be a verdict nobody gave.
        <p className={styles.practiceScore}>Your answers were recorded.</p>
      )}

      {summary.awaitingCoach > 0 && (
        <p className={styles.practiceNote}>
          {summary.awaitingCoach}{' '}
          {summary.awaitingCoach === 1 ? 'question needs' : 'questions need'} your coach&rsquo;s
          review.
        </p>
      )}

      <p className={styles.practiceNote}>
        This was practice &mdash; none of it counts toward your grades.
      </p>

      <button type="button" className="btn btn-primary" onClick={onTryAgain}>
        Try again
      </button>
    </div>
  );
}
