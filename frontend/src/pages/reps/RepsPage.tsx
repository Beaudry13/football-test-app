import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { listQuizzes } from '../../api/quizzes';
import type { Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import styles from './RepsPage.module.css';

/**
 * EVERY SITUATIONAL REP - newest first, each one tap from its football
 * problems. Making one starts in Motion Lab ("Make rep"), or from a quiz
 * ("Make a rep" in the quiz editor).
 */
export function RepsPage() {
  useDocumentTitle('Reps');
  const motionLab = useMayUseMotionLab();
  const [reps, setReps] = useState<Quiz[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listQuizzes()
      .then((list) => setReps(list.filter((q) => q.kind === 'REP').sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  return (
    <div>
      <header className={styles.head}>
        <div>
          <h1 className={nb.heading}>Reps</h1>
          <p className={styles.tag}>Put them in the play. See who knows their job.</p>
        </div>
        {motionLab && (
          <Link to="/motion-lab" className={`${nb.btnPrimary} ${styles.linkButton}`}>
            Make a rep in Motion Lab
          </Link>
        )}
      </header>
      <ErrorBanner message={error} />
      {reps === null && !error && <LoadingState />}
      {reps?.length === 0 && (
        <p className={styles.empty}>
          No reps yet. Open a play in Motion Lab, tap <strong>Make rep</strong>, tap the man you want to test, and ask
          him his job.
        </p>
      )}
      <ul className={styles.list}>
        {(reps ?? []).map((rep) => (
          <li key={rep.id}>
            <Link to={`/reps/${rep.id}`} className={styles.row}>
              <span className={styles.title}>{rep.title}</span>
              <span className={styles.meta}>
                {rep.question_count} {rep.question_count === 1 ? 'decision' : 'decisions'}
                {rep.is_active ? ' · out now' : ''}
                {rep.retest_of ? ' · retest' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
