import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPlayerHistory } from '../api/grading';
import { getErrorMessage } from '../api/client';
import type { PlayerHistoryEntry } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import nb from '../styles/notebook.module.css';
import styles from './PlayerHistoryPage.module.css';

export function PlayerHistoryPage() {
  const { playerName: encodedName } = useParams<{ playerName: string }>();
  const playerName = encodedName ? decodeURIComponent(encodedName) : '';
  const [history, setHistory] = useState<PlayerHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playerName) return;
    setHistory(null);
    setError(null);
    getPlayerHistory(playerName)
      .then((data) => setHistory(data.history))
      .catch((err) => setError(getErrorMessage(err)));
  }, [playerName]);

  const totalGraded = history?.reduce((sum, h) => sum + h.graded_answer_count, 0) ?? 0;
  const totalCorrect = history?.reduce((sum, h) => sum + h.correct_answer_count, 0) ?? 0;
  const totalPending = history?.reduce((sum, h) => sum + h.pending_grading_count, 0) ?? 0;
  const accuracy = totalGraded > 0 ? Math.round((totalCorrect / totalGraded) * 100) : null;

  return (
    <div>
      <Link to="/" className={styles.backLink}>
        ← All Peiras
      </Link>

      <h1 className={nb.heading}>{playerName}</h1>
      <p className={styles.subheading}>Peira history across your whole organization</p>

      <ErrorBanner message={error} />

      {history === null ? (
        <p>Loading…</p>
      ) : history.length === 0 ? (
        <div className={`${nb.card} ${nb.empty}`}>
          No Peira history found for this name yet. Names must match exactly, including spelling and
          spacing.
        </div>
      ) : (
        <>
          <div className={nb.card} style={{ marginBottom: '1.5em' }}>
            <h3 className={nb.subheading}>
              {history.length} Peira{history.length === 1 ? '' : 's'} taken
              {accuracy !== null && <> · {accuracy}% correct overall</>}
              {totalPending > 0 && (
                <>
                  {' '}
                  <span className={`${nb.badge} ${nb.badgeWarning}`}>
                    {totalPending} answer{totalPending === 1 ? '' : 's'} pending grading
                  </span>
                </>
              )}
            </h3>
            {totalPending > 0 && (
              <p className={styles.pendingNote}>
                The overall average above doesn't include these yet - it'll shift once they're graded.
              </p>
            )}
          </div>

          <table className={nb.table}>
            <thead>
              <tr>
                <th>Peira</th>
                <th>Submitted</th>
                <th>Graded correct</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.response_id}>
                  <td>
                    <Link to={`/quizzes/${entry.quiz_id}?tab=results`}>{entry.quiz_title}</Link>
                  </td>
                  <td>{new Date(entry.submitted_at).toLocaleDateString()}</td>
                  <td className={styles.correctCell}>
                    {entry.graded_answer_count > 0
                      ? `${entry.correct_answer_count} / ${entry.graded_answer_count}`
                      : '—'}
                    {entry.pending_grading_count > 0 && (
                      <span className={`${nb.badge} ${nb.badgeWarning} ${styles.pendingBadge}`}>
                        {entry.pending_grading_count} to grade
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
